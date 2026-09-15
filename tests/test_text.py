"""Shared BM25 tokenization."""

from __future__ import annotations

import unittest

from rag.text import CONTEXT_DOC_CHARS, clip_document, tokenize


class TokenizeTests(unittest.TestCase):
    def test_lowercases_and_keeps_accents(self) -> None:
        self.assertEqual(tokenize("Gràcia Coffee"), ["gràcia", "coffee"])

    def test_empty(self) -> None:
        self.assertEqual(tokenize(""), [])
        self.assertEqual(tokenize(None), [])  # type: ignore[arg-type]


class ClipDocumentTests(unittest.TestCase):
    def test_short_document_unchanged(self) -> None:
        self.assertEqual(clip_document("quiet specialty"), "quiet specialty")

    def test_long_document_is_capped(self) -> None:
        clipped = clip_document("x" * 5000)
        self.assertEqual(len(clipped), CONTEXT_DOC_CHARS + 1)
        self.assertTrue(clipped.endswith("…"))


if __name__ == "__main__":
    unittest.main()
