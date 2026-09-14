"""Postgres helpers for RAG (Supabase / local pgvector)."""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


def database_url() -> str:
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        raise RuntimeError(
            "DATABASE_URL is required (Supabase pooler or local pgvector)."
        )
    return url


@contextmanager
def connect() -> Iterator[psycopg.Connection]:
    with psycopg.connect(database_url(), row_factory=dict_row) as conn:
        yield conn


def fetch_all(sql: str, params: tuple[Any, ...] | None = None) -> list[dict[str, Any]]:
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
            return list(cur.fetchall())


def fetch_one(sql: str, params: tuple[Any, ...] | None = None) -> dict[str, Any] | None:
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
            return cur.fetchone()


def execute(sql: str, params: tuple[Any, ...] | None = None) -> None:
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
        conn.commit()


def execute_many(sql: str, params_seq: list[tuple[Any, ...]]) -> None:
    with connect() as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, params_seq)
        conn.commit()


def as_jsonb(value: Any) -> Jsonb:
    return Jsonb(value)
