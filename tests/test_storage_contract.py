"""Contract + factory tests for Python storage adapters.

Run:
  python3 -m unittest tests.test_storage_contract -v
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


class FactoryTests(unittest.TestCase):
    def tearDown(self) -> None:
        from rag.stores.factory import reset_storage_cache

        reset_storage_cache()
        for key in ("STORAGE_BACKEND", "DATABASE_URL", "SQLITE_PATH", "DATA_DIR"):
            os.environ.pop(key, None)

    def test_default_backend_is_sqlite_chroma(self) -> None:
        os.environ.pop("STORAGE_BACKEND", None)
        from rag.stores.factory import STORAGE_SQLITE_CHROMA, get_storage_backend

        self.assertEqual(get_storage_backend(), STORAGE_SQLITE_CHROMA)

    def test_supabase_requires_database_url(self) -> None:
        os.environ["STORAGE_BACKEND"] = "supabase"
        os.environ.pop("DATABASE_URL", None)
        from rag.stores.factory import create_repository, reset_storage_cache

        reset_storage_cache()
        with self.assertRaisesRegex(RuntimeError, "DATABASE_URL"):
            create_repository()

    def test_create_sqlite_repository(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["STORAGE_BACKEND"] = "sqlite+chroma"
            os.environ["DATA_DIR"] = tmp
            os.environ["SQLITE_PATH"] = str(Path(tmp) / "cafes.db")
            from rag.stores.factory import create_index_store, create_repository, reset_storage_cache

            reset_storage_cache()
            repo = create_repository()
            self.assertEqual(repo.cafe_count(), 0)
            conn = repo._connect()
            try:
                names = {
                    row[0]
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='index'"
                    )
                }
            finally:
                conn.close()
            self.assertIn("idx_cafes_coords", names)
            store = create_index_store()
            self.assertEqual(store.backend, "chroma")
            self.assertFalse(store.is_ready())


class SqliteRepositoryContract(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "cafes.db"
        os.environ["STORAGE_BACKEND"] = "sqlite+chroma"
        os.environ["SQLITE_PATH"] = str(self.db_path)
        os.environ["DATA_DIR"] = self.tmp.name
        from rag.stores.factory import reset_storage_cache
        from rag.stores.sqlite_repo import SqliteCafeRepository

        reset_storage_cache()
        self.repo = SqliteCafeRepository(self.db_path)

    def tearDown(self) -> None:
        self.tmp.cleanup()
        for key in ("STORAGE_BACKEND", "DATABASE_URL", "SQLITE_PATH", "DATA_DIR"):
            os.environ.pop(key, None)

    def test_load_documents_and_coordinates(self) -> None:
        import sqlite3

        conn = sqlite3.connect(str(self.db_path))
        # Ensure schema via repository
        self.repo.cafe_count()
        conn.execute(
            """
            INSERT INTO cafes (
              place_id, name, address, rating, website,
              place_types, latitude, longitude, neighborhood_name, coffee_content
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "pid1",
                "Cafe Uno",
                "Addr",
                4.2,
                "https://ex.com",
                "[]",
                41.4,
                2.17,
                "Gràcia",
                "Nice espresso",
            ),
        )
        conn.execute(
            """
            INSERT INTO reviews (place_id, author_name, rating, text, publish_time)
            VALUES (?, ?, ?, ?, ?)
            """,
            ("pid1", "Bob", 5, "Amazing", "2024-01-01"),
        )
        conn.commit()
        conn.close()

        docs = self.repo.load_cafe_documents()
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0]["place_id"], "pid1")
        self.assertIn("Cafe Uno", docs[0]["document"])
        self.assertTrue(docs[0]["content_hash"])
        self.assertEqual(docs[0]["metadata"]["latitude"], 41.4)
        self.assertEqual(docs[0]["metadata"]["longitude"], 2.17)

        coords = self.repo.list_cafe_coordinates()
        self.assertEqual(len(coords), 1)
        self.assertEqual(self.repo.cafe_count(), 1)


class ChromaIndexStoreContract(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["STORAGE_BACKEND"] = "sqlite+chroma"
        os.environ["DATA_DIR"] = self.tmp.name
        from rag.stores.factory import reset_storage_cache

        reset_storage_cache()

    def tearDown(self) -> None:
        self.tmp.cleanup()
        for key in ("STORAGE_BACKEND", "DATABASE_URL", "DATA_DIR"):
            os.environ.pop(key, None)
        from rag.stores.factory import reset_storage_cache

        reset_storage_cache()

    def test_rebuild_ready_vector_search(self) -> None:
        try:
            import chromadb  # noqa: F401
        except ImportError:
            self.skipTest("chromadb not installed")

        from rag.stores.chroma_index import ChromaIndexStore

        store = ChromaIndexStore()
        fake_emb = [0.1] * 8
        docs = [
            {
                "place_id": "p1",
                "document": "specialty coffee in gracia",
                "content_hash": "h1",
                "metadata": {
                    "place_id": "p1",
                    "name": "Cafe P1",
                    "address": "x",
                    "rating": 4.5,
                    "district": "Gràcia",
                    "website": "",
                },
            }
        ]

        with mock.patch(
            "rag.stores.chroma_index.embed_batch",
            return_value=[fake_emb],
        ):
            result = store.rebuild("sk-test", docs)

        self.assertEqual(result["indexed"], 1)
        self.assertTrue(store.is_ready())
        status = store.status()
        self.assertEqual(status["document_count"], 1)
        hits = store.vector_search(fake_emb, top_n=3)
        self.assertEqual(hits[0]["place_id"], "p1")
        bm25_rows = store.iter_documents_for_bm25()
        self.assertEqual(len(bm25_rows), 1)

    def test_failed_rebuild_keeps_previous_index(self) -> None:
        try:
            import chromadb  # noqa: F401
        except ImportError:
            self.skipTest("chromadb not installed")

        from rag.stores.chroma_index import ChromaIndexStore

        store = ChromaIndexStore()
        fake_emb = [0.2] * 8
        docs = [
            {
                "place_id": "keep-me",
                "document": "keep this cafe",
                "content_hash": "h-keep",
                "metadata": {"place_id": "keep-me", "name": "Keep", "address": "", "rating": 4.0, "district": "", "website": ""},
            }
        ]
        with mock.patch("rag.stores.chroma_index.embed_batch", return_value=[fake_emb]):
            store.rebuild("sk-test", docs)
        self.assertTrue(store.is_ready())

        with mock.patch(
            "rag.stores.chroma_index.embed_batch",
            side_effect=RuntimeError("openai down"),
        ):
            with self.assertRaisesRegex(RuntimeError, "openai down"):
                store.rebuild("sk-test", docs)

        self.assertTrue(store.is_ready())
        hits = store.vector_search(fake_emb, top_n=1)
        self.assertEqual(hits[0]["place_id"], "keep-me")


class PgvectorOptionalContract(unittest.TestCase):
    def test_optional_pg_contract(self) -> None:
        if os.environ.get("RUN_PG_CONTRACT") != "1":
            self.skipTest("set RUN_PG_CONTRACT=1 and DATABASE_URL to enable")
        url = (os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL") or "").strip()
        if not url:
            self.skipTest("DATABASE_URL missing")

        os.environ["STORAGE_BACKEND"] = "supabase"
        os.environ["DATABASE_URL"] = url
        from rag.stores.factory import reset_storage_cache
        from rag.stores.postgres_repo import PostgresCafeRepository
        from rag.stores.pgvector_index import PgvectorIndexStore
        from rag import db as pg

        reset_storage_cache()
        repo = PostgresCafeRepository()
        self.assertGreaterEqual(repo.cafe_count(), 0)
        store = PgvectorIndexStore()
        status = store.status()
        self.assertIn("backend", status)
        self.assertEqual(status["backend"], "pgvector")
        # Smoke: listing documents should not raise
        _ = store.iter_documents_for_bm25()
        _ = pg  # keep import used for connection validation path


if __name__ == "__main__":
    unittest.main()
