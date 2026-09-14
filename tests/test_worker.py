"""JSON-lines worker request handler."""

from __future__ import annotations

import unittest

from rag.worker import handle_request


class WorkerHandlerTests(unittest.TestCase):
    def test_ping(self) -> None:
        result = handle_request({"id": "abc", "command": "ping"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["id"], "abc")
        self.assertTrue(result["pong"])

    def test_unknown_command(self) -> None:
        result = handle_request({"id": "x", "command": "nope"})
        self.assertFalse(result["ok"])
        self.assertIn("Unknown command", result["error"])


if __name__ == "__main__":
    unittest.main()
