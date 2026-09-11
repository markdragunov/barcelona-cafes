"""Build indexes via IndexStore; refresh in-memory BM25."""

from __future__ import annotations

from typing import Any

from .stores.factory import get_index_store, get_repository


def rebuild_indexes(openai_api_key: str) -> dict[str, Any]:
    repo = get_repository()
    store = get_index_store()
    docs = repo.load_cafe_documents()
    if not docs:
        raise RuntimeError(
            "No indexable cafes found. Need coffee_content and/or reviews."
        )
    return store.rebuild(openai_api_key, docs)


def indexes_ready() -> bool:
    try:
        return get_index_store().is_ready()
    except Exception:
        return False


def index_status() -> dict[str, Any]:
    try:
        from .stores.factory import storage_info

        status = get_index_store().status()
        info = storage_info()
        status["storage_backend"] = info["backend"]
        status["database_url_set"] = info["database_url_set"]
        # Keep IndexStore engine name in "backend" (chroma | pgvector)
        return status
    except Exception as err:
        return {
            "ready": False,
            "document_count": 0,
            "backend": "unknown",
            "error": str(err),
        }
