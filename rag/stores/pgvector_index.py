"""pgvector IndexStore adapter (Supabase / local Postgres)."""

from __future__ import annotations

from typing import Any

from openai import OpenAI

from .. import db as pg
from ..bm25_cache import clear_cache, rebuild_from_db
from .embeddings import embed_batch, vector_literal


class PgvectorIndexStore:
    backend = "pgvector"

    def _document_count(self) -> int:
        row = pg.fetch_one("SELECT count(*)::int AS n FROM cafe_documents")
        return int(row["n"] if row else 0)

    def rebuild(self, openai_api_key: str, documents: list[dict[str, Any]]) -> dict[str, Any]:
        if not documents:
            raise RuntimeError("No indexable cafes found for pgvector rebuild.")

        existing = {
            r["place_id"]: r.get("content_hash")
            for r in pg.fetch_all("SELECT place_id, content_hash FROM cafe_documents")
        }
        to_embed = [d for d in documents if existing.get(d["place_id"]) != d["content_hash"]]
        client = OpenAI(api_key=openai_api_key)
        embeddings_by_id: dict[str, list[float]] = {}
        if to_embed:
            vectors = embed_batch(client, [d["document"] for d in to_embed])
            for d, vec in zip(to_embed, vectors):
                embeddings_by_id[d["place_id"]] = vec

        upsert_sql = """
            INSERT INTO cafe_documents (
              place_id, document_text, embedding, metadata, content_hash, updated_at
            ) VALUES (%s, %s, %s::vector, %s, %s, now())
            ON CONFLICT (place_id) DO UPDATE SET
              document_text = excluded.document_text,
              embedding = COALESCE(excluded.embedding, cafe_documents.embedding),
              metadata = excluded.metadata,
              content_hash = excluded.content_hash,
              updated_at = now()
        """
        with pg.connect() as conn:
            with conn.cursor() as cur:
                for d in documents:
                    pid = d["place_id"]
                    if pid in embeddings_by_id:
                        cur.execute(
                            upsert_sql,
                            (
                                pid,
                                d["document"],
                                vector_literal(embeddings_by_id[pid]),
                                pg.as_jsonb(d["metadata"]),
                                d["content_hash"],
                            ),
                        )
                    elif pid in existing:
                        cur.execute(
                            """
                            UPDATE cafe_documents
                            SET document_text = %s, metadata = %s,
                                content_hash = %s, updated_at = now()
                            WHERE place_id = %s
                            """,
                            (
                                d["document"],
                                pg.as_jsonb(d["metadata"]),
                                d["content_hash"],
                                pid,
                            ),
                        )
                keep = [d["place_id"] for d in documents]
                cur.execute(
                    "DELETE FROM cafe_documents WHERE NOT (place_id = ANY(%s))",
                    (keep,),
                )
            conn.commit()

        clear_cache()
        rebuild_from_db()
        return {
            "indexed": len(documents),
            "embedded": len(embeddings_by_id),
            "backend": self.backend,
        }

    def is_ready(self) -> bool:
        try:
            return self._document_count() > 0
        except Exception:
            return False

    def status(self) -> dict[str, Any]:
        try:
            count = self._document_count()
        except Exception:
            count = 0
        return {
            "ready": count > 0,
            "document_count": count,
            "backend": self.backend,
            "bm25": "memory",
        }

    def vector_search(
        self,
        query_embedding: list[float],
        top_n: int,
        allowed_place_ids: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        emb_lit = vector_literal(query_embedding)
        if allowed_place_ids is not None:
            if not allowed_place_ids:
                return []
            rows = pg.fetch_all(
                """
                SELECT place_id, document_text, metadata,
                       1 - (embedding <=> %s::vector) AS score
                FROM cafe_documents
                WHERE place_id = ANY(%s)
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (emb_lit, list(allowed_place_ids), emb_lit, top_n),
            )
        else:
            rows = pg.fetch_all(
                """
                SELECT place_id, document_text, metadata,
                       1 - (embedding <=> %s::vector) AS score
                FROM cafe_documents
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (emb_lit, emb_lit, top_n),
            )
        hits = []
        for rank, row in enumerate(rows, start=1):
            meta = row.get("metadata") or {}
            if not isinstance(meta, dict):
                meta = {}
            hits.append(
                {
                    "place_id": row["place_id"],
                    "document": row.get("document_text") or "",
                    "metadata": meta,
                    "rank": rank,
                    "score": float(row.get("score") or 0.0),
                    "source": "vector",
                }
            )
        return hits

    def iter_documents_for_bm25(self) -> list[dict[str, Any]]:
        return pg.fetch_all(
            """
            SELECT place_id, document_text, metadata
            FROM cafe_documents ORDER BY place_id
            """
        )
