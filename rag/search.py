"""Hybrid vector + BM25 search and grounded LLM answer."""

from __future__ import annotations

import json
import pickle
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import chromadb
from openai import OpenAI

from .paths import BM25_PATH, CHROMA_DIR, CHAT_MODEL, COLLECTION_NAME, EMBEDDING_MODEL
from .index import indexes_ready
from .location import resolve_location_filter

REASONING_PROMPT = """You help recommend Barcelona coffee shops.
Use ONLY the provided cafe data. No outside knowledge.

Return valid JSON only (no markdown), shape:
{
  "intro": "one short sentence summarizing what was found",
  "reasons": [
    {"place_id": "...", "why": "one short sentence why this cafe matches the query"}
  ]
}

Rules:
- Include a reason for every cafe in the input, using that cafe's exact place_id.
- why must be one concise sentence grounded in the cafe details.
- If nothing matches, return {"intro":"...", "reasons":[]}."""

RRF_K = 60


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9àáâãäåæçèéêëìíîïñòóôõöùúûüýÿ]+", text.lower())


def _load_bm25() -> dict[str, Any]:
    with open(BM25_PATH, "rb") as f:
        return pickle.load(f)


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0 or nb <= 0:
        return 0.0
    return dot / ((na ** 0.5) * (nb ** 0.5))


def _vector_search_filtered(
    collection: Any,
    query_emb: list[float],
    top_n: int,
    candidate_ids: list[str],
) -> list[dict[str, Any]]:
    """Rank only geo-filtered IDs by cosine similarity to the query embedding."""
    got = collection.get(
        ids=candidate_ids,
        include=["documents", "metadatas", "embeddings"],
    )
    ids = got.get("ids") or []
    docs = got.get("documents") or []
    metas = got.get("metadatas") or []
    embs = got.get("embeddings") or []

    scored: list[tuple[float, int]] = []
    for i, emb in enumerate(embs):
        if emb is None:
            continue
        scored.append((_cosine_similarity(query_emb, list(emb)), i))
    scored.sort(key=lambda x: x[0], reverse=True)

    hits: list[dict[str, Any]] = []
    for rank, (score, i) in enumerate(scored[:top_n], start=1):
        hits.append(
            {
                "place_id": ids[i],
                "document": docs[i],
                "metadata": metas[i] or {},
                "rank": rank,
                "score": float(score),
                "source": "vector",
            }
        )
    return hits


def _vector_search(
    client: OpenAI,
    query: str,
    top_n: int,
    allowed_place_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    emb = client.embeddings.create(model=EMBEDDING_MODEL, input=[query]).data[0].embedding
    chroma = chromadb.PersistentClient(path=str(CHROMA_DIR))
    collection = chroma.get_collection(COLLECTION_NAME)

    if allowed_place_ids is not None:
        if not allowed_place_ids:
            return []
        indexed_ids = set(collection.get(include=[]).get("ids") or [])
        candidate_ids = [pid for pid in allowed_place_ids if pid in indexed_ids]
        if not candidate_ids:
            return []
        return _vector_search_filtered(collection, emb, top_n, candidate_ids)

    n_results = min(top_n, max(collection.count(), 1))
    result = collection.query(
        query_embeddings=[emb],
        n_results=n_results,
        include=["documents", "metadatas", "distances"],
    )

    hits: list[dict[str, Any]] = []
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


def _bm25_search(
    query: str,
    top_n: int,
    allowed_place_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    payload = _load_bm25()
    bm25 = payload["bm25"]
    place_ids = payload["place_ids"]
    documents = payload["documents"]
    metadatas = payload["metadatas"]
    tokens = _tokenize(query)
    if not tokens:
        return []
    scores = bm25.get_scores(tokens)
    ranked = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)
    hits: list[dict[str, Any]] = []
    rank = 0
    for idx, score in ranked:
        if score <= 0:
            continue
        pid = place_ids[idx]
        if allowed_place_ids is not None and pid not in allowed_place_ids:
            continue
        rank += 1
        hits.append(
            {
                "place_id": pid,
                "document": documents[idx],
                "metadata": metadatas[idx],
                "rank": rank,
                "score": float(score),
                "source": "bm25",
            }
        )
        if rank >= top_n:
            break
    return hits


def merge_hybrid(
    vector_hits: list[dict[str, Any]],
    bm25_hits: list[dict[str, Any]],
    top_n: int,
) -> list[dict[str, Any]]:
    """Reciprocal Rank Fusion, dedupe by Places ID, keep top N."""
    fused: dict[str, dict[str, Any]] = {}

    def add(hit: dict[str, Any]) -> None:
        pid = hit["place_id"]
        rrf = 1.0 / (RRF_K + hit["rank"])
        if pid not in fused:
            fused[pid] = {
                "place_id": pid,
                "document": hit["document"],
                "metadata": hit["metadata"],
                "combined_score": 0.0,
                "vector_rank": None,
                "bm25_rank": None,
            }
        fused[pid]["combined_score"] += rrf
        if hit["source"] == "vector":
            fused[pid]["vector_rank"] = hit["rank"]
        else:
            fused[pid]["bm25_rank"] = hit["rank"]
        # Prefer non-empty document/metadata if one side is richer
        if hit.get("document"):
            fused[pid]["document"] = hit["document"]
        if hit.get("metadata"):
            fused[pid]["metadata"] = hit["metadata"]

    for hit in vector_hits:
        add(hit)
    for hit in bm25_hits:
        add(hit)

    merged = sorted(fused.values(), key=lambda x: x["combined_score"], reverse=True)
    return merged[:top_n]


def _format_context(cafes: list[dict[str, Any]]) -> str:
    blocks = []
    for i, cafe in enumerate(cafes, start=1):
        meta = cafe.get("metadata") or {}
        name = meta.get("name") or "Unknown"
        rating = meta.get("rating")
        address = meta.get("address") or ""
        website = meta.get("website") or ""
        district = meta.get("district") or ""
        # Put structured fields first so the model cannot miss them.
        header = "\n".join(
            [
                f"Cafe {i}",
                f"cafe_name: {name}",
                f"cafe_rating: {rating if rating not in (None, '') else 'unknown'}",
                f"cafe_address: {address if address else 'unknown'}",
                f"cafe_district: {district if district else 'unknown'}",
                f"cafe_website: {website if website else 'none'}",
                "details:",
                cafe.get("document") or "",
            ]
        )
        blocks.append(header)
    return "\n\n---\n\n".join(blocks)


def _format_rating(rating: Any) -> str | None:
    if rating is None or rating == "":
        return None
    try:
        return f"{float(rating):.1f}".rstrip("0").rstrip(".")
    except (TypeError, ValueError):
        return str(rating)


def _format_cafe_block(
    meta: dict[str, Any], why: str, place_id: str | None = None
) -> str:
    name = (meta.get("name") or "Unknown").strip()
    rating = _format_rating(meta.get("rating"))
    address = (meta.get("address") or "").strip()
    website = (meta.get("website") or "").strip()
    pid = (place_id or meta.get("place_id") or "").strip()
    why = (why or "Matches your search based on the available cafe data.").strip()

    line1 = f"{name} ★ {rating}" if rating else name
    # Address line: plain text only — never placeholders or links.
    line_address = address if address else "Address unavailable"

    link_parts: list[str] = []
    if pid:
        map_url = f"https://www.google.com/maps/place/?q=place_id:{pid}"
        link_parts.append(f"[map]({map_url})")
    if website:
        link_parts.append(f"[site]({website})")

    lines = [line1, why, line_address]
    if link_parts:
        lines.append(" · ".join(link_parts))
    return "\n".join(lines)


def _parse_reasons_json(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


def answer_with_llm(
    client: OpenAI, query: str, cafes: list[dict[str, Any]]
) -> str:
    if not cafes:
        return (
            "I could not find relevant cafes in the local index for that question. "
            "Try re-indexing or broadening the query."
        )

    context = _format_context(cafes)
    user_content = (
        f"User question:\n{query}\n\n"
        f"Cafe data (use only this):\n{context}\n\n"
        "Return JSON with intro + one why sentence per place_id."
    )
    resp = client.chat.completions.create(
        model=CHAT_MODEL,
        temperature=0.2,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": REASONING_PROMPT},
            {"role": "user", "content": user_content},
        ],
    )
    raw = (resp.choices[0].message.content or "").strip()

    reasons_by_id: dict[str, str] = {}
    intro = "Here are matching coffee shops from the local data:"
    try:
        parsed = _parse_reasons_json(raw)
        if isinstance(parsed.get("intro"), str) and parsed["intro"].strip():
            intro = parsed["intro"].strip()
        for item in parsed.get("reasons") or []:
            if not isinstance(item, dict):
                continue
            pid = str(item.get("place_id") or "").strip()
            why = str(item.get("why") or "").strip()
            if pid and why:
                reasons_by_id[pid] = why
    except (json.JSONDecodeError, TypeError, ValueError):
        # Fall back to generic reasons; names/addresses still come from metadata.
        pass

    blocks = [
        _format_cafe_block(
            cafe.get("metadata") or {},
            reasons_by_id.get(cafe["place_id"], ""),
            cafe.get("place_id"),
        )
        for cafe in cafes
    ]
    return intro + "\n\n" + "\n\n".join(blocks)


def hybrid_search_and_answer(
    openai_api_key: str,
    query: str,
    top_n: int = 5,
    google_api_key: str | None = None,
) -> dict[str, Any]:
    query = (query or "").strip()
    if not query:
        raise ValueError("Query is required")
    top_n = max(1, min(20, int(top_n)))

    if not indexes_ready():
        raise RuntimeError('Indexes not ready. Click "Index cafes" first.')

    client = OpenAI(api_key=openai_api_key)

    location_info = resolve_location_filter(client, google_api_key or "", query)
    allowed: set[str] | None = None
    if location_info["applied"]:
        place_ids = location_info.get("place_ids") or []
        if not place_ids:
            loc = location_info.get("location") or "that location"
            return {
                "answer": (
                    f"I couldn't find cafes within 1 km of {loc} "
                    "in the local database."
                ),
                "top_n": top_n,
                "results": [],
                "vector_count": 0,
                "bm25_count": 0,
                "location": {
                    "applied": True,
                    "location": location_info.get("location"),
                    "location_type": location_info.get("location_type"),
                    "coordinates": location_info.get("coordinates"),
                    "radius_km": location_info.get("radius_km"),
                    "cafe_count": 0,
                },
            }
        allowed = set(place_ids)

    with ThreadPoolExecutor(max_workers=2) as pool:
        vector_future = pool.submit(
            _vector_search, client, query, top_n, allowed
        )
        bm25_future = pool.submit(_bm25_search, query, top_n, allowed)
        vector_hits = vector_future.result()
        bm25_hits = bm25_future.result()
    merged = merge_hybrid(vector_hits, bm25_hits, top_n)
    answer = answer_with_llm(client, query, merged)

    return {
        "answer": answer,
        "top_n": top_n,
        "results": [
            {
                "place_id": c["place_id"],
                "name": (c.get("metadata") or {}).get("name"),
                "address": (c.get("metadata") or {}).get("address"),
                "rating": (c.get("metadata") or {}).get("rating"),
                "district": (c.get("metadata") or {}).get("district"),
                "website": (c.get("metadata") or {}).get("website"),
                "combined_score": c["combined_score"],
                "vector_rank": c["vector_rank"],
                "bm25_rank": c["bm25_rank"],
            }
            for c in merged
        ],
        "vector_count": len(vector_hits),
        "bm25_count": len(bm25_hits),
        "location": {
            "applied": bool(location_info.get("applied")),
            "location": location_info.get("location"),
            "location_type": location_info.get("location_type"),
            "coordinates": location_info.get("coordinates"),
            "radius_km": location_info.get("radius_km"),
            "cafe_count": location_info.get("cafe_count"),
        },
    }
