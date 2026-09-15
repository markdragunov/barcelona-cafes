"""Fill missing cafe coordinates from the repository."""

from __future__ import annotations

import unittest
from unittest import mock

from rag.search import _hydrate_coordinates


class HydrateCoordinatesTests(unittest.TestCase):
    def test_fills_missing_lat_lng_from_repository(self) -> None:
        results = [{"place_id": "p1", "name": "Nomad", "latitude": None, "longitude": None}]
        with mock.patch(
            "rag.search.get_repository",
            return_value=mock.Mock(
                list_cafe_coordinates=lambda **_kwargs: [
                    {"place_id": "p1", "latitude": 41.385, "longitude": 2.173}
                ]
            ),
        ):
            out = _hydrate_coordinates(results)
        self.assertEqual(out[0]["latitude"], 41.385)
        self.assertEqual(out[0]["longitude"], 2.173)

    def test_skips_lookup_when_coords_already_present(self) -> None:
        results = [{"place_id": "p1", "latitude": 41.4, "longitude": 2.17}]
        with mock.patch("rag.search.get_repository") as repo:
            out = _hydrate_coordinates(results)
        repo.assert_not_called()
        self.assertEqual(out[0]["latitude"], 41.4)


if __name__ == "__main__":
    unittest.main()
