"""CLI bridge for the Node admin server. Speaks JSON on stdout."""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback


def _ok(payload: dict) -> None:
    print(json.dumps({"ok": True, **payload}, ensure_ascii=False))


def _err(message: str, code: int = 1) -> None:
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    raise SystemExit(code)


def _require_api_key(explicit: str | None) -> str:
    key = (explicit or os.environ.get("OPENAI_API_KEY") or "").strip()
    if not key:
        _err("OpenAI API key is required")
    return key


def _google_api_key() -> str:
    return (os.environ.get("GOOGLE_API_KEY") or "").strip()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="rag")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("status")

    p_index = sub.add_parser("index")
    p_index.add_argument("--api-key", default="")

    p_search = sub.add_parser("search")
    p_search.add_argument("--api-key", default="")
    p_search.add_argument("--query", required=True)
    p_search.add_argument("--top-n", type=int, default=5)

    args = parser.parse_args(argv)

    try:
        if args.command == "status":
            from .index import index_status

            _ok(index_status())
            return

        if args.command == "index":
            from .index import rebuild_indexes

            result = rebuild_indexes(_require_api_key(args.api_key))
            _ok(result)
            return

        if args.command == "search":
            from .search import hybrid_search_and_answer

            result = hybrid_search_and_answer(
                openai_api_key=_require_api_key(args.api_key),
                query=args.query,
                top_n=args.top_n,
                google_api_key=_google_api_key(),
            )
            _ok(result)
            return

        _err(f"Unknown command: {args.command}")
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        _err(str(exc))


if __name__ == "__main__":
    main()
