"""Location detection, Google Geocoding, and cafe radius filter."""

from __future__ import annotations

import json
import math
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .neighborhoods import (
    find_landmark,
    find_landmark_in_query,
    find_neighborhood,
    find_neighborhood_in_query,
    find_search_group_in_query,
    normalize_name,
)
from .stores.factory import get_repository

RADIUS_KM = 1.0
RADIUS_STEPS_KM = (1.0, 2.0, 3.0)
_CITY_ONLY = {"barcelona", "bcn", "barna"}
_PLACE_STOPWORDS = {
    "the",
    "a",
    "an",
    "my",
    "this",
    "that",
    "local",
    "guide",
    "barcelona",
}

# Cut the captured place before constraint clauses: "in Gràcia with a laptop".
_PLACE_TAIL_STOP = re.compile(
    r"(?i)\s+(?:with|without|and|or|for|para|con|для|that|which|where)\b"
)

# Deterministic place phrases: "in Gràcia", "cerca de la Barceloneta", "в Грасии".
_PLACE_PATTERNS = [
    re.compile(
        r"(?i)\b(?:cerca de(?:l| la)?|near(?: the)?|around(?: the)?|"
        r"in|at|on|en|por)\s+([^,.!?]{2,40})"
    ),
    re.compile(r"(?i)\b(?:в|на)\s+([^,.!?]{2,40})"),
    re.compile(r"在([^，。！？\s]{2,20})"),
]


def _trim_place_candidate(raw: str) -> str:
    text = re.sub(r"\s+", " ", raw or "").strip(" .,-")
    cut = _PLACE_TAIL_STOP.search(text)
    if cut:
        text = text[: cut.start()].strip(" .,-")
    text = re.sub(r"(?i)\s+of\s+barcelona$", "", text).strip()
    return text


def extract_location(query: str) -> dict[str, Any] | None:
    """Find a location in the query without calling an LLM."""
    group = find_search_group_in_query(query)
    if group:
        return {
            "location": group["display"],
            "location_type": "area_group",
            "viewports": group["viewports"],
        }

    known = find_neighborhood_in_query(query)
    if known:
        return {"location": known["name"], "location_type": "neighborhood"}

    landmark = find_landmark_in_query(query)
    if landmark:
        return {"location": landmark["name"], "location_type": "landmark"}

    for pattern in _PLACE_PATTERNS:
        match = pattern.search(query or "")
        if not match:
            continue
        candidate = _trim_place_candidate(match.group(1))
        if not candidate:
            continue
        first = normalize_name(candidate).split(" ")[0] if normalize_name(candidate) else ""
        if first in _PLACE_STOPWORDS:
            continue
        if normalize_name(candidate) in _CITY_ONLY:
            continue
        nested = find_neighborhood(candidate)
        if nested:
            return {"location": nested["name"], "location_type": "neighborhood"}
        nested_landmark = find_landmark(candidate)
        if nested_landmark:
            return {"location": nested_landmark["name"], "location_type": "landmark"}
        nested_group = find_search_group_in_query(candidate)
        if nested_group:
            return {
                "location": nested_group["display"],
                "location_type": "area_group",
                "viewports": nested_group["viewports"],
            }
        return {"location": candidate, "location_type": "area"}

    return None


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
    lat_delta = radius_km / 111.0
    lon_delta = radius_km / max(0.01, 111.0 * math.cos(math.radians(latitude)))
    south = latitude - lat_delta
    north = latitude + lat_delta
    west = longitude - lon_delta
    east = longitude + lon_delta

    repo = get_repository()
    try:
        rows = repo.list_cafe_coordinates(
            south=south, north=north, west=west, east=east
        )
    except TypeError:
        rows = repo.list_cafe_coordinates()

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


def _in_viewport(lat: float, lon: float, viewport: dict[str, Any]) -> bool:
    low = viewport["low"]
    high = viewport["high"]
    return (
        float(low["latitude"]) <= lat <= float(high["latitude"])
        and float(low["longitude"]) <= lon <= float(high["longitude"])
    )


def cafes_in_viewports(viewports: list[dict[str, Any]]) -> list[str]:
    """Cafes whose coordinates fall in any of the neighborhood rectangles."""
    if not viewports:
        return []
    south = min(float(vp["low"]["latitude"]) for vp in viewports)
    north = max(float(vp["high"]["latitude"]) for vp in viewports)
    west = min(float(vp["low"]["longitude"]) for vp in viewports)
    east = max(float(vp["high"]["longitude"]) for vp in viewports)
    repo = get_repository()
    try:
        rows = repo.list_cafe_coordinates(
            south=south, north=north, west=west, east=east
        )
    except TypeError:
        rows = repo.list_cafe_coordinates()
    matched: list[str] = []
    for row in rows:
        try:
            lat_f = float(row["latitude"])
            lon_f = float(row["longitude"])
        except (TypeError, ValueError, KeyError):
            continue
        if any(_in_viewport(lat_f, lon_f, vp) for vp in viewports):
            matched.append(row["place_id"])
    return matched


def resolve_point(google_api_key: str, location: str) -> dict[str, Any]:
    """
    Resolve a location string to coordinates.

    Known neighborhoods and landmarks come from the shared gazetteer with no
    network call; everything else falls back to the Google Geocoding API.
    """
    known = find_neighborhood(location) or find_landmark(location)
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


def resolve_location_filter(google_api_key: str, query: str) -> dict[str, Any]:
    """
    Detect location in query and return filter metadata.
    place_ids is None when no location filter should be applied.

    Resolving coordinates is best-effort: if it fails the search still runs,
    unfiltered, with `requested` true and `applied` false.
    """
    detected = extract_location(query)
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
    if detected.get("location_type") == "area_group":
        place_ids = cafes_in_viewports(detected.get("viewports") or [])
        if not place_ids:
            return {
                "applied": False,
                "requested": True,
                "location": location,
                "location_type": "area_group",
                "coordinates": None,
                "place_ids": None,
                "cafe_count": 0,
                "source": "gazetteer",
                "notice": (
                    f"Couldn't find cafes in '{location}', "
                    "so these results cover all of Barcelona."
                ),
            }
        return {
            "applied": True,
            "requested": True,
            "location": location,
            "location_type": "area_group",
            "coordinates": None,
            "radius_km": None,
            "place_ids": place_ids,
            "cafe_count": len(place_ids),
            "source": "gazetteer",
            "notice": None,
        }

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

    place_ids: list[str] = []
    used_radius = RADIUS_STEPS_KM[0]
    for radius in RADIUS_STEPS_KM:
        place_ids = cafes_within_radius(
            point["latitude"], point["longitude"], radius
        )
        used_radius = radius
        if place_ids:
            break

    if not place_ids:
        return {
            "applied": False,
            "requested": True,
            "location": location,
            "location_type": detected.get("location_type"),
            "coordinates": {
                "latitude": point["latitude"],
                "longitude": point["longitude"],
                "formatted_address": point["formatted_address"],
            },
            "radius_km": used_radius,
            "place_ids": None,
            "cafe_count": 0,
            "source": point["source"],
            "notice": (
                f"Couldn't find cafes near '{location}', "
                "so these results cover all of Barcelona."
            ),
        }

    notice = None
    if used_radius > RADIUS_STEPS_KM[0]:
        notice = (
            f"Nothing within 1 km of {location}; "
            f"showing cafes within {used_radius:g} km."
        )

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
        "radius_km": used_radius,
        "place_ids": place_ids,
        "cafe_count": len(place_ids),
        "source": point["source"],
        "notice": notice,
    }
