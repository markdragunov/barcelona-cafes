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

    def list_cafe_coordinates(self) -> list[dict[str, Any]]:
        conn = self._connect()
        conn.row_factory = sqlite3.Row
        try:
            return [
                dict(r)
                for r in conn.execute(
                    """
                    SELECT place_id, latitude, longitude FROM cafes
                    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
                    """
                )
            ]
        finally:
            conn.close()

    def cafe_count(self) -> int:
        conn = self._connect()
        try:
            return int(conn.execute("SELECT COUNT(*) FROM cafes").fetchone()[0])
        finally:
            conn.close()
