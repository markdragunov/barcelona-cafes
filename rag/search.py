"""Hybrid vector + in-memory BM25 search and grounded LLM answer."""

from __future__ import annotations

import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from openai import OpenAI

from .constraints import apply_min_rating, apply_reason_keep, parse_constraints
from .index import indexes_ready
from .location import resolve_location_filter
from .paths import CHAT_MODEL, EMBEDDING_MODEL
from .stores.factory import get_index_store, get_repository
from .text import clip_document, tokenize

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
- Only include a reason for cafes that actually match the user's constraints.
- Use that cafe's exact place_id.
- If the user wants a place to work / laptop-friendly, omit cafes whose details do not support working (no laptop, wifi, workspace, or they are clearly a bakery, takeaway, or party spot).
- If the user wants specialty coffee, omit cafes with no specialty / third-wave / filter evidence in the details.
- why must be one concise sentence grounded in the cafe details.
- Returning fewer reasons than cafes — or {"intro":"...","reasons":[]} — is correct when nothing fits."""

RRF_K = 60


def retrieval_pool_size(top_n: int) -> int:
    """Retrievers over-fetch so RRF can fuse wide lists before the final slice."""
    return max(50, int(top_n) * 10)


def _embed_query(client: OpenAI, query: str) -> list[float]:
    return client.embeddings.create(model=EMBEDDING_MODEL, input=[query]).data[0].embedding


def _vector_search(
    query_embedding: list[float],
    top_n: int,
    allowed_place_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    return get_index_store().vector_search(query_embedding, top_n, allowed_place_ids)


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
    tokens = tokenize(query)
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
                clip_document(cafe.get("document") or ""),
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
        return {
            "intro": intro,
            "reasons_by_id": {},
            "answer": intro,
            "parsed_ok": True,
        }

    constraints = parse_constraints(query)
    constraint_lines = []
    if constraints["min_rating"] is not None:
        constraint_lines.append(
            f"- minimum rating {constraints['min_rating']:g} (already applied in retrieval)"
        )
    if constraints["needs_work"]:
        constraint_lines.append(
            "- place to work / laptop-friendly: omit cafes whose details do not support this"
        )
    if constraints["needs_specialty"]:
        constraint_lines.append(
            "- specialty coffee: omit cafes without specialty evidence in the details"
        )
    constraint_block = (
        "Constraints:\n" + "\n".join(constraint_lines) + "\n\n"
        if constraint_lines
        else ""
    )

    context = _format_context(cafes)
    user_content = (
        f"User question:\n{query}\n\n"
        f"{constraint_block}"
        f"Cafe data (use only this):\n{context}\n\n"
        "Return JSON with intro + why sentences only for cafes that match."
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
    usage = getattr(resp, "usage", None)
    if usage is not None:
        print(
            json.dumps(
                {
                    "msg": "openai_chat_usage",
                    "model": CHAT_MODEL,
                    "cafes": len(cafes),
                    "prompt_tokens": getattr(usage, "prompt_tokens", None),
                    "completion_tokens": getattr(usage, "completion_tokens", None),
                    "total_tokens": getattr(usage, "total_tokens", None),
                }
            ),
            file=sys.stderr,
            flush=True,
        )
    raw = (resp.choices[0].message.content or "").strip()

    reasons_by_id: dict[str, str] = {}
    intro = "Here are matching coffee shops from the local data:"
    parsed_ok = False
    try:
        parsed = _parse_reasons_json(raw)
        parsed_ok = True
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
        parsed_ok = False

    kept = apply_reason_keep(cafes, reasons_by_id, parsed_ok)
    if parsed_ok and not kept:
        if not (isinstance(intro, str) and intro.strip()):
            intro = "Nothing in the guide matches those constraints."
        usage_payload = None
        if usage is not None:
            usage_payload = {
                "prompt_tokens": getattr(usage, "prompt_tokens", None),
                "completion_tokens": getattr(usage, "completion_tokens", None),
                "total_tokens": getattr(usage, "total_tokens", None),
            }
        return {
            "intro": intro,
            "reasons_by_id": {},
            "answer": intro,
            "usage": usage_payload,
            "parsed_ok": True,
        }

    blocks = [
        _format_cafe_block(
            cafe.get("metadata") or {},
            reasons_by_id.get(cafe["place_id"], ""),
            cafe.get("place_id"),
        )
        for cafe in kept
    ]
    usage_payload = None
    if usage is not None:
        usage_payload = {
            "prompt_tokens": getattr(usage, "prompt_tokens", None),
            "completion_tokens": getattr(usage, "completion_tokens", None),
            "total_tokens": getattr(usage, "total_tokens", None),
        }
    return {
        "intro": intro,
        "reasons_by_id": {
            cafe["place_id"]: reasons_by_id[cafe["place_id"]]
            for cafe in kept
            if cafe.get("place_id") in reasons_by_id
        },
        "answer": intro + "\n\n" + "\n\n".join(blocks) if blocks else intro,
        "usage": usage_payload,
        "parsed_ok": parsed_ok,
    }


def answer_with_llm(
    client: OpenAI, query: str, cafes: list[dict[str, Any]]
) -> str:
    return recommend_cafes(client, query, cafes)["answer"]


def _hydrate_coordinates(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fill missing lat/lng from the cafe table so old indexes still map."""
    missing_ids = [
        row.get("place_id")
        for row in results
        if row.get("place_id")
        and (row.get("latitude") is None or row.get("longitude") is None)
    ]
    if not results or not missing_ids:
        return results
    try:
        rows = get_repository().list_cafe_coordinates(place_ids=missing_ids)
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

    with ThreadPoolExecutor(max_workers=2) as pool:
        fut_loc = pool.submit(resolve_location_filter, google_api_key or "", query)
        fut_emb = pool.submit(_embed_query, client, query)
        location_info = fut_loc.result()
        query_emb = fut_emb.result()

    allowed: set[str] | None = None
    if location_info["applied"]:
        place_ids = location_info.get("place_ids") or []
        if place_ids:
            allowed = set(place_ids)

    retrieve_n = retrieval_pool_size(top_n)

    with ThreadPoolExecutor(max_workers=2) as pool:
        fut_v = pool.submit(_vector_search, query_emb, retrieve_n, allowed)
        fut_b = pool.submit(_bm25_search, query, retrieve_n, allowed)
        vector_hits = fut_v.result()
        bm25_hits = fut_b.result()

    constraints = parse_constraints(query)
    merged_wide = merge_hybrid(vector_hits, bm25_hits, retrieve_n)
    merged = apply_min_rating(merged_wide, constraints["min_rating"], top_n)
    recommendation = recommend_cafes(client, query, merged)
    reasons_by_id = recommendation.get("reasons_by_id") or {}
    shown = apply_reason_keep(
        merged, reasons_by_id, bool(recommendation.get("parsed_ok"))
    )

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
            for c in shown
        ],
        "vector_count": len(vector_hits),
        "bm25_count": len(bm25_hits),
        "usage": recommendation.get("usage"),
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
