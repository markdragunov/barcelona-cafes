"""Shared text helpers so BM25 indexing and search tokenize identically."""

from __future__ import annotations

import re

_TOKEN_RE = re.compile(r"[a-z0-9àáâãäåæçèéêëìíîïñòóôõöùúûüýÿ]+")


def tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall((text or "").lower())
