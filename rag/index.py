"""Build ChromaDB vector index and BM25 keyword index."""

from __future__ import annotations

import pickle
import re
import shutil
import time
from typing import Any

import chromadb
from openai import OpenAI, RateLimitError
from rank_bm25 import BM25Okapi

from .documents import load_cafe_documents
from .paths import BM25_PATH, CHROMA_DIR, COLLECTION_NAME, DATA_DIR, EMBEDDING_MODEL

# text-embedding-3-small max ~8192 tokens/input; org TPM often 40k.
# Stay well under both limits.
MAX_CHARS_PER_DOC = 24_000  # ~6k tokens
MAX_TOKENS_PER_REQUEST = 12_000
BATCH_PAUSE_SEC = 2.0


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9àáâãäåæçèéêëìíîïñòóôõöùúûüýÿ]+", text.lower())


def _estimate_tokens(text: str) -> int:
    # Conservative estimate for mixed EN/ES text.
    return max(1, (len(text) + 3) // 3)


def _truncate_for_embedding(text: str) -> str:
    if len(text) <= MAX_CHARS_PER_DOC:
        return text
    return text[:MAX_CHARS_PER_DOC]


def _iter_embedding_batches(texts: list[str]) -> list[list[str]]:
    """Pack texts into TPM-safe batches (never one oversized request)."""
    batches: list[list[str]] = []
    current: list[str] = []
    current_tokens = 0

    for text in texts:
        clipped = _truncate_for_embedding(text)
        tokens = _estimate_tokens(clipped)
        # Single oversized doc: send alone (already truncated).
        if tokens > MAX_TOKENS_PER_REQUEST:
            if current:
                batches.append(current)
                current, current_tokens = [], 0
            batches.append([clipped])
            continue
        if current and current_tokens + tokens > MAX_TOKENS_PER_REQUEST:
            batches.append(current)
            current, current_tokens = [], 0
        current.append(clipped)
        current_tokens += tokens

    if current:
        batches.append(current)
    return batches


def _embed_one_batch(client: OpenAI, batch: list[str]) -> list[list[float]]:
    attempts = 0
    while True:
        attempts += 1
        try:
            resp = client.embeddings.create(model=EMBEDDING_MODEL, input=batch)
            ordered = sorted(resp.data, key=lambda x: x.index)
            return [item.embedding for item in ordered]
        except RateLimitError:
            if attempts >= 8:
                raise
            # Back off for TPM / burst limits.
            time.sleep(min(60, 3 * attempts))


def _embed_batch(client: OpenAI, texts: list[str]) -> list[list[float]]:
    vectors: list[list[float]] = []
    batches = _iter_embedding_batches(texts)
    for i, batch in enumerate(batches):
        vectors.extend(_embed_one_batch(client, batch))
        if i < len(batches) - 1:
            time.sleep(BATCH_PAUSE_SEC)
    return vectors


def rebuild_indexes(openai_api_key: str) -> dict[str, Any]:
    docs = load_cafe_documents()
    if not docs:
        raise RuntimeError(
            "No indexable cafes found. Need coffee_content and/or reviews in SQLite."
        )

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if CHROMA_DIR.exists():
        shutil.rmtree(CHROMA_DIR)
    CHROMA_DIR.mkdir(parents=True, exist_ok=True)

    client = OpenAI(api_key=openai_api_key)
    # Full docs go into Chroma/BM25; only embedding input is truncated.
    texts = [d["document"] for d in docs]
    embeddings = _embed_batch(client, texts)

    chroma = chromadb.PersistentClient(path=str(CHROMA_DIR))
    collection = chroma.create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )

    ids = [d["place_id"] for d in docs]
    metadatas = [d["metadata"] for d in docs]
    # Chroma add in batches
    batch_size = 100
    for i in range(0, len(ids), batch_size):
        collection.add(
            ids=ids[i : i + batch_size],
            documents=texts[i : i + batch_size],
            embeddings=embeddings[i : i + batch_size],
            metadatas=metadatas[i : i + batch_size],
        )

    tokenized = [_tokenize(t) for t in texts]
    bm25 = BM25Okapi(tokenized)
    payload = {
        "place_ids": ids,
        "documents": texts,
        "metadatas": metadatas,
        "tokenized": tokenized,
        "bm25": bm25,
    }
    with open(BM25_PATH, "wb") as f:
        pickle.dump(payload, f)

    return {
        "indexed": len(docs),
        "chroma_path": str(CHROMA_DIR),
        "bm25_path": str(BM25_PATH),
    }


def indexes_ready() -> bool:
    if not CHROMA_DIR.exists() or not BM25_PATH.exists():
        return False
    try:
        chroma = chromadb.PersistentClient(path=str(CHROMA_DIR))
        col = chroma.get_collection(COLLECTION_NAME)
        return col.count() > 0
    except Exception:
        return False


def index_status() -> dict[str, Any]:
    ready = indexes_ready()
    count = 0
    if ready:
        chroma = chromadb.PersistentClient(path=str(CHROMA_DIR))
        count = chroma.get_collection(COLLECTION_NAME).count()
    return {
        "ready": ready,
        "document_count": count,
        "chroma_path": str(CHROMA_DIR),
        "bm25_path": str(BM25_PATH),
    }
