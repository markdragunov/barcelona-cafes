"""Shared BM25 tokenization."""

from __future__ import annotations

import unittest

from rag.text import tokenize


class TokenizeTests(unittest.TestCase):
    def test_lowercases_and_keeps_accents(self) -> None:
        self.assertEqual(tokenize("Gràcia Coffee"), ["gràcia", "coffee"])

    def test_empty(self) -> None:
        self.assertEqual(tokenize(""), [])
        self.assertEqual(tokenize(None), [])  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
