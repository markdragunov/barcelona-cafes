/** RAG CLI args parsed for the persistent Python worker. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLastJsonLine, parseRagArgs } from "../src/ragBridge.js";

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

describe("parseLastJsonLine", () => {
  it("uses the last valid JSON object even if later lines are noise", () => {
    const stdout = [
      "telemetry started",
      JSON.stringify({ ok: true, answer: "hi" }),
      "chroma leftover",
    ].join("\n");
    assert.deepEqual(parseLastJsonLine(stdout), { ok: true, answer: "hi" });
  });

  it("returns null when nothing parses", () => {
    assert.equal(parseLastJsonLine("not json\nstill not"), null);
  });
});
