"""Load cafe documents via CafeRepository (backend-agnostic)."""

from __future__ import annotations

from typing import Any

from .core.documents_util import (
    assemble_documents,
    build_document,
    coffee_text,
    content_hash,
    reviews_block,
)
from .stores.factory import get_repository

# Re-export helpers used by tests / scripts
__all__ = [
    "assemble_documents",
    "build_document",
    "coffee_text",
    "content_hash",
    "load_cafe_documents",
    "reviews_block",
]


def load_cafe_documents() -> list[dict[str, Any]]:
    """Return indexable cafe docs with metadata + combined text."""
    return get_repository().load_cafe_documents()
