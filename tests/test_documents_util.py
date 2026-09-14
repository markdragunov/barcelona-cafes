"""Document metadata used by the search index."""

from __future__ import annotations

import unittest

from rag.core.documents_util import assemble_documents, cafe_metadata


class CafeMetadataTests(unittest.TestCase):
    def test_includes_coordinates_when_present(self) -> None:
        meta = cafe_metadata(
            {
                "place_id": "p1",
                "name": "Nomad",
                "address": "Carrer",
                "rating": 4.6,
                "district": "El Born",
                "website": "https://ex.com",
                "latitude": 41.385,
                "longitude": 2.173,
            }
        )
        self.assertEqual(meta["latitude"], 41.385)
        self.assertEqual(meta["longitude"], 2.173)

    def test_omits_missing_coordinates_for_chroma(self) -> None:
        meta = cafe_metadata(
            {
                "place_id": "p2",
                "name": "Unknown",
                "latitude": None,
                "longitude": None,
            }
        )
        self.assertNotIn("latitude", meta)
        self.assertNotIn("longitude", meta)

    def test_assemble_documents_copies_coords_from_rows(self) -> None:
        docs = assemble_documents(
            [
                {
                    "place_id": "p1",
                    "name": "Syra",
                    "address": "Addr",
                    "rating": 4.5,
                    "website": "",
                    "neighborhood_name": "Gràcia",
                    "coffee_content": "Filter coffee",
                    "latitude": "41.403",
                    "longitude": "2.155",
                }
            ],
            {},
        )
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0]["metadata"]["latitude"], 41.403)
        self.assertEqual(docs[0]["metadata"]["longitude"], 2.155)


if __name__ == "__main__":
    unittest.main()
