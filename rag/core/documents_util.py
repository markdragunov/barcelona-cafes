"""Shared document-building helpers (backend-agnostic)."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def coffee_text(raw: str | None) -> str:
    if not raw or not str(raw).strip():
        return ""
    text = str(raw).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return text

    parts: list[str] = []
    for result in data.get("results") or []:
        title = result.get("title")
        url = result.get("url")
        if title or url:
            parts.append(f"Source: {title or ''} {url or ''}".strip())
        excerpts = result.get("excerpts") or []
        if excerpts:
            parts.append("Excerpts:\n" + "\n".join(str(e) for e in excerpts if e))
        full = result.get("full_content")
        if full:
            parts.append(f"Full content:\n{full}")
    if parts:
        return "\n\n".join(parts)
    return text


def reviews_block(reviews: list[dict[str, Any]]) -> str:
    if not reviews:
        return ""
    lines = []
    for row in reviews:
        author = row.get("author_name") or "Anonymous"
        rating = row.get("rating")
        rating_s = f"{rating}/5" if rating is not None else "n/a"
        body = (row.get("text") or "").strip()
        if body:
            lines.append(f"- {author} ({rating_s}): {body}")
        else:
            lines.append(f"- {author} ({rating_s})")
    return "\n".join(lines)


def build_document(cafe: dict[str, Any], reviews_text: str, coffee: str) -> str:
    sections = [
        f"Name: {cafe['name']}",
        f"Address: {cafe.get('address') or ''}",
        f"District: {cafe.get('district') or ''}",
        f"Rating: {cafe.get('rating') if cafe.get('rating') is not None else ''}",
        f"Website: {cafe.get('website') or ''}",
        f"Places ID: {cafe['place_id']}",
    ]
    if coffee:
        sections.append("Coffee content:\n" + coffee)
    if reviews_text:
        sections.append("Reviews:\n" + reviews_text)
    return "\n".join(sections).strip()


def content_hash(coffee_raw: str | None, reviews_text: str) -> str:
    payload = f"{coffee_raw or ''}\n---\n{reviews_text}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def cafe_metadata(cafe: dict[str, Any]) -> dict[str, Any]:
    """Index/search metadata. Chroma rejects None, so omit missing coords."""
    meta: dict[str, Any] = {
        "place_id": cafe["place_id"],
        "name": cafe.get("name") or "Unknown",
        "address": cafe.get("address") or "",
        "rating": cafe.get("rating") if cafe.get("rating") is not None else 0.0,
        "district": cafe.get("district") or "",
        "website": cafe.get("website") or "",
    }
    lat = _optional_float(cafe.get("latitude"))
    lng = _optional_float(cafe.get("longitude"))
    if lat is not None:
        meta["latitude"] = lat
    if lng is not None:
        meta["longitude"] = lng
    return meta


def assemble_documents(
    cafes: list[dict[str, Any]],
    reviews_by_place: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    for row in cafes:
        cafe = {
            "place_id": row["place_id"],
            "name": row.get("name") or "Unknown",
            "address": row.get("address") or "",
            "rating": float(row["rating"]) if row.get("rating") is not None else 0.0,
            "website": row.get("website") or "",
            "district": row.get("neighborhood_name") or row.get("district") or "",
            "latitude": _optional_float(row.get("latitude")),
            "longitude": _optional_float(row.get("longitude")),
        }
        coffee = coffee_text(row.get("coffee_content"))
        rtext = reviews_block(reviews_by_place.get(cafe["place_id"], []))
        if not coffee and not rtext:
            continue
        document = build_document(cafe, rtext, coffee)
        documents.append(
            {
                "place_id": cafe["place_id"],
                "document": document,
                "content_hash": content_hash(row.get("coffee_content"), rtext),
                "metadata": cafe_metadata(cafe),
            }
        )
    return documents
