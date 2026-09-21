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


class FormatContextTests(unittest.TestCase):
    def test_long_documents_are_clipped(self) -> None:
        from rag.search import _format_context

        ctx = _format_context(
            [{"document": "review " * 800, "metadata": {"name": "Long Cafe"}}]
        )
        self.assertLess(len(ctx), 1600)
        self.assertIn("…", ctx)


class HybridPipelineTests(unittest.TestCase):
    def test_drops_low_ratings_and_llm_omissions(self) -> None:
        from unittest import mock

        from rag import search as search_mod

        low = {
            "place_id": "low",
            "document": "specialty",
            "metadata": {"name": "Low", "rating": 3.7, "latitude": 41.38, "longitude": 2.17},
            "rank": 1,
            "score": 1.0,
            "source": "vector",
        }
        bakery = {
            "place_id": "bakery",
            "document": "pastries",
            "metadata": {"name": "Bakery", "rating": 4.6, "latitude": 41.38, "longitude": 2.17},
            "rank": 2,
            "score": 1.0,
            "source": "vector",
        }
        work = {
            "place_id": "work",
            "document": "laptop wifi",
            "metadata": {"name": "Work", "rating": 4.5, "latitude": 41.38, "longitude": 2.17},
            "rank": 3,
            "score": 1.0,
            "source": "vector",
        }

        def fake_recommend(_client, _query, cafes):
            ids = [c["place_id"] for c in cafes]
            self.assertNotIn("low", ids)
            self.assertIn("bakery", ids)
            self.assertIn("work", ids)
            return {
                "intro": "A laptop-friendly specialty cafe.",
                "reasons_by_id": {"work": "Has tables, wifi, and specialty coffee."},
                "answer": "A laptop-friendly specialty cafe.",
                "parsed_ok": True,
            }

        with mock.patch.object(search_mod, "indexes_ready", return_value=True), mock.patch.object(
            search_mod, "resolve_location_filter",
            return_value={"applied": False, "requested": True, "location": "Center"},
        ), mock.patch.object(
            search_mod, "_embed_query", return_value=[0.0]
        ), mock.patch.object(
            search_mod, "_vector_search", return_value=[low, bakery, work]
        ), mock.patch.object(
            search_mod, "_bm25_search", return_value=[]
        ), mock.patch.object(
            search_mod, "recommend_cafes", side_effect=fake_recommend
        ), mock.patch.object(
            search_mod, "_hydrate_coordinates", side_effect=lambda rows: rows
        ):
            payload = search_mod.hybrid_search_and_answer(
                "sk-test",
                "cozy place to work in center areas of barcelona "
                "with specialty coffe and >= 4 rating",
                top_n=5,
            )

        ids = [row["place_id"] for row in payload["results"]]
        self.assertEqual(ids, ["work"])
        self.assertEqual(payload["results"][0]["rating"], 4.5)


if __name__ == "__main__":
    unittest.main()
