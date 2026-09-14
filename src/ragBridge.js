import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const DEFAULT_TIMEOUT_MS = 600_000;

let worker = null;
let workerReady = null;
let stdoutBuf = "";
const pending = new Map();

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

function rejectAll(err) {
  for (const [, waiter] of pending) {
    clearTimeout(waiter.timer);
    waiter.reject(err);
  }
  pending.clear();
}

function handleWorkerLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (data?.event === "ready") {
    workerReady?.resolve();
    return;
  }
  const id = data?.id;
  if (!id || !pending.has(id)) return;
  const waiter = pending.get(id);
  pending.delete(id);
  clearTimeout(waiter.timer);
  if (!data.ok) {
    waiter.reject(new Error(data.error || "RAG command failed"));
    return;
  }
  waiter.resolve(data);
}

function attachWorkerIO(proc) {
  stdoutBuf = "";
  proc.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      handleWorkerLine(line);
    }
  });
  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      console.error(JSON.stringify({ msg: "rag_worker_stderr", text: text.slice(0, 500) }));
    }
  });
  proc.on("error", (err) => {
    const ready = workerReady;
    worker = null;
    workerReady = null;
    ready?.reject(err);
    rejectAll(err);
  });
  proc.on("close", (code) => {
    const err = new Error(`RAG worker exited with code ${code}`);
    const ready = workerReady;
    worker = null;
    workerReady = null;
    stdoutBuf = "";
    ready?.reject(err);
    rejectAll(err);
  });
}

function startWorker({ openaiApiKey, googleApiKey } = {}) {
  if (worker) return workerReady.promise;
  let resolveReady;
  let rejectReady;
  workerReady = {
    promise: new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    }),
  };
  workerReady.resolve = resolveReady;
  workerReady.reject = rejectReady;

  const proc = spawn(pythonBin(), ["-m", "rag", "worker"], {
    cwd: ROOT,
    env: ragEnv({ openaiApiKey, googleApiKey }),
  });
  worker = proc;
  attachWorkerIO(proc);
  const readyTimeout = setTimeout(() => {
    rejectReady(new Error("RAG worker failed to start"));
    stopWorkerProcess();
  }, 60_000);
  workerReady.promise.finally(() => clearTimeout(readyTimeout)).catch(() => {});
  return workerReady.promise;
}

function stopWorkerProcess() {
  const proc = worker;
  worker = null;
  workerReady = null;
  stdoutBuf = "";
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    // already gone
  }
}

export function shutdownRagWorker() {
  rejectAll(new Error("RAG worker shut down"));
  stopWorkerProcess();
}

function sendToWorker(parsed, { timeoutMs, openaiApiKey, googleApiKey }) {
  const id = randomUUID();
  const payload = {
    id,
    ...parsed,
  };
  if (openaiApiKey) payload.api_key = openaiApiKey;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      stopWorkerProcess();
      reject(new Error(`RAG command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    const ok = worker.stdin.write(`${JSON.stringify(payload)}\n`);
    if (!ok) {
      worker.stdin.once("error", (err) => {
        if (pending.has(id)) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    }
    void googleApiKey;
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
      proc.kill("SIGTERM");
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
      const line = stdout.trim().split("\n").filter(Boolean).pop();
      if (!line) {
        reject(
          new Error(
            stderr.trim() ||
              `RAG process exited with code ${code} and no JSON output`
          )
        );
        return;
      }
      let data;
      try {
        data = JSON.parse(line);
      } catch {
        reject(
          new Error(
            `Invalid RAG JSON: ${line.slice(0, 200)}${stderr ? ` | ${stderr.slice(0, 300)}` : ""}`
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

/**
 * Run a RAG command through the warm Python worker (or one-shot spawn if RAG_WORKER=0).
 */
export function runRag(
  args,
  { timeoutMs = DEFAULT_TIMEOUT_MS, openaiApiKey, googleApiKey } = {}
) {
  if (!usePersistentWorker()) {
    return runRagOnce(args, { timeoutMs, openaiApiKey, googleApiKey });
  }

  const parsed = parseRagArgs(args);
  return startWorker({ openaiApiKey, googleApiKey })
    .catch((err) => {
      stopWorkerProcess();
      throw err;
    })
    .then(() => sendToWorker(parsed, { timeoutMs, openaiApiKey, googleApiKey }))
    .catch((err) => {
      if (String(err.message || err).includes("exited")) {
        return startWorker({ openaiApiKey, googleApiKey }).then(() =>
          sendToWorker(parsed, { timeoutMs, openaiApiKey, googleApiKey })
        );
      }
      throw err;
    });
}

export function warmupRagWorker(opts = {}) {
  if (!usePersistentWorker()) return Promise.resolve();
  return runRag(["status"], { timeoutMs: opts.timeoutMs ?? 60_000 });
}
