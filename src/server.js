import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getGoogleApiKey,
  getParallelApiKey,
  getOpenAiApiKey,
  getDataDir,
  isAdminAuthEnabled,
  isSupabaseAdminAuthEnabled,
  getSupabaseUrl,
  getSupabaseAnonKey,
  getSearchRateLimitWindowMs,
  getSearchRateLimitMax,
  getSearchGlobalRateLimitMax,
  getSearchDailyGlobalMax,
  getSearchMaxQueryChars,
  getSearchCacheTtlMs,
  getSearchCacheMaxEntries,
  assertAdminAuthConfigured,
} from "./config.js";
import {
  getSummary,
  getCafesForExport,
  getCafesNeedingCoffeeContent,
  countCafesWithCoffeeContent,
  updateCoffeeContent,
} from "./db.js";
import {
  NEIGHBORHOOD_LIST,
  getNeighborhood,
  getCollectableNeighborhoods,
} from "./neighborhoods.js";
import { collectCafes } from "./places.js";
import { extractCoffeeContent } from "./extract.js";
import { SEARCH_QUERIES } from "./queries.js";
import { runRag, warmupRagWorker, shutdownRagWorker } from "./ragBridge.js";import {
  requireAdmin,
  rateLimit,
  globalRateLimit,
  validateSearchQuery,
  requestLog,
  securityHeaders,
} from "./middleware.js";
import { createSearchCache, searchCacheKey } from "./searchCache.js";
import { publicSearchError } from "./searchErrors.js";
import { acceptAndRun, finishJob, persistJobRecord, pushJobLog } from "./jobs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const app = express();
const PORT = process.env.PORT || 3847;
let shuttingDown = false;

app.set("trust proxy", 1);
app.use(requestLog);
app.use(securityHeaders);
app.use(express.json({ limit: "2mb" }));

/** Public routes stay open; admin ops APIs require auth. */
app.use((req, res, next) => {
  if (req.path === "/api/health" || req.path === "/api/ready") return next();
  if (req.path === "/api/auth/config") return next();
  if (req.method === "POST" && req.path === "/api/rag/search") return next();
  if (req.method === "GET" && req.path === "/") return next();
  if (
    req.method === "GET" &&
    (req.path === "/admin" || req.path === "/admin/")
  ) {
    // Magic link: the login UI must load anonymously.
    // Basic: keep the page gated so the browser prompts here and then attaches
    // credentials to the admin fetches that follow.
    if (isSupabaseAdminAuthEnabled()) return next();
    return requireAdmin(req, res, next);
  }
  if (
    req.method === "GET" &&
    !req.path.startsWith("/api") &&
    req.path !== "/admin" &&
    !req.path.startsWith("/admin/")
  ) {
    return next();
  }
  if (req.path.startsWith("/api/")) {
    return requireAdmin(req, res, next);
  }
  return next();
});

// Public search page (project root). Admin stays under /admin.
app.get("/", (_req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});
app.get(["/admin", "/admin/"], (_req, res) => {
  res.sendFile(path.join(PUBLIC, "index.html"));
});
app.use(express.static(PUBLIC, { index: false }));

let collectionJob = null;
let coffeeJob = null;
let indexJob = null;

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const ENV_KEYS_HINT =
  "Set secrets in the project .env file (see .env.example). They are not stored via the admin UI.";

const SEARCH_WINDOW_MS = getSearchRateLimitWindowMs();
const searchRateLimit = rateLimit({
  windowMs: SEARCH_WINDOW_MS,
  max: getSearchRateLimitMax(),
});
const searchGlobalRateLimit = globalRateLimit({
  windowMs: SEARCH_WINDOW_MS,
  max: getSearchGlobalRateLimitMax(),
});
const searchDailyLimit = globalRateLimit({
  windowMs: 86_400_000,
  max: getSearchDailyGlobalMax(),
});
const searchQueryGuard = validateSearchQuery({
  maxChars: getSearchMaxQueryChars(),
});
const searchCache = createSearchCache({
  ttlMs: getSearchCacheTtlMs(),
  maxEntries: getSearchCacheMaxEntries(),
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/auth/config", (_req, res) => {
  if (!isSupabaseAdminAuthEnabled()) {
    return res.json({
      authMode: isAdminAuthEnabled() ? "basic" : "open",
      supabaseUrl: null,
      supabaseAnonKey: null,
    });
  }
  res.json({
    authMode: "magic_link",
    supabaseUrl: getSupabaseUrl(),
    supabaseAnonKey: getSupabaseAnonKey(),
  });
});

app.get("/api/auth/me", (req, res) => {
  res.json({
    email: req.admin?.email || null,
    authMode: isSupabaseAdminAuthEnabled()
      ? "magic_link"
      : isAdminAuthEnabled()
        ? "basic"
        : "open",
  });
});

const READY_CACHE_TTL_MS = 15_000;
let readyCache = { at: 0, status: 503, payload: null };
let readyRefresh = null;

async function loadReadySnapshot() {
  const summary = await getSummary("all-barcelona");
  const status = await runRag(["status"], { timeoutMs: 60_000 });
  const ready =
    Boolean(status.ready) &&
    Number(status.document_count ?? 0) > 0 &&
    Number(summary.total_cafes ?? 0) > 0;
  return {
    status: ready ? 200 : 503,
    payload: {
      ready,
      cafes: summary.total_cafes ?? 0,
      documents: status.document_count ?? 0,
      dataDir: getDataDir(),
    },
  };
}

function refreshReadyCache() {
  if (readyRefresh) return readyRefresh;
  readyRefresh = loadReadySnapshot()
    .then((snapshot) => {
      readyCache = { at: Date.now(), ...snapshot };
    })
    .catch((err) => {
      console.error(
        JSON.stringify({
          msg: "ready_refresh_failed",
          error: err.message || String(err),
        })
      );
    })
    .finally(() => {
      readyRefresh = null;
    });
  return readyRefresh;
}

function withLiveIndexing(payload) {
  return { ...payload, indexing: Boolean(indexJob?.running) };
}

app.get("/api/ready", async (_req, res) => {
  try {
    const now = Date.now();
    const hasCache = Boolean(readyCache.payload);
    const fresh = hasCache && now - readyCache.at < READY_CACHE_TTL_MS;
    if (fresh) {
      return res
        .status(readyCache.status)
        .json(withLiveIndexing(readyCache.payload));
    }
    if (hasCache) {
      refreshReadyCache();
      return res
        .status(readyCache.status)
        .json(withLiveIndexing(readyCache.payload));
    }
    const snapshot = await loadReadySnapshot();
    readyCache = { at: Date.now(), ...snapshot };
    return res
      .status(snapshot.status)
      .json(withLiveIndexing(snapshot.payload));
  } catch (err) {
    console.error(
      JSON.stringify({
        msg: "ready_failed",
        error: err.message || String(err),
      })
    );
    res.status(503).json({
      ready: false,
      error: "Not ready",
    });
  }
});

app.get("/api/neighborhoods", (_req, res) => {
  res.json({
    neighborhoods: NEIGHBORHOOD_LIST.map((n) => ({
      id: n.id,
      name: n.name,
    })),
    queryCount: SEARCH_QUERIES.length,
  });
});

app.get("/api/settings/api-key", (_req, res) => {
  const key = getGoogleApiKey();
  res.json({
    configured: Boolean(key),
    masked: maskKey(key),
    source: "env",
    envVar: "GOOGLE_PLACES_API_KEY",
  });
});

app.post("/api/settings/api-key", (_req, res) => {
  res.status(405).json({ error: ENV_KEYS_HINT });
});

app.get("/api/settings/parallel-api-key", (_req, res) => {
  const key = getParallelApiKey();
  res.json({
    configured: Boolean(key),
    masked: maskKey(key),
    source: "env",
    envVar: "PARALLEL_API_KEY",
  });
});

app.post("/api/settings/parallel-api-key", (_req, res) => {
  res.status(405).json({ error: ENV_KEYS_HINT });
});

app.get("/api/settings/openai-api-key", (_req, res) => {
  const key = getOpenAiApiKey();
  res.json({
    configured: Boolean(key),
    masked: maskKey(key),
    source: "env",
    envVar: "OPENAI_API_KEY",
  });
});

app.post("/api/settings/openai-api-key", (_req, res) => {
  res.status(405).json({ error: ENV_KEYS_HINT });
});

app.get("/api/summary", async (req, res) => {
  const neighborhoodId = String(req.query.neighborhood || "all-barcelona");
  if (!getNeighborhood(neighborhoodId)) {
    return res.status(400).json({ error: "Unknown neighborhood" });
  }
  res.json(await getSummary(neighborhoodId));
});

app.get("/api/export.csv", async (req, res) => {
  const neighborhoodId = String(req.query.neighborhood || "all-barcelona");
  const neighborhood = getNeighborhood(neighborhoodId);
  if (!neighborhood) {
    return res.status(400).json({ error: "Unknown neighborhood" });
  }

  const cafes = await getCafesForExport(neighborhoodId);
  const header = [
    "place_id",
    "name",
    "address",
    "rating",
    "user_rating_count",
    "website",
    "place_types",
    "latitude",
    "longitude",
    "neighborhood_id",
    "neighborhood_name",
    "coffee_content",
    "reviews_json",
  ];

  const lines = [header.join(",")];
  for (const cafe of cafes) {
    lines.push(
      [
        cafe.place_id,
        cafe.name,
        cafe.address,
        cafe.rating,
        cafe.user_rating_count,
        cafe.website,
        cafe.place_types,
        cafe.latitude,
        cafe.longitude,
        cafe.neighborhood_id,
        cafe.neighborhood_name,
        cafe.coffee_content,
        JSON.stringify(cafe.reviews),
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  const slug = neighborhood.id;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="barcelona-cafes-${slug}.csv"`
  );
  res.send(lines.join("\n"));
});

app.get("/api/collect/status", (_req, res) => {
  if (!collectionJob) {
    return res.json({ running: false });
  }
  res.json({
    running: collectionJob.running,
    neighborhoodId: collectionJob.neighborhoodId,
    startedAt: collectionJob.startedAt,
    finishedAt: collectionJob.finishedAt,
    error: collectionJob.error,
    result: collectionJob.result,
    logs: collectionJob.logs.slice(-80),
  });
});

app.post("/api/collect", async (req, res) => {
  if (shuttingDown) {
    return res.status(503).json({ error: "Server is shutting down" });
  }
  if (collectionJob?.running) {
    return res.status(409).json({ error: "Collection already running" });
  }

  const apiKey = getGoogleApiKey();
  if (!apiKey) {
    return res.status(400).json({ error: "Set GOOGLE_PLACES_API_KEY in .env first" });
  }

  const neighborhoodId = String(req.body?.neighborhoodId || "");
  if (!getNeighborhood(neighborhoodId)) {
    return res.status(400).json({ error: "Unknown neighborhood" });
  }

  const neighborhoods = getCollectableNeighborhoods(neighborhoodId);
  if (neighborhoods.length === 0) {
    return res.status(400).json({ error: "No neighborhoods to collect" });
  }

  const controller = new AbortController();
  collectionJob = {
    running: true,
    neighborhoodId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    result: null,
    logs: [],
    controller,
  };

  acceptAndRun(
    res,
    {
      ok: true,
      message: "Collection started",
      neighborhoodId,
      neighborhoods: neighborhoods.map((n) => n.name),
      queryCount: SEARCH_QUERIES.length,
    },
    async () => {
      try {
        const result = await collectCafes({
          apiKey,
          neighborhoods,
          signal: controller.signal,
          onProgress: (event) => pushJobLog(collectionJob, event),
        });
        finishJob(collectionJob, { result });
        pushJobLog(collectionJob, {
          stage: "done",
          message:
            `Done. Unique places ${result.uniquePlaces}, ` +
            `created ${result.created}, updated ${result.updated} ` +
            `(raw hits ${result.found}).`,
        });
        await persistJobRecord("collect", collectionJob);
      } catch (err) {
        finishJob(collectionJob, { error: err });
        pushJobLog(collectionJob, {
          stage: "error",
          message: collectionJob.error,
        });
        await persistJobRecord("collect", collectionJob);
      }
    }
  );
});

app.post("/api/collect/cancel", (_req, res) => {
  if (!collectionJob?.running) {
    return res.status(400).json({ error: "No collection running" });
  }
  collectionJob.controller.abort();
  res.json({ ok: true });
});

function coffeeJobSnapshot() {
  if (!coffeeJob) {
    return { running: false };
  }
  return {
    running: coffeeJob.running,
    neighborhoodId: coffeeJob.neighborhoodId,
    startedAt: coffeeJob.startedAt,
    finishedAt: coffeeJob.finishedAt,
    error: coffeeJob.error,
    total: coffeeJob.total,
    completed: coffeeJob.completed,
    skipped: coffeeJob.skipped,
    failed: coffeeJob.failed,
    current: coffeeJob.current,
    logs: coffeeJob.logs.slice(-80),
  };
}

app.get("/api/coffee-content/status", (_req, res) => {
  res.json(coffeeJobSnapshot());
});

app.post("/api/coffee-content/fetch", async (req, res) => {
  if (shuttingDown) {
    return res.status(503).json({ error: "Server is shutting down" });
  }
  if (coffeeJob?.running) {
    return res.status(409).json({ error: "Coffee content fetch already running" });
  }

  const apiKey = getParallelApiKey();
  if (!apiKey) {
    return res
      .status(400)
      .json({ error: "Set PARALLEL_API_KEY in .env first" });
  }

  const neighborhoodId = String(req.body?.neighborhoodId || "all-barcelona");
  if (!getNeighborhood(neighborhoodId)) {
    return res.status(400).json({ error: "Unknown neighborhood" });
  }

  const toProcess = await getCafesNeedingCoffeeContent(neighborhoodId);
  const skipped = await countCafesWithCoffeeContent(neighborhoodId);

  const controller = new AbortController();
  coffeeJob = {
    running: true,
    neighborhoodId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    total: toProcess.length,
    completed: 0,
    skipped,
    failed: 0,
    current: null,
    logs: [],
    controller,
  };

  acceptAndRun(
    res,
    {
      ok: true,
      message: "Coffee content fetch started",
      total: toProcess.length,
      skipped,
    },
    async () => {
      pushJobLog(coffeeJob, {
        stage: "start",
        message: `Processing ${toProcess.length} cafe(s); skipped ${skipped} already filled.`,
      });

      try {
        for (const cafe of toProcess) {
          if (controller.signal.aborted) {
            throw new Error("Coffee content fetch cancelled");
          }

          coffeeJob.current = { place_id: cafe.place_id, name: cafe.name };
          pushJobLog(coffeeJob, {
            stage: "cafe",
            message: `Extracting: ${cafe.name}`,
            place_id: cafe.place_id,
          });

          try {
            const content = await extractCoffeeContent(apiKey, cafe.website);
            await updateCoffeeContent(cafe.place_id, content);
            coffeeJob.completed += 1;
            pushJobLog(coffeeJob, {
              stage: "saved",
              message: `Saved coffee content for ${cafe.name}`,
              place_id: cafe.place_id,
            });
          } catch (err) {
            coffeeJob.failed += 1;
            pushJobLog(coffeeJob, {
              stage: "error",
              message: `Failed ${cafe.name}: ${err.message || String(err)}`,
              place_id: cafe.place_id,
            });
          }

          await new Promise((r) => setTimeout(r, 200));
        }

        coffeeJob.current = null;
        finishJob(coffeeJob);
        pushJobLog(coffeeJob, {
          stage: "done",
          message: `Done. Completed ${coffeeJob.completed}/${coffeeJob.total}; skipped ${coffeeJob.skipped}; failed ${coffeeJob.failed}.`,
        });
        await persistJobRecord("coffee-content", coffeeJob);
      } catch (err) {
        coffeeJob.current = null;
        finishJob(coffeeJob, { error: err });
        pushJobLog(coffeeJob, { stage: "error", message: coffeeJob.error });
        await persistJobRecord("coffee-content", coffeeJob);
      }
    }
  );
});

app.post("/api/coffee-content/cancel", (_req, res) => {
  if (!coffeeJob?.running) {
    return res.status(400).json({ error: "No coffee content fetch running" });
  }
  coffeeJob.controller.abort();
  res.json({ ok: true });
});

app.get("/api/rag/status", async (_req, res) => {
  try {
    const status = await runRag(["status"], { timeoutMs: 60_000 });
    res.json({
      ready: Boolean(status.ready),
      document_count: status.document_count ?? 0,
      indexing: Boolean(indexJob?.running),
      index_error: indexJob?.error ?? null,
      last_index_result: indexJob?.result ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/rag/index/status", (_req, res) => {
  if (!indexJob) {
    return res.json({ running: false });
  }
  res.json({
    running: indexJob.running,
    startedAt: indexJob.startedAt,
    finishedAt: indexJob.finishedAt,
    error: indexJob.error,
    result: indexJob.result,
  });
});

app.post("/api/rag/index", async (_req, res) => {
  if (shuttingDown) {
    return res.status(503).json({ error: "Server is shutting down" });
  }
  if (indexJob?.running) {
    return res.status(409).json({ error: "Indexing already running" });
  }

  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    return res.status(400).json({ error: "Set OPENAI_API_KEY in .env first" });
  }

  indexJob = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    result: null,
  };

  acceptAndRun(res, { ok: true, message: "Indexing started" }, async () => {
    try {
      const result = await runRag(["index"], {
        timeoutMs: 900_000,
        openaiApiKey: apiKey,
      });
      finishJob(indexJob, {
        result: {
          indexed: result.indexed,
          embedded: result.embedded,
          chroma_path: result.chroma_path,
          bm25_path: result.bm25_path,
        },
      });
      await persistJobRecord("rag-index", indexJob);
    } catch (err) {
      finishJob(indexJob, { error: err });
      await persistJobRecord("rag-index", indexJob);
    }
  });
});

app.post(
  "/api/rag/search",
  searchDailyLimit,
  searchGlobalRateLimit,
  searchRateLimit,
  searchQueryGuard,
  async (req, res) => {
    const apiKey = getOpenAiApiKey();
    if (!apiKey) {
      return res.status(400).json({ error: "Set OPENAI_API_KEY in .env first" });
    }

    const googleApiKey = getGoogleApiKey();
    if (!googleApiKey) {
      return res.status(400).json({
        error:
          "Set GOOGLE_PLACES_API_KEY (or GOOGLE_API_KEY) in .env for location-aware search",
      });
    }

    const query = req.searchQuery;

    let topN = Number(req.body?.topN ?? 5);
    if (!Number.isFinite(topN)) topN = 5;
    topN = Math.max(1, Math.min(20, Math.round(topN)));

    const cacheKey = searchCacheKey(query, topN);
    const cached = searchCache.get(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    const started = Date.now();
    try {
      const result = await runRag(
        ["search", "--query", query, "--top-n", String(topN)],
        {
          timeoutMs: 180_000,
          openaiApiKey: apiKey,
          googleApiKey,
        }
      );
      const results = result.results ?? [];
      const payload = {
        answer: result.answer,
        intro: result.intro ?? null,
        top_n: result.top_n,
        results,
        vector_count: result.vector_count,
        bm25_count: result.bm25_count,
        location: result.location ?? null,
      };
      searchCache.set(cacheKey, payload);
      console.log(
        JSON.stringify({
          msg: "search_ok",
          requestId: req.requestId,
          topN,
          results: results.length,
          locationApplied: Boolean(payload.location?.applied),
          radiusKm: payload.location?.radius_km ?? null,
          promptTokens: result.usage?.prompt_tokens ?? null,
          completionTokens: result.usage?.completion_tokens ?? null,
          totalTokens: result.usage?.total_tokens ?? null,
          durationMs: Date.now() - started,
        })
      );
      res.json(payload);
    } catch (err) {
      const mapped = publicSearchError(err, req.requestId);
      console.error(
        JSON.stringify({
          msg: "search_failed",
          requestId: req.requestId,
          error: mapped.detail,
        })
      );
      res.status(mapped.status).json(mapped.body);
    }
  }
);

assertAdminAuthConfigured();

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      msg: "server_listen",
      port: Number(PORT),
      dataDir: getDataDir(),
      adminAuth: isAdminAuthEnabled(),
    })
  );
  Promise.resolve()
    .then(() => warmupRagWorker())
    .catch((err) => {
      console.error(
        JSON.stringify({
          msg: "rag_worker_warmup_failed",
          error: err.message || String(err),
        })
      );
    });
});

function abortJobs() {
  try {
    collectionJob?.controller?.abort();
  } catch {
    // ignore
  }
  try {
    coffeeJob?.controller?.abort();
  } catch {
    // ignore
  }
}

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ msg: "shutdown", signal }));
  abortJobs();
  shutdownRagWorker();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
