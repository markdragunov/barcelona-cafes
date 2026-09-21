"""Query constraints: min rating and LLM omit list."""

from __future__ import annotations

import unittest

from rag.constraints import (
    apply_min_rating,
    apply_reason_keep,
    parse_constraints,
)


class ParseConstraintsTests(unittest.TestCase):
    def test_reads_min_rating_from_inequality(self) -> None:
        parsed = parse_constraints(
            "cozy place to work in center areas of barcelona "
            "with specialty coffe and >= 4 rating"
        )
        self.assertEqual(parsed["min_rating"], 4.0)
        self.assertTrue(parsed["needs_work"])
        self.assertTrue(parsed["needs_specialty"])

    def test_reads_at_least_and_plus_forms(self) -> None:
        self.assertEqual(parse_constraints("cafes at least 4.5")["min_rating"], 4.5)
        self.assertEqual(parse_constraints("espresso 4+")["min_rating"], 4.0)

    def test_no_rating_leaves_filter_off(self) -> None:
        parsed = parse_constraints("quiet specialty in Gràcia")
        self.assertIsNone(parsed["min_rating"])
        self.assertFalse(parsed["needs_work"])
        self.assertTrue(parsed["needs_specialty"])


class ApplyMinRatingTests(unittest.TestCase):
    def test_drops_below_threshold_and_missing_ratings(self) -> None:
        cafes = [
            {"place_id": "low", "metadata": {"rating": 3.7}},
            {"place_id": "ok", "metadata": {"rating": 4.2}},
            {"place_id": "none", "metadata": {}},
            {"place_id": "high", "metadata": {"rating": 4.8}},
        ]
        kept = apply_min_rating(cafes, 4.0, limit=5)
        self.assertEqual([c["place_id"] for c in kept], ["ok", "high"])

    def test_limit_applies_after_filter(self) -> None:
        cafes = [
            {"place_id": f"c{i}", "metadata": {"rating": 4.5}} for i in range(5)
        ]
        kept = apply_min_rating(cafes, 4.0, limit=2)
        self.assertEqual(len(kept), 2)


class ApplyReasonKeepTests(unittest.TestCase):
    def test_omits_cafes_without_a_reason(self) -> None:
        cafes = [{"place_id": "bakery"}, {"place_id": "work"}]
        kept = apply_reason_keep(cafes, {"work": "Has wifi and tables"}, True)
        self.assertEqual([c["place_id"] for c in kept], ["work"])

    def test_keeps_all_when_json_parse_failed(self) -> None:
        cafes = [{"place_id": "a"}, {"place_id": "b"}]
        kept = apply_reason_keep(cafes, {}, False)
        self.assertEqual(len(kept), 2)


if __name__ == "__main__":
    unittest.main()
