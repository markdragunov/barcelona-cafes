"""Load cafe documents from SQLite: coffee_content + reviews."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from .paths import DB_PATH


def _reviews_block(conn: sqlite3.Connection, place_id: str) -> str:
    rows = conn.execute(
        """
        SELECT author_name, rating, text
        FROM reviews
        WHERE place_id = ?
        ORDER BY publish_time DESC
        """,
        (place_id,),
    ).fetchall()
    if not rows:
        return ""
    lines = []
    for author, rating, text in rows:
        author = author or "Anonymous"
        rating_s = f"{rating}/5" if rating is not None else "n/a"
        body = (text or "").strip()
        if body:
            lines.append(f"- {author} ({rating_s}): {body}")
        else:
            lines.append(f"- {author} ({rating_s})")
    return "\n".join(lines)


def _coffee_text(raw: str | None) -> str:
    if not raw or not str(raw).strip():
        return ""
    text = str(raw).strip()
    # Parallel extract stores JSON; prefer readable excerpts when present.
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


def build_document(cafe: dict[str, Any], reviews_text: str, coffee_text: str) -> str:
    sections = [
        f"Name: {cafe['name']}",
        f"Address: {cafe.get('address') or ''}",
        f"District: {cafe.get('district') or ''}",
        f"Rating: {cafe.get('rating') if cafe.get('rating') is not None else ''}",
        f"Website: {cafe.get('website') or ''}",
        f"Places ID: {cafe['place_id']}",
    ]
    if coffee_text:
        sections.append("Coffee content:\n" + coffee_text)
    if reviews_text:
        sections.append("Reviews:\n" + reviews_text)
    return "\n".join(sections).strip()


def load_cafe_documents() -> list[dict[str, Any]]:
    """Return indexable cafe docs with metadata + combined text."""
    if not DB_PATH.exists():
        return []

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        cafes = conn.execute(
            """
            SELECT
              place_id, name, address, rating, website,
              neighborhood_name, coffee_content
            FROM cafes
            ORDER BY name COLLATE NOCASE
            """
        ).fetchall()

        documents: list[dict[str, Any]] = []
        for row in cafes:
            cafe = {
                "place_id": row["place_id"],
                "name": row["name"] or "Unknown",
                "address": row["address"] or "",
                "rating": float(row["rating"]) if row["rating"] is not None else 0.0,
                "website": row["website"] or "",
                "district": row["neighborhood_name"] or "",
            }
            coffee_text = _coffee_text(row["coffee_content"])
            reviews_text = _reviews_block(conn, cafe["place_id"])
            if not coffee_text and not reviews_text:
                continue
            document = build_document(cafe, reviews_text, coffee_text)
            documents.append(
                {
                    "place_id": cafe["place_id"],
                    "document": document,
                    "metadata": {
                        "place_id": cafe["place_id"],
                        "name": cafe["name"],
                        "address": cafe["address"],
                        "rating": cafe["rating"],
                        "district": cafe["district"],
                        "website": cafe["website"],
                    },
                }
            )
        return documents
    finally:
        conn.close()
