"""Neighborhood gazetteer shared with the Node side (shared/neighborhoods.json).

Lets location search resolve well-known neighborhoods to a centroid locally,
so the Google Geocoding API is only called for places we do not know.
"""

from __future__ import annotations

import json
import re
import unicodedata
from functools import lru_cache
from typing import Any

from .paths import ROOT

GAZETTEER_PATH = ROOT / "shared" / "neighborhoods.json"
LANDMARKS_PATH = ROOT / "shared" / "landmarks.json"

# Catalan/Spanish/English articles that users add or drop interchangeably.
_ARTICLES = ("el ", "la ", "l ", "els ", "les ", "los ", "las ", "the ")


def normalize_name(value: str) -> str:
    """Casefold, strip accents/punctuation/articles so 'Gràcia' == 'gracia'."""
    decomposed = unicodedata.normalize("NFKD", value or "")
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    text = re.sub(r"[^a-z0-9]+", " ", stripped.lower()).strip()
    # "Gracia, Barcelona" and "Gracia" are the same place.
    text = re.sub(r"\s+barcelona$", "", text).strip()
    for article in _ARTICLES:
        if text.startswith(article):
            text = text[len(article) :].strip()
            break
    return text


def _centroid(viewport: dict[str, Any]) -> dict[str, float]:
    low = viewport["low"]
    high = viewport["high"]
    return {
        "latitude": (float(low["latitude"]) + float(high["latitude"])) / 2,
        "longitude": (float(low["longitude"]) + float(high["longitude"])) / 2,
    }


@lru_cache(maxsize=1)
def load_neighborhoods() -> list[dict[str, Any]]:
    with GAZETTEER_PATH.open(encoding="utf-8") as fh:
        return json.load(fh)["neighborhoods"]


@lru_cache(maxsize=1)
def _lookup_index() -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for entry in load_neighborhoods():
        # City-wide entries and search-only groups are not a single-neighborhood filter.
        if entry.get("aggregate") or entry.get("searchGroup"):
            continue
        record = {
            "id": entry["id"],
            "name": entry["name"],
            "centroid": _centroid(entry["viewport"]),
        }
        names = [entry["id"], entry["name"], *entry.get("aliases", [])]
        for name in names:
            key = normalize_name(name)
            if not key:
                continue
            index.setdefault(key, record)
            # "Poble Nou" / "Poblenou", "Gothic Quarter" / "GothicQuarter".
            index.setdefault(key.replace(" ", ""), record)
    return index


def find_neighborhood(location: str) -> dict[str, Any] | None:
    """Return {id, name, centroid} for a known neighborhood, else None."""
    key = normalize_name(location)
    if not key:
        return None
    index = _lookup_index()
    return index.get(key) or index.get(key.replace(" ", ""))


def _latin_alias_in_query(key: str, normalized_query: str) -> bool:
    if not key:
        return False
    compact_query = normalized_query.replace(" ", "")
    compact_key = key.replace(" ", "")
    if re.search(rf"(?:^|\s){re.escape(key)}(?:\s|$)", normalized_query):
        return True
    if " " in key and compact_key and compact_key in compact_query:
        return True
    return False


def _scan_named_places(
    entries: list[dict[str, Any]], query: str
) -> dict[str, Any] | None:
    if not (query or "").strip():
        return None
    folded = query.casefold()
    normalized = normalize_name(query)
    best: dict[str, Any] | None = None
    best_len = 0
    for entry in entries:
        record = {
            "id": entry["id"],
            "name": entry["name"],
            "centroid": entry["centroid"],
            "kind": entry.get("kind") or "place",
        }
        names = [entry["id"], entry["name"], *entry.get("aliases", [])]
        for name in names:
            raw = str(name or "").strip()
            if not raw:
                continue
            matched = False
            if re.search(r"[^\x00-\x7f]", raw):
                matched = raw.casefold() in folded
            else:
                matched = _latin_alias_in_query(normalize_name(raw), normalized)
            if matched and len(raw) > best_len:
                best = record
                best_len = len(raw)
    return best


def find_neighborhood_in_query(query: str) -> dict[str, Any] | None:
    """Scan a full user query for a known neighborhood name or alias."""
    entries = []
    for entry in load_neighborhoods():
        if entry.get("aggregate") or entry.get("searchGroup"):
            continue
        entries.append(
            {
                "id": entry["id"],
                "name": entry["name"],
                "aliases": entry.get("aliases", []),
                "centroid": _centroid(entry["viewport"]),
                "kind": "neighborhood",
            }
        )
    return _scan_named_places(entries, query)


def load_search_groups() -> list[dict[str, Any]]:
    """Named unions of neighborhoods (e.g. Center = Gòtic + Born + Eixample)."""
    by_id = {entry["id"]: entry for entry in load_neighborhoods()}
    groups: list[dict[str, Any]] = []
    for entry in load_neighborhoods():
        member_ids = entry.get("searchGroup") or []
        if not member_ids:
            continue
        viewports: list[dict[str, Any]] = []
        member_names: list[str] = []
        for member_id in member_ids:
            member = by_id.get(member_id)
            if not member or not member.get("viewport"):
                continue
            viewports.append(member["viewport"])
            member_names.append(member["name"])
        if not viewports:
            continue
        groups.append(
            {
                "id": entry["id"],
                "name": entry["name"],
                "aliases": entry.get("aliases", []),
                "viewports": viewports,
                "member_names": member_names,
                "display": f"{entry['name']} ({', '.join(member_names)})",
            }
        )
    return groups


def find_search_group_in_query(query: str) -> dict[str, Any] | None:
    entries = [
        {
            "id": group["id"],
            "name": group["name"],
            "aliases": group["aliases"],
            "centroid": _centroid(group["viewports"][0]),
            "kind": "area_group",
            "viewports": group["viewports"],
            "display": group["display"],
            "member_names": group["member_names"],
        }
        for group in load_search_groups()
        if group["viewports"]
    ]
    hit = _scan_named_places(entries, query)
    if not hit:
        return None
    for group in load_search_groups():
        if group["id"] == hit["id"]:
            return group
    return None


@lru_cache(maxsize=1)
def load_landmarks() -> list[dict[str, Any]]:
    with LANDMARKS_PATH.open(encoding="utf-8") as fh:
        return json.load(fh)["landmarks"]


@lru_cache(maxsize=1)
def _landmark_index() -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for entry in load_landmarks():
        record = {
            "id": entry["id"],
            "name": entry["name"],
            "centroid": {
                "latitude": float(entry["latitude"]),
                "longitude": float(entry["longitude"]),
            },
            "kind": "landmark",
        }
        names = [entry["id"], entry["name"], *entry.get("aliases", [])]
        for name in names:
            key = normalize_name(name)
            if not key:
                continue
            index.setdefault(key, record)
            index.setdefault(key.replace(" ", ""), record)
    return index


def find_landmark(location: str) -> dict[str, Any] | None:
    key = normalize_name(location)
    if not key:
        return None
    index = _landmark_index()
    return index.get(key) or index.get(key.replace(" ", ""))


def find_landmark_in_query(query: str) -> dict[str, Any] | None:
    entries = [
        {
            "id": entry["id"],
            "name": entry["name"],
            "aliases": entry.get("aliases", []),
            "centroid": {
                "latitude": float(entry["latitude"]),
                "longitude": float(entry["longitude"]),
            },
            "kind": "landmark",
        }
        for entry in load_landmarks()
    ]
    return _scan_named_places(entries, query)
