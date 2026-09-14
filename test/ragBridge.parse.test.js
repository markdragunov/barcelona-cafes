/** RAG CLI args parsed for the persistent Python worker. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRagArgs } from "../src/ragBridge.js";

describe("parseRagArgs", () => {
  it("parses status and index", () => {
    assert.deepEqual(parseRagArgs(["status"]), { command: "status" });
    assert.deepEqual(parseRagArgs(["index"]), { command: "index" });
  });

  it("parses search query flags", () => {
    assert.deepEqual(
      parseRagArgs(["search", "--query", "quiet in Gràcia", "--top-n", "7"]),
      { command: "search", query: "quiet in Gràcia", top_n: 7 }
    );
  });
});
