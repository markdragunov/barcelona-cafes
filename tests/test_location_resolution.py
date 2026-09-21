"""Location resolution: shared gazetteer lookup + graceful geocoding fallback.

Run:
  python3 -m unittest tests.test_location_resolution -v
"""

from __future__ import annotations

import json
import unittest
from unittest import mock

GEOCODE_ERROR = (
    "Geocoding failed for 'Gràcia': This IP, site or mobile application is not "
    "authorized to use this API key. Request received from IP address "
    "164.90.200.60, with empty referer"
)


class GazetteerLookupTests(unittest.TestCase):
    def test_matches_accent_and_case_variants(self) -> None:
        from rag.neighborhoods import find_neighborhood

        variants = {
            "gracia": ["Gràcia", "Gracia", "gracia", "GRÀCIA", "gràcia",
                       "Vila de Gràcia", "Gracia, Barcelona"],
            "el-born": ["El Born", "born", "el born", "La Ribera", "el-born"],
            "gothic-quarter": ["Gothic Quarter", "gothic quarter",
                               "Barri Gòtic", "barri gotic", "Barrio Gótico"],
            "eixample": ["Eixample", "L'Eixample", "l'eixample", "EIXAMPLE"],
            "poblenou": ["Poblenou", "El Poblenou", "poble nou", "Poble Nou"],
        }
        for expected_id, spellings in variants.items():
            for spelling in spellings:
                with self.subTest(spelling=spelling):
                    match = find_neighborhood(spelling)
                    self.assertIsNotNone(match, f"no match for {spelling!r}")
                    self.assertEqual(match["id"], expected_id)

    def test_unknown_and_citywide_locations_do_not_match(self) -> None:
        from rag.neighborhoods import find_neighborhood

        for location in ("Unknown Place XYZ", "All Barcelona", "all-barcelona", "", "   "):
            with self.subTest(location=location):
                self.assertIsNone(find_neighborhood(location))

    def test_centroid_is_the_viewport_midpoint(self) -> None:
        from rag.neighborhoods import find_neighborhood

        centroid = find_neighborhood("Gràcia")["centroid"]
        self.assertAlmostEqual(centroid["latitude"], 41.4075, places=4)
        self.assertAlmostEqual(centroid["longitude"], 2.155, places=4)

    def test_gazetteer_matches_node_module_definitions(self) -> None:
        """shared/neighborhoods.json is the single source for both runtimes."""
        from rag.neighborhoods import GAZETTEER_PATH, load_neighborhoods

        ids = {
            n["id"]
            for n in load_neighborhoods()
            if not n.get("searchGroup")
        }
        self.assertEqual(
            ids,
            {"el-born", "eixample", "poblenou", "gracia", "gothic-quarter",
             "all-barcelona"},
        )
        js_source = (GAZETTEER_PATH.parent.parent / "src" / "neighborhoods.js").read_text()
        self.assertIn("shared", js_source)
        self.assertIn("neighborhoods.json", js_source)
        # Coordinates must not be duplicated in the JS module.
        self.assertNotIn("latitude:", js_source)


class ResolveLocationFilterTests(unittest.TestCase):
    def _resolve(self, detected, geocode):
        from rag import location as location_mod

        with mock.patch.object(
            location_mod, "extract_location", return_value=detected
        ), mock.patch.object(
            location_mod, "geocode_location", **geocode
        ) as geocode_mock, mock.patch.object(
            location_mod, "cafes_within_radius", return_value=["pid1", "pid2"]
        ):
            result = location_mod.resolve_location_filter(
                "test-key", "coffee somewhere"
            )
        return result, geocode_mock

    def test_known_neighborhood_skips_the_geocoding_api(self) -> None:
        result, geocode_mock = self._resolve(
            {"location": "Gracia", "location_type": "neighborhood"},
            {"side_effect": AssertionError("geocoding must not be called")},
        )

        geocode_mock.assert_not_called()
        self.assertTrue(result["applied"])
        self.assertEqual(result["source"], "gazetteer")
        self.assertEqual(result["cafe_count"], 2)
        self.assertAlmostEqual(result["coordinates"]["latitude"], 41.4075, places=4)
        self.assertEqual(
            result["coordinates"]["formatted_address"], "Gràcia, Barcelona, Spain"
        )

    def test_unknown_location_still_uses_geocoding(self) -> None:
        result, geocode_mock = self._resolve(
            {"location": "Carrer de Pau Claris", "location_type": "area"},
            {
                "return_value": {
                    "latitude": 41.392,
                    "longitude": 2.165,
                    "formatted_address": "Carrer de Pau Claris, Barcelona, Spain",
                    "query": "Carrer de Pau Claris",
                }
            },
        )

        geocode_mock.assert_called_once()
        self.assertTrue(result["applied"])
        self.assertEqual(result["source"], "geocode")

    def test_geocoding_failure_degrades_instead_of_raising(self) -> None:
        result, _ = self._resolve(
            {"location": "Carrer de Pau Claris", "location_type": "area"},
            {"side_effect": RuntimeError(GEOCODE_ERROR)},
        )

        self.assertFalse(result["applied"])
        self.assertTrue(result["requested"])
        self.assertIsNone(result["place_ids"])
        self.assertIn("all of Barcelona", result["notice"])
        self.assertNotIn("164.90.200.60", result["notice"])
        self.assertIn("164.90.200.60", result["error"])

    def test_no_location_in_query(self) -> None:
        result, geocode_mock = self._resolve(None, {"return_value": {}})

        geocode_mock.assert_not_called()
        self.assertFalse(result["applied"])
        self.assertFalse(result["requested"])
        self.assertIsNone(result["notice"])


class DegradedSearchTests(unittest.TestCase):
    def test_search_runs_unfiltered_when_geocoding_fails(self) -> None:
        from rag import location as location_mod
        from rag import search as search_mod

        with mock.patch.object(search_mod, "indexes_ready", return_value=True), \
            mock.patch.object(search_mod, "OpenAI", return_value=object()), \
            mock.patch.object(
                location_mod,
                "extract_location",
                return_value={"location": "Carrer de Pau Claris", "location_type": "street"},
            ), \
            mock.patch.object(
                location_mod, "geocode_location", side_effect=RuntimeError(GEOCODE_ERROR)
            ), \
            mock.patch.object(search_mod, "_embed_query", return_value=[0.1, 0.2]), \
            mock.patch.object(search_mod, "_vector_search", return_value=[]) as vector_mock, \
            mock.patch.object(search_mod, "_bm25_search", return_value=[]) as bm25_mock, \
            mock.patch.object(search_mod, "recommend_cafes", return_value={
                "answer": "An answer.",
                "intro": "An answer.",
                "reasons_by_id": {},
            }):
            result = search_mod.hybrid_search_and_answer(
                "sk-test", "specialty coffee on Carrer de Pau Claris"
            )

        # Retrieval ran with no place_id allowlist -> citywide search.
        self.assertIsNone(vector_mock.call_args.args[2])
        self.assertIsNone(bm25_mock.call_args.args[2])

        self.assertEqual(result["answer"], "An answer.")
        self.assertFalse(result["location"]["applied"])
        self.assertTrue(result["location"]["requested"])
        self.assertIn("all of Barcelona", result["location"]["notice"])
        # Upstream detail is available server-side but never inside `location`.
        self.assertIn("164.90.200.60", result["location_error"])
        self.assertNotIn("164.90.200.60", json.dumps(result["location"]))


    def test_known_landmark_skips_the_geocoding_api(self) -> None:
        from rag.neighborhoods import find_landmark

        match = find_landmark("Sagrada Familia")
        self.assertIsNotNone(match)
        self.assertEqual(match["id"], "sagrada-familia")

    def test_expands_radius_when_inner_ring_is_empty(self) -> None:
        from rag import location as location_mod

        calls: list[float] = []

        def fake_radius(_lat, _lon, radius_km=1.0):
            calls.append(radius_km)
            if radius_km < 2.5:
                return []
            return ["pid-far"]

        with mock.patch.object(
            location_mod,
            "extract_location",
            return_value={"location": "Gràcia", "location_type": "neighborhood"},
        ), mock.patch.object(
            location_mod, "cafes_within_radius", side_effect=fake_radius
        ):
            result = location_mod.resolve_location_filter("test-key", "coffee in Gràcia")

        self.assertEqual(calls, [1.0, 2.0, 3.0])
        self.assertTrue(result["applied"])
        self.assertEqual(result["radius_km"], 3.0)
        self.assertEqual(result["place_ids"], ["pid-far"])
        self.assertIn("1 km", result["notice"])

    def test_empty_after_cascade_falls_back_citywide(self) -> None:
        from rag import location as location_mod

        with mock.patch.object(
            location_mod,
            "extract_location",
            return_value={"location": "Gràcia", "location_type": "neighborhood"},
        ), mock.patch.object(
            location_mod, "cafes_within_radius", return_value=[]
        ):
            result = location_mod.resolve_location_filter("test-key", "coffee in Gràcia")

        self.assertFalse(result["applied"])
        self.assertTrue(result["requested"])
        self.assertIn("all of Barcelona", result["notice"])


class DeterministicLocationExtractionTests(unittest.TestCase):
    def test_neighborhood_in_query_does_not_need_llm(self) -> None:
        from rag.location import extract_location

        detected = extract_location("quiet place to work in Gràcia")
        self.assertEqual(detected["location"], "Gràcia")
        self.assertEqual(detected["location_type"], "neighborhood")

    def test_chinese_alias_in_example_query(self) -> None:
        from rag.location import extract_location

        detected = extract_location("哥特区哪里能喝到手冲")
        self.assertEqual(detected["location"], "Gothic Quarter")

    def test_prepositional_landmark_is_extracted_without_llm(self) -> None:
        from rag.location import extract_location

        detected = extract_location("specialty coffee near Sagrada Familia")
        self.assertEqual(detected["location"], "Sagrada Família")
        self.assertEqual(detected["location_type"], "landmark")

    def test_city_only_and_unlocated_queries_are_ignored(self) -> None:
        from rag.location import extract_location

        self.assertIsNone(extract_location("best espresso in Barcelona"))
        self.assertIsNone(extract_location("specialty coffee"))

    def test_center_maps_to_gotic_born_eixample_without_geocode(self) -> None:
        from rag.location import extract_location

        query = (
            "cozy place to work in center areas of barcelona "
            "with specialty coffe and >= 4 rating"
        )
        detected = extract_location(query)
        self.assertIsNotNone(detected)
        self.assertEqual(detected["location_type"], "area_group")
        self.assertIn("Gothic Quarter", detected["location"])
        self.assertIn("El Born", detected["location"])
        self.assertIn("Eixample", detected["location"])
        self.assertEqual(len(detected["viewports"]), 3)

    def test_in_neighborhood_still_works_when_constraints_follow(self) -> None:
        from rag.location import extract_location

        detected = extract_location("quiet place to work in Gràcia with a laptop")
        self.assertEqual(detected["location"], "Gràcia")
        self.assertEqual(detected["location_type"], "neighborhood")


class ViewportUnionTests(unittest.TestCase):
    def test_cafes_in_viewports_keeps_only_points_inside_a_member_rect(self) -> None:
        from rag import location as location_mod
        from rag.neighborhoods import load_search_groups

        group = next(g for g in load_search_groups() if g["id"] == "center")
        gothic = next(
            vp
            for vp in group["viewports"]
            if vp["low"]["latitude"] == 41.379
        )
        inside = {
            "place_id": "in-gotic",
            "latitude": (gothic["low"]["latitude"] + gothic["high"]["latitude"]) / 2,
            "longitude": (gothic["low"]["longitude"] + gothic["high"]["longitude"]) / 2,
        }
        outside = {
            "place_id": "gracia-cafe",
            "latitude": 41.41,
            "longitude": 2.155,
        }

        class Repo:
            def list_cafe_coordinates(self, **_kwargs):
                return [inside, outside]

        with mock.patch.object(location_mod, "get_repository", return_value=Repo()):
            ids = location_mod.cafes_in_viewports(group["viewports"])
        self.assertEqual(ids, ["in-gotic"])


if __name__ == "__main__":
    unittest.main()
