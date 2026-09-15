"""Postgres CafeRepository — uses DATABASE_URL from environment only."""

from __future__ import annotations

from typing import Any

from ..core.documents_util import assemble_documents
from ..db import connect, database_url, fetch_all, fetch_one


class PostgresCafeRepository:
    def __init__(self) -> None:
        # Validates URL is present without logging it.
        database_url()

    def load_cafe_documents(self) -> list[dict[str, Any]]:
        cafes = fetch_all(
            """
            SELECT place_id, name, address, rating, website,
                   neighborhood_name, coffee_content, latitude, longitude
            FROM cafes ORDER BY lower(name)
            """
        )
        reviews_by: dict[str, list[dict[str, Any]]] = {}
        for row in fetch_all(
            """
            SELECT place_id, author_name, rating, text, publish_time
            FROM reviews ORDER BY publish_time DESC NULLS LAST
            """
        ):
            reviews_by.setdefault(row["place_id"], []).append(row)
        return assemble_documents(cafes, reviews_by)

    def list_cafe_coordinates(
        self,
        south: float | None = None,
        north: float | None = None,
        west: float | None = None,
        east: float | None = None,
        place_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        sql = """
            SELECT place_id, latitude, longitude FROM cafes
            WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        """
        params: tuple[Any, ...] = ()
        if None not in (south, north, west, east):
            sql += (
                " AND latitude BETWEEN %s AND %s AND longitude BETWEEN %s AND %s"
            )
            params = (south, north, west, east)
        if place_ids is not None:
            if not place_ids:
                return []
            sql += " AND place_id = ANY(%s)"
            params = (*params, list(place_ids))
        return fetch_all(sql, params)

    def cafe_count(self) -> int:
        row = fetch_one("SELECT count(*)::int AS n FROM cafes")
        return int(row["n"] if row else 0)
