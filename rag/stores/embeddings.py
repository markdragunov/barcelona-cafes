"""OpenAI embedding batch helpers shared by IndexStore adapters."""

from __future__ import annotations

import time
from typing import Any

from openai import OpenAI, RateLimitError

from ..paths import EMBEDDING_MODEL

MAX_CHARS_PER_DOC = 24_000
MAX_TOKENS_PER_REQUEST = 12_000
BATCH_PAUSE_SEC = 2.0


def estimate_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 3)


def truncate_for_embedding(text: str) -> str:
    if len(text) <= MAX_CHARS_PER_DOC:
        return text
    return text[:MAX_CHARS_PER_DOC]


def iter_embedding_batches(texts: list[str]) -> list[list[str]]:
    batches: list[list[str]] = []
    current: list[str] = []
    current_tokens = 0
    for text in texts:
        clipped = truncate_for_embedding(text)
        tokens = estimate_tokens(clipped)
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


def embed_batch(client: OpenAI, texts: list[str]) -> list[list[float]]:
    vectors: list[list[float]] = []
    batches = iter_embedding_batches(texts)
    for i, batch in enumerate(batches):
        attempts = 0
        while True:
            attempts += 1
            try:
                resp = client.embeddings.create(model=EMBEDDING_MODEL, input=batch)
                ordered = sorted(resp.data, key=lambda x: x.index)
                vectors.extend(item.embedding for item in ordered)
                break
            except RateLimitError:
                if attempts >= 8:
                    raise
                time.sleep(min(60, 3 * attempts))
        if i < len(batches) - 1:
            time.sleep(BATCH_PAUSE_SEC)
    return vectors


def vector_literal(embedding: list[float]) -> str:
    return "[" + ",".join(f"{x:.8f}" for x in embedding) + "]"
