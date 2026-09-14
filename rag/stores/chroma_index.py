"""ChromaDB IndexStore adapter (local)."""

from __future__ import annotations

import gc
import shutil
from pathlib import Path
from typing import Any

import chromadb
import numpy as np
from openai import OpenAI

from ..bm25_cache import clear_cache, rebuild_from_rows
from ..paths import COLLECTION_NAME, chroma_dir, data_dir
from .embeddings import embed_batch


def _replace_dir(src: Path, dest: Path) -> None:
    """Swap dest to src; restore dest if the rename fails."""
    backup = dest.with_name(dest.name + ".bak")
    if backup.exists():
        shutil.rmtree(backup)
    dest_existed = dest.exists()
    if dest_existed:
        dest.rename(backup)
    try:
        src.rename(dest)
    except Exception:
        if dest_existed and backup.exists() and not dest.exists():
            backup.rename(dest)
        raise
    if backup.exists():
        shutil.rmtree(backup, ignore_errors=True)


def _write_chroma_collection(
    target: Path, documents: list[dict[str, Any]], embeddings: list[Any]
) -> None:
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    chroma = chromadb.PersistentClient(path=str(target))
    collection = chroma.create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )
    ids = [d["place_id"] for d in documents]
    metadatas = [d["metadata"] for d in documents]
    texts = [d["document"] for d in documents]
    batch_size = 100
    for i in range(0, len(ids), batch_size):
        collection.add(
            ids=ids[i : i + batch_size],
            documents=texts[i : i + batch_size],
            embeddings=embeddings[i : i + batch_size],
            metadatas=metadatas[i : i + batch_size],
        )
    del collection
    del chroma
    gc.collect()


def _existing_chroma_embeddings(chroma_path: Path) -> tuple[dict[str, str], dict[str, list[float]]]:
    hashes: dict[str, str] = {}
    embeddings: dict[str, list[float]] = {}
    if not chroma_path.exists():
        return hashes, embeddings
    try:
        chroma = chromadb.PersistentClient(path=str(chroma_path))
        collection = chroma.get_collection(COLLECTION_NAME)
        got = collection.get(include=["embeddings", "metadatas"])
        ids = list(got.get("ids") or [])
        metas = list(got.get("metadatas") or [])
        embs = list(got.get("embeddings") or [])
        for i, pid in enumerate(ids):
            meta = metas[i] if i < len(metas) and isinstance(metas[i], dict) else {}
            hashed = meta.get("content_hash")
            if isinstance(hashed, str) and hashed:
                hashes[pid] = hashed
            emb = embs[i] if i < len(embs) else None
            if emb is None:
                continue
            if hasattr(emb, "tolist"):
                emb = emb.tolist()
            try:
                embeddings[pid] = [float(x) for x in emb]
            except (TypeError, ValueError):
                continue
    except Exception:
        return {}, {}
    return hashes, embeddings


def _reuse_or_embed(
    client: OpenAI, documents: list[dict[str, Any]], chroma_path: Path
) -> tuple[list[Any], int]:
    existing_hash, existing_emb = _existing_chroma_embeddings(chroma_path)
    embeddings: list[Any] = [None] * len(documents)
    to_embed_idx: list[int] = []
    to_embed_texts: list[str] = []
    for i, doc in enumerate(documents):
        pid = doc["place_id"]
        hashed = doc.get("content_hash")
        if (
            hashed
            and existing_hash.get(pid) == hashed
            and pid in existing_emb
        ):
            embeddings[i] = existing_emb[pid]
        else:
            to_embed_idx.append(i)
            to_embed_texts.append(doc["document"])
    new_vecs = embed_batch(client, to_embed_texts) if to_embed_texts else []
    for i, vec in zip(to_embed_idx, new_vecs):
        embeddings[i] = vec
    return embeddings, len(to_embed_idx)


class ChromaIndexStore:
    backend = "chroma"

    def rebuild(self, openai_api_key: str, documents: list[dict[str, Any]]) -> dict[str, Any]:
        if not documents:
            raise RuntimeError("No indexable cafes found for Chroma rebuild.")

        data = data_dir()
        chroma_path = chroma_dir()
        staging = chroma_path.with_name(chroma_path.name + ".staging")
        data.mkdir(parents=True, exist_ok=True)

        client = OpenAI(api_key=openai_api_key)
        embeddings, embedded = _reuse_or_embed(client, documents, chroma_path)

        try:
            _write_chroma_collection(staging, documents, embeddings)
            _replace_dir(staging, chroma_path)
        except Exception:
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
            raise

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
        return {
            "indexed": len(documents),
            "embedded": embedded,
            "backend": self.backend,
        }

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
            raw_embs = list(got.get("embeddings") or [])
            vecs: list[list[float]] = []
            keep: list[int] = []
            for i, emb in enumerate(raw_embs):
                if emb is None:
                    continue
                if hasattr(emb, "tolist"):
                    emb = emb.tolist()
                try:
                    vecs.append([float(x) for x in emb])
                except (TypeError, ValueError):
                    continue
                keep.append(i)
            scores = _cosine_scores(query_embedding, vecs)
            scored = sorted(
                zip(scores, keep), key=lambda item: item[0], reverse=True
            )
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


def _cosine_scores(query: list[float], embs: list[list[float]]) -> list[float]:
    if not embs:
        return []
    q = np.asarray(query, dtype=np.float64)
    mat = np.asarray(embs, dtype=np.float64)
    if mat.ndim == 1:
        mat = mat.reshape(1, -1)
    qn = float(np.linalg.norm(q))
    nn = np.linalg.norm(mat, axis=1)
    denom = nn * (qn if qn > 0 else 1.0)
    scores = np.zeros(mat.shape[0], dtype=np.float64)
    ok = denom > 0
    scores[ok] = (mat[ok] @ q) / denom[ok]
    return scores.tolist()


def _cosine(a: list[float], b: list[float]) -> float:
    scores = _cosine_scores(a, [b])
    return float(scores[0]) if scores else 0.0
