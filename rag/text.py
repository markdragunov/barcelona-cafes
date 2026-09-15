"""Shared text helpers so BM25 indexing and search tokenize identically."""

from __future__ import annotations

import re

_TOKEN_RE = re.compile(r"[a-z0-9àáâãäåæçèéêëìíîïñòóôõöùúûüýÿ]+")


def tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall((text or "").lower())


CONTEXT_DOC_CHARS = 1200


def clip_document(text: str, limit: int = CONTEXT_DOC_CHARS) -> str:
    """Keep LLM context to one explaining phrase per cafe, not the full dump."""
    clipped = (text or "").strip()
    if len(clipped) <= limit:
        return clipped
    return clipped[:limit].rstrip() + "…"
