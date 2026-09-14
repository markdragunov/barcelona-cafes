"""Embedding request batching."""

from __future__ import annotations

import unittest

from rag.stores.embeddings import iter_embedding_batches


class EmbeddingBatchTests(unittest.TestCase):
    def test_keeps_short_texts_together(self) -> None:
        batches = iter_embedding_batches(["alpha", "beta", "gamma"])
        self.assertEqual(batches, [["alpha", "beta", "gamma"]])

    def test_splits_when_token_budget_would_overflow(self) -> None:
        huge = "x" * 24_000
        batches = iter_embedding_batches([huge, huge])
        self.assertEqual(len(batches), 2)
        self.assertEqual([len(batch) for batch in batches], [1, 1])


if __name__ == "__main__":
    unittest.main()
