"""Composition root: repository + index store from STORAGE_BACKEND."""

from __future__ import annotations

import os
from typing import Any

STORAGE_SQLITE_CHROMA = "sqlite+chroma"
STORAGE_SUPABASE = "supabase"

_repo = None
_index = None


def get_storage_backend() -> str:
    raw = (os.environ.get("STORAGE_BACKEND") or STORAGE_SQLITE_CHROMA).strip().lower()
    if raw in {STORAGE_SUPABASE, "postgres", "pg", "postgresql"}:
        return STORAGE_SUPABASE
    return STORAGE_SQLITE_CHROMA


def _require_database_url() -> str:
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        raise RuntimeError(
            "DATABASE_URL is required when STORAGE_BACKEND=supabase "
            "(set it in .env; never hardcode)."
        )
    return url


def create_repository():
    backend = get_storage_backend()
    if backend == STORAGE_SUPABASE:
        _require_database_url()
        from .postgres_repo import PostgresCafeRepository

        return PostgresCafeRepository()
    from .sqlite_repo import SqliteCafeRepository

    return SqliteCafeRepository()


def create_index_store():
    backend = get_storage_backend()
    if backend == STORAGE_SUPABASE:
        _require_database_url()
        from .pgvector_index import PgvectorIndexStore

        return PgvectorIndexStore()
    from .chroma_index import ChromaIndexStore

    return ChromaIndexStore()


def get_repository():
    global _repo
    if _repo is None:
        _repo = create_repository()
    return _repo


def get_index_store():
    global _index
    if _index is None:
        _index = create_index_store()
    return _index


def reset_storage_cache() -> None:
    global _repo, _index
    _repo = None
    _index = None


def storage_info() -> dict[str, Any]:
    return {
        "backend": get_storage_backend(),
        "database_url_set": bool((os.environ.get("DATABASE_URL") or "").strip()),
    }
