"""Structured constraints parsed from a natural-language cafe query."""

from __future__ import annotations

import re
from typing import Any

_RATING_PATTERNS = (
    re.compile(r">=\s*(\d+(?:[.,]\d+)?)"),
    re.compile(r"\b(?:at\s+least|minimum|min\.?)\s+(\d+(?:[.,]\d+)?)", re.I),
    re.compile(r"\brating\s*(?:of\s+|>=?\s*)(\d+(?:[.,]\d+)?)", re.I),
    re.compile(r"\b(?:above|over|higher than|выше)\s+(\d+(?:[.,]\d+)?)", re.I),
    re.compile(r"\b(\d+(?:[.,]\d+)?)\s*\+"),
    re.compile(r"\b(\d+(?:[.,]\d+)?)\s*(?:stars?|★)"),
)

_WORK_RE = re.compile(
    r"(?i)\b(work|laptop|notebook|wifi|wi-fi|remote|ноут|офис|办公)\b"
)
_SPECIALTY_RE = re.compile(
    r"(?i)\b(specialty|speciality|especialidad|third[\s-]?wave|filter coffee|hand[\s-]?pour|手冲)\b"
)


def parse_constraints(query: str) -> dict[str, Any]:
    text = query or ""
    min_rating: float | None = None
    for pattern in _RATING_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        try:
            value = float(match.group(1).replace(",", "."))
        except (TypeError, ValueError):
            continue
        if 1 <= value <= 5:
            min_rating = value
            break
    return {
        "min_rating": min_rating,
        "needs_work": bool(_WORK_RE.search(text)),
        "needs_specialty": bool(_SPECIALTY_RE.search(text)),
    }


def cafe_meets_min_rating(meta: dict[str, Any] | None, min_rating: float) -> bool:
    try:
        rating = float((meta or {}).get("rating"))
    except (TypeError, ValueError):
        return False
    return rating >= min_rating


def apply_min_rating(
    cafes: list[dict[str, Any]],
    min_rating: float | None,
    limit: int,
) -> list[dict[str, Any]]:
    """Keep cafes at/above min_rating, then slice to limit. Missing rating is out."""
    if min_rating is None:
        return cafes[:limit]
    kept = [
        cafe
        for cafe in cafes
        if cafe_meets_min_rating(cafe.get("metadata"), min_rating)
    ]
    return kept[:limit]


def apply_reason_keep(
    cafes: list[dict[str, Any]],
    reasons_by_id: dict[str, str],
    parsed_ok: bool,
) -> list[dict[str, Any]]:
    """Drop cafes the LLM omitted. If JSON parsing failed, keep the list."""
    if not parsed_ok:
        return cafes
    return [cafe for cafe in cafes if cafe.get("place_id") in reasons_by_id]
