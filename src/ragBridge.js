import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const DEFAULT_TIMEOUT_MS = 600_000;
const RECYCLE_AFTER_TIMEOUTS = 3;
const STATUS_CACHE_TTL_MS = 15_000;

/** Commands that must not share the search worker pool (long, exclusive). */
const ONE_SHOT_COMMANDS = new Set(["index"]);

function ragEnv({ openaiApiKey, googleApiKey } = {}) {
  const env = { ...process.env, PYTHONUNBUFFERED: "1" };
  if (openaiApiKey) env.OPENAI_API_KEY = openaiApiKey;
  if (googleApiKey) env.GOOGLE_API_KEY = googleApiKey;
  if (googleApiKey && !env.GOOGLE_PLACES_API_KEY) {
    env.GOOGLE_PLACES_API_KEY = googleApiKey;
  }
  if (process.env.DATA_DIR) env.DATA_DIR = process.env.DATA_DIR;
  if (process.env.STORAGE_BACKEND) env.STORAGE_BACKEND = process.env.STORAGE_BACKEND;
  if (process.env.DATABASE_URL) env.DATABASE_URL = process.env.DATABASE_URL;
  if (process.env.SQLITE_PATH) env.SQLITE_PATH = process.env.SQLITE_PATH;
  return env;
}

function pythonBin() {
  return process.env.PYTHON_BIN || "python3";
}

export function parseLastJsonLine(stdout) {
  const lines = String(stdout || "")
    .trim()
    .split("\n")
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Libraries (Chroma, OpenAI telemetry) sometimes print after the payload.
    }
  }
  return null;
}

function killProcess(proc, { termMs = 5_000 } = {}) {
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    return;
  }
  const killer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, termMs);
  killer.unref();
  proc.once("exit", () => clearTimeout(killer));
}

export function parseRagArgs(args) {
  const command = args[0];
  if (command === "status" || command === "index" || command === "ping") {
    return { command };
  }
  if (command === "search") {
    const queryIdx = args.indexOf("--query");
    const topIdx = args.indexOf("--top-n");
    return {
      command: "search",
      query: queryIdx >= 0 ? String(args[queryIdx + 1] ?? "") : "",
      top_n: topIdx >= 0 ? Number(args[topIdx + 1]) : 5,
    };
  }
  throw new Error(`Unknown RAG command: ${command || "(empty)"}`);
}

export function shouldUseOneShot(command) {
  return ONE_SHOT_COMMANDS.has(command);
}

export function workerPoolSize() {
  const raw = Number(process.env.RAG_WORKER_POOL);
  if (!Number.isFinite(raw)) return 2;
  return Math.min(4, Math.max(1, Math.round(raw)));
}

export function shouldRecycleAfterTimeouts(consecutiveTimeouts) {
  return consecutiveTimeouts >= RECYCLE_AFTER_TIMEOUTS;
}

/**
 * Prefer a ready idle worker, then start a free slot, then the least loaded.
 * @param {{index: number, proc: unknown, inflight: number, readyResolved?: boolean}[]} slots
 */
export function pickWorkerSlot(slots) {
  if (!slots.length) return null;
  const readyIdle = slots.filter(
    (s) => s.proc && s.readyResolved && s.inflight === 0
  );
  if (readyIdle.length) return readyIdle[0];
  const unstarted = slots.find((s) => !s.proc);
  if (unstarted) return unstarted;
  const starting = slots.find((s) => s.proc && !s.readyResolved);
  if (starting) return starting;
  const live = slots.filter((s) => s.proc);
  if (!live.length) return slots[0];
  return live.reduce((best, slot) =>
    slot.inflight < best.inflight ? slot : best
  );
}

function createSlot(index) {
  return {
    index,
    proc: null,
    ready: null,
    pending: new Map(),
    stdoutBuf: "",
    inflight: 0,
    consecutiveTimeouts: 0,
    readyResolved: false,
  };
}

let slots = [];

function ensureSlotList() {
  const size = workerPoolSize();
  while (slots.length < size) slots.push(createSlot(slots.length));
  while (slots.length > size) {
    const extra = slots.pop();
    recycleSlot(extra, new Error("RAG worker pool shrunk"));
  }
  return slots;
}

function rejectSlotPending(slot, err) {
  for (const [, waiter] of slot.pending) {
    clearTimeout(waiter.timer);
    waiter.reject(err);
  }
  slot.pending.clear();
  slot.inflight = 0;
}

function handleSlotLine(slot, line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (data?.event === "ready") {
    slot.readyResolved = true;
    slot.ready?.resolve();
    return;
  }
  const id = data?.id;
  if (!id || !slot.pending.has(id)) {
    slot.inflight = Math.max(0, slot.inflight - 1);
    if (id) slot.consecutiveTimeouts = 0;
    return;
  }
  const waiter = slot.pending.get(id);
  slot.pending.delete(id);
  slot.inflight = Math.max(0, slot.inflight - 1);
  slot.consecutiveTimeouts = 0;
  clearTimeout(waiter.timer);
  if (!data.ok) {
    waiter.reject(new Error(data.error || "RAG command failed"));
    return;
  }
  waiter.resolve(data);
}

function attachSlotIO(slot, proc) {
  slot.stdoutBuf = "";
  proc.stdout.on("data", (chunk) => {
    slot.stdoutBuf += chunk.toString();
    let nl;
    while ((nl = slot.stdoutBuf.indexOf("\n")) >= 0) {
      const line = slot.stdoutBuf.slice(0, nl);
      slot.stdoutBuf = slot.stdoutBuf.slice(nl + 1);
      handleSlotLine(slot, line);
    }
  });
  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      console.error(
        JSON.stringify({
          msg: "rag_worker_stderr",
          worker: slot.index,
          text: text.slice(0, 500),
        })
      );
    }
  });
  proc.on("error", (err) => {
    const ready = slot.ready;
    slot.proc = null;
    slot.ready = null;
    slot.readyResolved = false;
    ready?.reject(err);
    rejectSlotPending(slot, err);
  });
  proc.on("close", (code) => {
    const err = new Error(`RAG worker exited with code ${code}`);
    const ready = slot.ready;
    slot.proc = null;
    slot.ready = null;
    slot.stdoutBuf = "";
    slot.readyResolved = false;
    ready?.reject(err);
    rejectSlotPending(slot, err);
  });
}

function recycleSlot(slot, err) {
  const proc = slot.proc;
  slot.proc = null;
  slot.ready = null;
  slot.stdoutBuf = "";
  slot.consecutiveTimeouts = 0;
  slot.readyResolved = false;
  rejectSlotPending(slot, err || new Error("RAG worker recycled"));
  killProcess(proc);
}

function startSlot(slot, { openaiApiKey, googleApiKey } = {}) {
  if (slot.proc && slot.ready?.promise) return slot.ready.promise;
  let resolveReady;
  let rejectReady;
  slot.ready = {
    promise: new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    }),
  };
  slot.ready.resolve = resolveReady;
  slot.ready.reject = rejectReady;

  const proc = spawn(pythonBin(), ["-m", "rag", "worker"], {
    cwd: ROOT,
    env: ragEnv({ openaiApiKey, googleApiKey }),
  });
  slot.proc = proc;
  attachSlotIO(slot, proc);
  const readyTimeout = setTimeout(() => {
    rejectReady(new Error("RAG worker failed to start"));
    recycleSlot(slot, new Error("RAG worker failed to start"));
  }, 60_000);
  slot.ready.promise.finally(() => clearTimeout(readyTimeout)).catch(() => {});
  return slot.ready.promise;
}

function sendToSlot(slot, parsed, { timeoutMs, openaiApiKey }) {
  const id = randomUUID();
  const payload = { id, ...parsed };
  if (openaiApiKey) payload.api_key = openaiApiKey;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!slot.pending.has(id)) return;
      slot.pending.delete(id);
      slot.consecutiveTimeouts += 1;
      reject(new Error(`RAG command timed out after ${timeoutMs}ms`));
      if (shouldRecycleAfterTimeouts(slot.consecutiveTimeouts)) {
        recycleSlot(
          slot,
          new Error("RAG worker recycled after consecutive timeouts")
        );
      }
    }, timeoutMs);
    slot.pending.set(id, { resolve, reject, timer });
    slot.inflight += 1;
    try {
      const ok = slot.proc.stdin.write(`${JSON.stringify(payload)}\n`);
      if (!ok) {
        slot.proc.stdin.once("error", (err) => {
          if (slot.pending.has(id)) {
            slot.pending.delete(id);
            slot.inflight = Math.max(0, slot.inflight - 1);
            clearTimeout(timer);
            reject(err);
          }
        });
      }
    } catch (err) {
      slot.pending.delete(id);
      slot.inflight = Math.max(0, slot.inflight - 1);
      clearTimeout(timer);
      reject(err);
    }
  });
}

function runRagOnce(args, { timeoutMs, openaiApiKey, googleApiKey }) {
  return new Promise((resolve, reject) => {
    const env = ragEnv({ openaiApiKey, googleApiKey });
    const proc = spawn(pythonBin(), ["-m", "rag", ...args], {
      cwd: ROOT,
      env,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killProcess(proc);
      reject(new Error(`RAG command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const data = parseLastJsonLine(stdout);
      if (!data) {
        reject(
          new Error(
            stderr.trim() ||
              `RAG process exited with code ${code} and no JSON output`
          )
        );
        return;
      }
      if (!data.ok) {
        reject(new Error(data.error || "RAG command failed"));
        return;
      }
      resolve(data);
    });
  });
}

function usePersistentWorker() {
  return process.env.RAG_WORKER !== "0";
}

let statusCache = { at: 0, value: null };

function cacheStatus(value) {
  statusCache = { at: Date.now(), value };
  return value;
}

export function getCachedIndexStatus() {
  if (!statusCache.value) return null;
  if (Date.now() - statusCache.at > STATUS_CACHE_TTL_MS) return statusCache.value;
  return statusCache.value;
}

function statusCacheFresh() {
  return Boolean(statusCache.value) && Date.now() - statusCache.at < STATUS_CACHE_TTL_MS;
}

async function runOnPool(parsed, opts) {
  ensureSlotList();
  const slot = pickWorkerSlot(slots);
  if (!slot.proc) {
    await startSlot(slot, opts);
  } else if (slot.ready?.promise) {
    await slot.ready.promise;
  }
  try {
    return await sendToSlot(slot, parsed, opts);
  } catch (err) {
    if (String(err.message || err).includes("exited")) {
      await startSlot(slot, opts);
      return sendToSlot(slot, parsed, opts);
    }
    throw err;
  }
}

/**
 * Run a RAG command. Index always uses a one-shot process so it cannot block
 * public search. Search/status/ping go to a small persistent worker pool.
 */
export function runRag(
  args,
  { timeoutMs = DEFAULT_TIMEOUT_MS, openaiApiKey, googleApiKey } = {}
) {
  const parsed = parseRagArgs(args);
  if (!usePersistentWorker() || shouldUseOneShot(parsed.command)) {
    return runRagOnce(args, { timeoutMs, openaiApiKey, googleApiKey });
  }

  if (parsed.command === "status" && statusCacheFresh()) {
    return Promise.resolve(statusCache.value);
  }

  return runOnPool(parsed, { timeoutMs, openaiApiKey, googleApiKey }).then(
    (data) => {
      if (parsed.command === "status") cacheStatus(data);
      return data;
    }
  );
}

export function warmupRagWorker(opts = {}) {
  if (!usePersistentWorker()) return Promise.resolve();
  ensureSlotList();
  const keys = opts;
  return Promise.all(
    slots.map((slot) =>
      startSlot(slot, keys).then(() =>
        sendToSlot(slot, { command: "ping" }, { timeoutMs: opts.timeoutMs ?? 60_000 })
      )
    )
  ).then(() =>
    runRag(["status"], { timeoutMs: opts.timeoutMs ?? 60_000 })
  );
}

export function shutdownRagWorker() {
  for (const slot of slots) {
    recycleSlot(slot, new Error("RAG worker shut down"));
  }
}
