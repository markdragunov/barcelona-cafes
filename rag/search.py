"""Hybrid vector + in-memory BM25 search and grounded LLM answer."""

from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from openai import OpenAI

from .bm25_cache import get_cache
from .index import indexes_ready
from .location import resolve_location_filter
from .paths import CHAT_MODEL, EMBEDDING_MODEL
from .stores.factory import get_index_store, get_repository

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


def _vector_search(
    client: OpenAI,
    query: str,
    top_n: int,
    allowed_place_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    emb = client.embeddings.create(model=EMBEDDING_MODEL, input=[query]).data[0].embedding
    return get_index_store().vector_search(emb, top_n, allowed_place_ids)


def _bm25_search(
    query: str,
    top_n: int,
    allowed_place_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    payload = get_cache()
    bm25 = payload["bm25"]
    place_ids = payload["place_ids"]
    documents = payload["documents"]
    metadatas = payload["metadatas"]
    if not place_ids:
        return []
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


def recommend_cafes(
    client: OpenAI, query: str, cafes: list[dict[str, Any]]
) -> dict[str, Any]:
    if not cafes:
        intro = (
            "I could not find relevant cafes in the local index for that question. "
            "Try re-indexing or broadening the query."
        )
        return {"intro": intro, "reasons_by_id": {}, "answer": intro}

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
        pass

    blocks = [
        _format_cafe_block(
            cafe.get("metadata") or {},
            reasons_by_id.get(cafe["place_id"], ""),
            cafe.get("place_id"),
        )
        for cafe in cafes
    ]
    return {
        "intro": intro,
        "reasons_by_id": reasons_by_id,
        "answer": intro + "\n\n" + "\n\n".join(blocks),
    }


def answer_with_llm(
    client: OpenAI, query: str, cafes: list[dict[str, Any]]
) -> str:
    return recommend_cafes(client, query, cafes)["answer"]


def _hydrate_coordinates(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fill missing lat/lng from the cafe table so old indexes still map."""
    if not results or all(
        row.get("latitude") is not None and row.get("longitude") is not None
        for row in results
    ):
        return results
    try:
        rows = get_repository().list_cafe_coordinates()
    except Exception:
        return results
    by_id = {row["place_id"]: row for row in rows}
    for row in results:
        extra = by_id.get(row.get("place_id"))
        if not extra:
            continue
        if row.get("latitude") is None:
            row["latitude"] = extra.get("latitude")
        if row.get("longitude") is None:
            row["longitude"] = extra.get("longitude")
    return results


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

    location_info = resolve_location_filter(google_api_key or "", query)
    allowed: set[str] | None = None
    if location_info["applied"]:
        place_ids = location_info.get("place_ids") or []
        if not place_ids:
            loc = location_info.get("location") or "that location"
            return {
                "answer": (
                    f"I couldn't find cafes within 1 km of {loc} "
                    "in the local database. Try a broader area."
                ),
                "intro": (
                    f"I couldn't find cafes within 1 km of {loc} "
                    "in the local database. Try a broader area."
                ),
                "top_n": top_n,
                "results": [],
                "vector_count": 0,
                "bm25_count": 0,
                "location": {
                    "applied": True,
                    "requested": True,
                    "location": location_info.get("location"),
                    "location_type": location_info.get("location_type"),
                    "coordinates": location_info.get("coordinates"),
                    "radius_km": location_info.get("radius_km"),
                    "cafe_count": 0,
                    "source": location_info.get("source"),
                    "notice": None,
                },
            }
        allowed = set(place_ids)

    with ThreadPoolExecutor(max_workers=2) as pool:
        fut_v = pool.submit(_vector_search, client, query, top_n * 2, allowed)
        fut_b = pool.submit(_bm25_search, query, top_n * 2, allowed)
        vector_hits = fut_v.result()
        bm25_hits = fut_b.result()

    merged = merge_hybrid(vector_hits, bm25_hits, top_n)
    recommendation = recommend_cafes(client, query, merged)
    reasons_by_id = recommendation.get("reasons_by_id") or {}

    payload: dict[str, Any] = {
        "answer": recommendation["answer"],
        "intro": recommendation.get("intro") or "",
        "top_n": top_n,
        "results": [
            {
                "place_id": c["place_id"],
                "name": (c.get("metadata") or {}).get("name"),
                "address": (c.get("metadata") or {}).get("address"),
                "rating": (c.get("metadata") or {}).get("rating"),
                "district": (c.get("metadata") or {}).get("district"),
                "website": (c.get("metadata") or {}).get("website"),
                "latitude": (c.get("metadata") or {}).get("latitude"),
                "longitude": (c.get("metadata") or {}).get("longitude"),
                "why": reasons_by_id.get(c["place_id"]) or "",
                "combined_score": c.get("combined_score"),
                "vector_rank": c.get("vector_rank"),
                "bm25_rank": c.get("bm25_rank"),
            }
            for c in merged
        ],
        "vector_count": len(vector_hits),
        "bm25_count": len(bm25_hits),
        "location": {
            "applied": bool(location_info.get("applied")),
            "requested": bool(location_info.get("requested")),
            "location": location_info.get("location"),
            "location_type": location_info.get("location_type"),
            "coordinates": location_info.get("coordinates"),
            "radius_km": location_info.get("radius_km"),
            "cafe_count": location_info.get("cafe_count"),
            "source": location_info.get("source"),
            "notice": location_info.get("notice"),
        },
    }

    payload["results"] = _hydrate_coordinates(payload["results"])

    # Server-side only: Node logs this and never forwards it to the client.
    if location_info.get("error"):
        payload["location_error"] = location_info["error"]

    return payload
