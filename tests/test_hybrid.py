"""RRF merge uses a wide candidate pool, then slices."""

from __future__ import annotations

import unittest

from rag.search import merge_hybrid, retrieval_pool_size


def hit(pid: str, rank: int, source: str) -> dict:
    return {
        "place_id": pid,
        "document": pid,
        "metadata": {"name": pid},
        "rank": rank,
        "score": 1.0,
        "source": source,
    }


class RetrievalPoolTests(unittest.TestCase):
    def test_overfetches_for_small_top_n(self) -> None:
        self.assertEqual(retrieval_pool_size(3), 50)
        self.assertEqual(retrieval_pool_size(5), 50)
        self.assertEqual(retrieval_pool_size(10), 100)


class MergeHybridTests(unittest.TestCase):
    def test_fusion_keeps_bm25_only_hits_that_vector_missed(self) -> None:
        vector = [hit("a", 1, "vector"), hit("b", 2, "vector")]
        bm25 = [hit("c", 1, "bm25"), hit("a", 2, "bm25")]
        merged = merge_hybrid(vector, bm25, top_n=2)
        ids = [row["place_id"] for row in merged]
        self.assertEqual(len(ids), 2)
        self.assertIn("a", ids)

    def test_final_slice_is_top_n_after_wide_fusion(self) -> None:
        vector = [hit(f"v{i}", i + 1, "vector") for i in range(20)]
        bm25 = [hit(f"b{i}", i + 1, "bm25") for i in range(20)]
        merged = merge_hybrid(vector, bm25, top_n=3)
        self.assertEqual(len(merged), 3)


if __name__ == "__main__":
    unittest.main()
