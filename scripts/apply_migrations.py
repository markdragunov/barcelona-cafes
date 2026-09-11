#!/usr/bin/env python3
"""Apply supabase/migrations/*.sql using psycopg (no psql required)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
env_path = ROOT / ".env"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

url = (os.environ.get("DATABASE_URL") or "").strip()
if not url:
    url = "postgresql://postgres:postgres@127.0.0.1:54329/barcelona_cafes"
    os.environ["DATABASE_URL"] = url

import psycopg

mig_dir = ROOT / "supabase" / "migrations"
files = sorted(mig_dir.glob("*.sql"))
if not files:
    raise SystemExit(f"No migrations in {mig_dir}")

print(f"Applying {len(files)} migration(s)…")
with psycopg.connect(url) as conn:
    conn.execute("SELECT 1")
    for f in files:
        sql = f.read_text()
        print(f"→ {f.name}")
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()

with psycopg.connect(url) as conn:
    with conn.cursor() as cur:
        cur.execute("SELECT extname FROM pg_extension WHERE extname = 'vector'")
        assert cur.fetchone(), "vector extension missing"
        cur.execute(
            """
            SELECT c.relname
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r'
              AND c.relname IN ('cafes','reviews','cafe_documents')
            ORDER BY 1
            """
        )
        tables = [r[0] for r in cur.fetchall()]
        print("tables:", tables)
        assert tables == ["cafe_documents", "cafes", "reviews"]
print("Migrations OK")
