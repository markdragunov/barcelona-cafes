"""In-memory BM25 index built from IndexStore documents (no pickle on disk)."""

from __future__ import annotations

import re
import threading
from typing import Any

from rank_bm25 import BM25Okapi

_lock = threading.RLock()
_cache: dict[str, Any] | None = None


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9àáâãäåæçèéêëìíîïñòóôõöùúûüýÿ]+", text.lower())


def clear_cache() -> None:
    global _cache
    with _lock:
        _cache = None


def rebuild_from_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    place_ids = [r["place_id"] for r in rows]
    documents = [r.get("document_text") or r.get("document") or "" for r in rows]
    metadatas = [r.get("metadata") or {} for r in rows]
    tokenized = [_tokenize(t) for t in documents]
    bm25 = BM25Okapi(tokenized) if tokenized else BM25Okapi([["empty"]])
    payload = {
        "place_ids": place_ids,
        "documents": documents,
        "metadatas": metadatas,
        "tokenized": tokenized,
        "bm25": bm25,
    }
    global _cache
    with _lock:
        _cache = payload
    return payload


def rebuild_from_db() -> dict[str, Any]:
    """Rebuild BM25 from whatever IndexStore currently holds."""
    # Lazy import avoids circular dependency with IndexStore adapters.
    from .stores.factory import get_index_store

    rows = get_index_store().iter_documents_for_bm25()
    if not rows:
        clear_cache()
        return {
            "place_ids": [],
            "documents": [],
            "metadatas": [],
            "tokenized": [],
            "bm25": BM25Okapi([["empty"]]),
        }
    return rebuild_from_rows(rows)


def get_cache() -> dict[str, Any]:
    global _cache
    with _lock:
        if _cache is not None:
            return _cache
    return rebuild_from_db()


def document_count() -> int:
    payload = get_cache()
    return len(payload.get("place_ids") or [])
