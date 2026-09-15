"""SQLite CafeRepository."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from ..core.documents_util import assemble_documents
from ..paths import sqlite_path


class SqliteCafeRepository:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or sqlite_path()

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.path))
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS cafes (
              place_id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              address TEXT,
              rating REAL,
              user_rating_count INTEGER,
              website TEXT,
              place_types TEXT NOT NULL DEFAULT '[]',
              latitude REAL,
              longitude REAL,
              neighborhood_id TEXT,
              neighborhood_name TEXT,
              coffee_content TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS reviews (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              place_id TEXT NOT NULL,
              author_name TEXT,
              rating REAL,
              text TEXT,
              publish_time TEXT,
              relative_publish_time_description TEXT,
              language_code TEXT,
              UNIQUE(place_id, author_name, publish_time, text)
            );
            CREATE INDEX IF NOT EXISTS idx_cafes_neighborhood ON cafes(neighborhood_id);
            CREATE INDEX IF NOT EXISTS idx_reviews_place ON reviews(place_id);
            CREATE INDEX IF NOT EXISTS idx_cafes_coords ON cafes(latitude, longitude);
            """
        )
        conn.commit()
        return conn

    def load_cafe_documents(self) -> list[dict[str, Any]]:
        conn = self._connect()
        conn.row_factory = sqlite3.Row
        try:
            cafes = [dict(r) for r in conn.execute(
                """
                SELECT place_id, name, address, rating, website,
                       neighborhood_name, coffee_content, latitude, longitude
                FROM cafes ORDER BY name COLLATE NOCASE
                """
            )]
            reviews_by: dict[str, list[dict[str, Any]]] = {}
            for r in conn.execute(
                """
                SELECT place_id, author_name, rating, text, publish_time
                FROM reviews ORDER BY publish_time DESC
                """
            ):
                reviews_by.setdefault(r["place_id"], []).append(dict(r))
            return assemble_documents(cafes, reviews_by)
        finally:
            conn.close()

    def list_cafe_coordinates(
        self,
        south: float | None = None,
        north: float | None = None,
        west: float | None = None,
        east: float | None = None,
        place_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        conn = self._connect()
        conn.row_factory = sqlite3.Row
        try:
            sql = """
                SELECT place_id, latitude, longitude FROM cafes
                WHERE latitude IS NOT NULL AND longitude IS NOT NULL
            """
            params: list[Any] = []
            if None not in (south, north, west, east):
                sql += (
                    " AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?"
                )
                params = [south, north, west, east]
            if place_ids is not None:
                if not place_ids:
                    return []
                sql += f" AND place_id IN ({','.join('?' for _ in place_ids)})"
                params.extend(place_ids)
            return [dict(r) for r in conn.execute(sql, params)]
        finally:
            conn.close()

    def cafe_count(self) -> int:
        conn = self._connect()
        try:
            return int(conn.execute("SELECT COUNT(*) FROM cafes").fetchone()[0])
        finally:
            conn.close()
