"""Storage ports: CafeRepository + IndexStore."""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class CafeRepository(Protocol):
    def load_cafe_documents(self) -> list[dict[str, Any]]: ...

    def list_cafe_coordinates(self) -> list[dict[str, Any]]: ...

    def cafe_count(self) -> int: ...


@runtime_checkable
class IndexStore(Protocol):
    def rebuild(self, openai_api_key: str, documents: list[dict[str, Any]]) -> dict[str, Any]: ...

    def is_ready(self) -> bool: ...

    def status(self) -> dict[str, Any]: ...

    def vector_search(
        self,
        query_embedding: list[float],
        top_n: int,
        allowed_place_ids: set[str] | None = None,
    ) -> list[dict[str, Any]]: ...

    def iter_documents_for_bm25(self) -> list[dict[str, Any]]: ...
