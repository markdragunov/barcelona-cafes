"""ChromaDB IndexStore adapter (local)."""

from __future__ import annotations

import shutil
from typing import Any

import chromadb
from openai import OpenAI

from ..bm25_cache import clear_cache, rebuild_from_rows
from ..paths import COLLECTION_NAME, chroma_dir, data_dir
from .embeddings import embed_batch


class ChromaIndexStore:
    backend = "chroma"

    def rebuild(self, openai_api_key: str, documents: list[dict[str, Any]]) -> dict[str, Any]:
        if not documents:
            raise RuntimeError("No indexable cafes found for Chroma rebuild.")

        data = data_dir()
        chroma_path = chroma_dir()
        data.mkdir(parents=True, exist_ok=True)
        if chroma_path.exists():
            shutil.rmtree(chroma_path)
        chroma_path.mkdir(parents=True, exist_ok=True)

        client = OpenAI(api_key=openai_api_key)
        texts = [d["document"] for d in documents]
        embeddings = embed_batch(client, texts)

        chroma = chromadb.PersistentClient(path=str(chroma_path))
        collection = chroma.create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
        ids = [d["place_id"] for d in documents]
        metadatas = [d["metadata"] for d in documents]
        batch_size = 100
        for i in range(0, len(ids), batch_size):
            collection.add(
                ids=ids[i : i + batch_size],
                documents=texts[i : i + batch_size],
                embeddings=embeddings[i : i + batch_size],
                metadatas=metadatas[i : i + batch_size],
            )

        clear_cache()
        rebuild_from_rows(
            [
                {
                    "place_id": d["place_id"],
                    "document_text": d["document"],
                    "metadata": d["metadata"],
                }
                for d in documents
            ]
        )
        return {"indexed": len(documents), "backend": self.backend}

    def is_ready(self) -> bool:
        chroma_path = chroma_dir()
        if not chroma_path.exists():
            return False
        try:
            chroma = chromadb.PersistentClient(path=str(chroma_path))
            col = chroma.get_collection(COLLECTION_NAME)
            return col.count() > 0
        except Exception:
            return False

    def status(self) -> dict[str, Any]:
        ready = self.is_ready()
        count = 0
        if ready:
            chroma = chromadb.PersistentClient(path=str(chroma_dir()))
            count = chroma.get_collection(COLLECTION_NAME).count()
        return {
            "ready": ready,
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
        chroma = chromadb.PersistentClient(path=str(chroma_dir()))
        collection = chroma.get_collection(COLLECTION_NAME)

        if allowed_place_ids is not None:
            if not allowed_place_ids:
                return []
            got = collection.get(
                ids=list(allowed_place_ids),
                include=["documents", "metadatas", "embeddings"],
            )
            ids = list(got.get("ids") or [])
            docs = list(got.get("documents") or [])
            metas = list(got.get("metadatas") or [])
            embs = list(got.get("embeddings") or [])
            scored: list[tuple[float, int]] = []
            for i, emb in enumerate(embs):
                if emb is None:
                    continue
                if hasattr(emb, "tolist"):
                    emb = emb.tolist()
                try:
                    vec = [float(x) for x in emb]
                except (TypeError, ValueError):
                    continue
                scored.append((_cosine(query_embedding, vec), i))
            scored.sort(key=lambda x: x[0], reverse=True)
            hits = []
            for rank, (score, i) in enumerate(scored[:top_n], start=1):
                meta = metas[i] if i < len(metas) else {}
                if not isinstance(meta, dict):
                    meta = {}
                hits.append(
                    {
                        "place_id": ids[i],
                        "document": docs[i] if i < len(docs) else "",
                        "metadata": meta,
                        "rank": rank,
                        "score": float(score),
                        "source": "vector",
                    }
                )
            return hits

        n_results = min(top_n, max(collection.count(), 1))
        result = collection.query(
            query_embeddings=[query_embedding],
            n_results=n_results,
            include=["documents", "metadatas", "distances"],
        )
        hits = []
        ids = (result.get("ids") or [[]])[0]
        docs = (result.get("documents") or [[]])[0]
        metas = (result.get("metadatas") or [[]])[0]
        dists = (result.get("distances") or [[]])[0]
        for rank, (pid, doc, meta, dist) in enumerate(
            zip(ids, docs, metas, dists), start=1
        ):
            similarity = 1.0 - float(dist) if dist is not None else 0.0
            hits.append(
                {
                    "place_id": pid,
                    "document": doc,
                    "metadata": meta or {},
                    "rank": rank,
                    "score": similarity,
                    "source": "vector",
                }
            )
        return hits

    def iter_documents_for_bm25(self) -> list[dict[str, Any]]:
        if not self.is_ready():
            return []
        chroma = chromadb.PersistentClient(path=str(chroma_dir()))
        collection = chroma.get_collection(COLLECTION_NAME)
        got = collection.get(include=["documents", "metadatas"])
        ids = list(got.get("ids") or [])
        docs = list(got.get("documents") or [])
        metas = list(got.get("metadatas") or [])
        rows = []
        for i, pid in enumerate(ids):
            rows.append(
                {
                    "place_id": pid,
                    "document_text": docs[i] if i < len(docs) else "",
                    "metadata": metas[i] if i < len(metas) else {},
                }
            )
        return rows


def _cosine(a: list[float], b: list[float]) -> float:
    dot = na = nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0 or nb <= 0:
        return 0.0
    return dot / ((na**0.5) * (nb**0.5))
