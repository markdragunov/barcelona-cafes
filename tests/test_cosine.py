"""Numpy cosine scoring for the Chroma geo-filter path."""

from __future__ import annotations

import unittest

from rag.stores.chroma_index import _cosine, _cosine_scores


class CosineTests(unittest.TestCase):
    def test_identical_vectors_score_one(self) -> None:
        vec = [1.0, 0.0, 0.0]
        self.assertAlmostEqual(_cosine(vec, vec), 1.0, places=6)

    def test_orthogonal_vectors_score_zero(self) -> None:
        self.assertAlmostEqual(_cosine([1.0, 0.0], [0.0, 1.0]), 0.0, places=6)

    def test_batch_matches_pairwise(self) -> None:
        query = [0.2, 0.5, 0.8]
        embs = [[0.2, 0.5, 0.8], [0.8, 0.1, 0.0], [0.0, 0.0, 0.0]]
        batched = _cosine_scores(query, embs)
        pairwise = [_cosine(query, row) for row in embs]
        for left, right in zip(batched, pairwise):
            self.assertAlmostEqual(left, right, places=6)


if __name__ == "__main__":
    unittest.main()
