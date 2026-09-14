"""Long-lived JSON-lines worker so Node does not cold-start Python per search."""

from __future__ import annotations

import json
import os
import sys
import traceback
from typing import Any


def _reply(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _require_api_key(explicit: str | None) -> str:
    key = (explicit or os.environ.get("OPENAI_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("OpenAI API key is required")
    return key


def _google_api_key() -> str:
    return (
        os.environ.get("GOOGLE_PLACES_API_KEY")
        or os.environ.get("GOOGLE_API_KEY")
        or ""
    ).strip()


def handle_request(req: dict[str, Any]) -> dict[str, Any]:
    command = req.get("command")
    req_id = req.get("id")

    if command == "ping":
        return {"id": req_id, "ok": True, "pong": True}

    if command == "status":
        from .index import index_status

        return {"id": req_id, "ok": True, **index_status()}

    if command == "index":
        from .index import rebuild_indexes

        result = rebuild_indexes(_require_api_key(req.get("api_key") or ""))
        return {"id": req_id, "ok": True, **result}

    if command == "search":
        from .search import hybrid_search_and_answer

        result = hybrid_search_and_answer(
            openai_api_key=_require_api_key(req.get("api_key") or ""),
            query=str(req.get("query") or ""),
            top_n=int(req.get("top_n") or 5),
            google_api_key=_google_api_key(),
        )
        return {"id": req_id, "ok": True, **result}

    return {"id": req_id, "ok": False, "error": f"Unknown command: {command}"}


def run_worker() -> None:
    # Import the heavy stack once so the first search is not a cold start.
    from .index import index_status  # noqa: F401
    from .search import hybrid_search_and_answer  # noqa: F401

    _reply({"ok": True, "event": "ready"})
    while True:
        line = sys.stdin.readline()
        if line == "":
            break
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError("worker request must be a JSON object")
            req_id = req.get("id")
            _reply(handle_request(req))
        except SystemExit as exc:
            _reply(
                {
                    "id": req_id,
                    "ok": False,
                    "error": str(exc) or "RAG command failed",
                }
            )
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            _reply({"id": req_id, "ok": False, "error": str(exc)})
