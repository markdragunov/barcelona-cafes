#!/usr/bin/env python3
"""
ETL: SQLite cafes.db → Postgres (Supabase / local pgvector), then rebuild embeddings.

Usage:
  export DATABASE_URL=postgresql://...
  export OPENAI_API_KEY=sk-...
  python3 scripts/migrate_sqlite_to_supabase.py [--sqlite path] [--skip-embed]
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Load .env if present
env_path = ROOT / ".env"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def migrate_tables(sqlite_path: Path) -> dict[str, int]:
    import psycopg
    from psycopg.rows import dict_row

    url = (os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        raise SystemExit("DATABASE_URL is required")
    if not sqlite_path.exists():
        raise SystemExit(f"SQLite not found: {sqlite_path}")

    src = sqlite3.connect(str(sqlite_path))
    src.row_factory = sqlite3.Row

    cafes = src.execute(
        """
        SELECT place_id, name, address, rating, user_rating_count, website,
               place_types, latitude, longitude, neighborhood_id, neighborhood_name,
               coffee_content, created_at, updated_at
        FROM cafes
        """
    ).fetchall()

    reviews = src.execute(
        """
        SELECT place_id, author_name, rating, text, publish_time,
               relative_publish_time_description, language_code
        FROM reviews
        """
    ).fetchall()
    src.close()

    with psycopg.connect(url, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            for row in cafes:
                cur.execute(
                    """
                    INSERT INTO cafes (
                      place_id, name, address, rating, user_rating_count, website,
                      place_types, latitude, longitude, neighborhood_id, neighborhood_name,
                      coffee_content, created_at, updated_at
                    ) VALUES (
                      %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                      COALESCE(%s::timestamptz, now()),
                      COALESCE(%s::timestamptz, now())
                    )
                    ON CONFLICT (place_id) DO UPDATE SET
                      name = excluded.name,
                      address = excluded.address,
                      rating = excluded.rating,
                      user_rating_count = excluded.user_rating_count,
                      website = excluded.website,
                      place_types = excluded.place_types,
                      latitude = excluded.latitude,
                      longitude = excluded.longitude,
                      neighborhood_id = excluded.neighborhood_id,
                      neighborhood_name = excluded.neighborhood_name,
                      coffee_content = excluded.coffee_content,
                      updated_at = now()
                    """,
                    (
                        row["place_id"],
                        row["name"],
                        row["address"],
                        row["rating"],
                        row["user_rating_count"],
                        row["website"],
                        row["place_types"] or "[]",
                        row["latitude"],
                        row["longitude"],
                        row["neighborhood_id"],
                        row["neighborhood_name"],
                        row["coffee_content"],
                        row["created_at"],
                        row["updated_at"],
                    ),
                )

            for row in reviews:
                cur.execute(
                    """
                    INSERT INTO reviews (
                      place_id, author_name, rating, text, publish_time,
                      relative_publish_time_description, language_code
                    ) VALUES (%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (place_id, author_name, publish_time, text) DO NOTHING
                    """,
                    (
                        row["place_id"],
                        row["author_name"],
                        row["rating"],
                        row["text"],
                        row["publish_time"],
                        row["relative_publish_time_description"],
                        row["language_code"],
                    ),
                )
        conn.commit()

        with conn.cursor() as cur:
            cur.execute("SELECT count(*)::int AS n FROM cafes")
            n_cafes = cur.fetchone()["n"]
            cur.execute("SELECT count(*)::int AS n FROM reviews")
            n_reviews = cur.fetchone()["n"]

    return {"cafes": n_cafes, "reviews": n_reviews, "sqlite_cafes": len(cafes), "sqlite_reviews": len(reviews)}


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate SQLite → Supabase/pgvector")
    parser.add_argument(
        "--sqlite",
        default=str(ROOT / "data" / "cafes.db"),
        help="Path to source SQLite DB",
    )
    parser.add_argument(
        "--skip-embed",
        action="store_true",
        help="Only copy cafes/reviews; skip OpenAI embeddings",
    )
    args = parser.parse_args()

    # Prefer full local dataset if present
    sqlite_path = Path(args.sqlite)
    alt = Path("/Users/markd/barcelona-cafes/data/cafes.db")
    if (not sqlite_path.exists() or sqlite_path.stat().st_size < 100_000) and alt.exists():
        print(f"Using fuller dataset: {alt}")
        sqlite_path = alt

    print(f"Migrating tables from {sqlite_path} …")
    counts = migrate_tables(sqlite_path)
    print(counts)

    if args.skip_embed:
        print("Skipping embeddings (--skip-embed)")
        return

    api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise SystemExit("OPENAI_API_KEY required for embedding step")

    from rag.index import rebuild_indexes

    print("Rebuilding pgvector embeddings + BM25 memory cache …")
    result = rebuild_indexes(api_key)
    print(result)


if __name__ == "__main__":
    main()
