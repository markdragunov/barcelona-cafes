"""Location detection, Google Geocoding, and 1 km cafe radius filter."""

from __future__ import annotations

import json
import math
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from openai import OpenAI

from .neighborhoods import find_neighborhood
from .paths import CHAT_MODEL
from .stores.factory import get_repository

RADIUS_KM = 1.0
LOCATION_PROMPT = """Extract a location reference from the user query about Barcelona coffee shops.

Return JSON only:
{
  "location": string or null,
  "location_type": "street" | "landmark" | "neighborhood" | "area" | null
}

Rules:
- location should be a geocodable place string (street, landmark, or neighborhood).
- If the query has no location reference, set location to null.
- Do not invent a location. City-only mentions like "Barcelona" alone are NOT a specific location — return null unless a more specific place is also present.
- Keep location concise (e.g. "Gràcia", "Sagrada Familia", "Carrer de Pau Claris")."""


def extract_location(client: OpenAI, query: str) -> dict[str, Any] | None:
    resp = client.chat.completions.create(
        model=CHAT_MODEL,
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": LOCATION_PROMPT},
            {"role": "user", "content": query},
        ],
    )
    raw = (resp.choices[0].message.content or "").strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None

    location = data.get("location")
    if not isinstance(location, str):
        return None
    location = location.strip()
    if not location:
        return None

    # Treat bare city as no specific location filter.
    if location.lower() in {"barcelona", "bcn", "barna"}:
        return None

    location_type = data.get("location_type")
    if location_type not in {"street", "landmark", "neighborhood", "area"}:
        location_type = None

    return {"location": location, "location_type": location_type}


def geocode_location(google_api_key: str, location: str) -> dict[str, Any]:
    if not google_api_key:
        raise RuntimeError("Google Geocoding API key is required for location search")

    address = location
    if "barcelona" not in location.lower():
        address = f"{location}, Barcelona, Spain"

    params = urllib.parse.urlencode(
        {
            "address": address,
            "key": google_api_key,
            "region": "es",
            "language": "en",
        }
    )
    url = f"https://maps.googleapis.com/maps/api/geocode/json?{params}"

    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as err:
        raise RuntimeError(f"Geocoding request failed: {err}") from err

    status = payload.get("status")
    if status != "OK" or not payload.get("results"):
        message = payload.get("error_message") or status or "UNKNOWN_ERROR"
        raise RuntimeError(f"Geocoding failed for '{location}': {message}")

    result = payload["results"][0]
    loc = result["geometry"]["location"]
    return {
        "latitude": float(loc["lat"]),
        "longitude": float(loc["lng"]),
        "formatted_address": result.get("formatted_address") or address,
        "query": location,
    }


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(a))


def cafes_within_radius(
    latitude: float, longitude: float, radius_km: float = RADIUS_KM
) -> list[str]:
    """Return place_ids of cafes within radius_km of the point."""
    rows = get_repository().list_cafe_coordinates()

    lat_delta = radius_km / 111.0
    lon_delta = radius_km / max(0.01, 111.0 * math.cos(math.radians(latitude)))

    matched: list[str] = []
    for row in rows:
        place_id = row["place_id"]
        lat = row["latitude"]
        lon = row["longitude"]
        try:
            lat_f = float(lat)
            lon_f = float(lon)
        except (TypeError, ValueError):
            continue
        if abs(lat_f - latitude) > lat_delta or abs(lon_f - longitude) > lon_delta:
            continue
        if haversine_km(latitude, longitude, lat_f, lon_f) <= radius_km:
            matched.append(place_id)
    return matched


def resolve_point(google_api_key: str, location: str) -> dict[str, Any]:
    """
    Resolve a location string to coordinates.

    Known neighborhoods come from the shared gazetteer with no network call;
    everything else falls back to the Google Geocoding API.
    """
    known = find_neighborhood(location)
    if known:
        return {
            "latitude": known["centroid"]["latitude"],
            "longitude": known["centroid"]["longitude"],
            "formatted_address": f"{known['name']}, Barcelona, Spain",
            "query": location,
            "source": "gazetteer",
        }

    geo = geocode_location(google_api_key, location)
    return {**geo, "source": "geocode"}


def resolve_location_filter(
    openai_client: OpenAI, google_api_key: str, query: str
) -> dict[str, Any]:
    """
    Detect location in query and return filter metadata.
    place_ids is None when no location filter should be applied.

    Resolving coordinates is best-effort: if it fails the search still runs,
    unfiltered, with `requested` true and `applied` false.
    """
    detected = extract_location(openai_client, query)
    if not detected:
        return {
            "applied": False,
            "requested": False,
            "location": None,
            "coordinates": None,
            "place_ids": None,
            "cafe_count": None,
            "source": None,
            "notice": None,
        }

    location = detected["location"]
    try:
        point = resolve_point(google_api_key, location)
    except Exception as err:  # noqa: BLE001 - location filtering is optional
        # Detail stays server-side; the caller only sees `notice`.
        print(
            json.dumps({"msg": "location_resolve_failed", "error": str(err)}),
            file=sys.stderr,
        )
        return {
            "applied": False,
            "requested": True,
            "location": location,
            "location_type": detected.get("location_type"),
            "coordinates": None,
            "place_ids": None,
            "cafe_count": None,
            "source": None,
            "notice": (
                f"Couldn't pin down '{location}' just now, "
                "so these results cover all of Barcelona."
            ),
            "error": str(err),
        }

    place_ids = cafes_within_radius(point["latitude"], point["longitude"], RADIUS_KM)
    return {
        "applied": True,
        "requested": True,
        "location": location,
        "location_type": detected.get("location_type"),
        "coordinates": {
            "latitude": point["latitude"],
            "longitude": point["longitude"],
            "formatted_address": point["formatted_address"],
        },
        "radius_km": RADIUS_KM,
        "place_ids": place_ids,
        "cafe_count": len(place_ids),
        "source": point["source"],
        "notice": None,
    }
