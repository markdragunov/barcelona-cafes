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

describe("worker pool routing", () => {
  it("sends index out of the persistent pool", async () => {
    const { shouldUseOneShot } = await import("../src/ragBridge.js");
    assert.equal(shouldUseOneShot("index"), true);
    assert.equal(shouldUseOneShot("search"), false);
    assert.equal(shouldUseOneShot("status"), false);
  });

  it("recycles only after consecutive timeouts", async () => {
    const { shouldRecycleAfterTimeouts } = await import("../src/ragBridge.js");
    assert.equal(shouldRecycleAfterTimeouts(1), false);
    assert.equal(shouldRecycleAfterTimeouts(2), false);
    assert.equal(shouldRecycleAfterTimeouts(3), true);
  });

  it("prefers a ready idle worker then an unstarted slot", async () => {
    const { pickWorkerSlot } = await import("../src/ragBridge.js");
    const slots = [
      { index: 0, proc: {}, inflight: 1, readyResolved: true },
      { index: 1, proc: null, inflight: 0, readyResolved: false },
    ];
    assert.equal(pickWorkerSlot(slots).index, 1);
    slots[1] = { index: 1, proc: {}, inflight: 0, readyResolved: true };
    assert.equal(pickWorkerSlot(slots).index, 1);
  });
});
