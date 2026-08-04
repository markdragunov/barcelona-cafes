import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getApiKey,
  setApiKey,
  getSummary,
  getCafesForExport,
} from "./db.js";
import {
  NEIGHBORHOOD_LIST,
  getNeighborhood,
  getCollectableNeighborhoods,
} from "./neighborhoods.js";
import { collectCafes } from "./places.js";
import { SEARCH_QUERIES } from "./queries.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3847;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

let collectionJob = null;

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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
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
  const key = getApiKey();
  res.json({
    configured: Boolean(key),
    masked: maskKey(key),
  });
});

app.post("/api/settings/api-key", (req, res) => {
  const apiKey = String(req.body?.apiKey ?? "").trim();
  if (!apiKey) {
    return res.status(400).json({ error: "API key is required" });
  }
  setApiKey(apiKey);
  res.json({ ok: true, configured: true, masked: maskKey(apiKey) });
});

app.get("/api/summary", (req, res) => {
  const neighborhoodId = String(req.query.neighborhood || "all-barcelona");
  if (!getNeighborhood(neighborhoodId)) {
    return res.status(400).json({ error: "Unknown neighborhood" });
  }
  res.json(getSummary(neighborhoodId));
});

app.get("/api/export.csv", (req, res) => {
  const neighborhoodId = String(req.query.neighborhood || "all-barcelona");
  const neighborhood = getNeighborhood(neighborhoodId);
  if (!neighborhood) {
    return res.status(400).json({ error: "Unknown neighborhood" });
  }

  const cafes = getCafesForExport(neighborhoodId);
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
  if (collectionJob?.running) {
    return res.status(409).json({ error: "Collection already running" });
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return res.status(400).json({ error: "Save a Google Places API key first" });
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

  const pushLog = (entry) => {
    collectionJob.logs.push({
      at: new Date().toISOString(),
      ...entry,
    });
    if (collectionJob.logs.length > 500) {
      collectionJob.logs = collectionJob.logs.slice(-400);
    }
  };

  res.status(202).json({
    ok: true,
    message: "Collection started",
    neighborhoodId,
    neighborhoods: neighborhoods.map((n) => n.name),
    queryCount: SEARCH_QUERIES.length,
  });

  try {
    const result = await collectCafes({
      apiKey,
      neighborhoods,
      signal: controller.signal,
      onProgress: (event) => pushLog(event),
    });
    collectionJob.result = result;
    collectionJob.running = false;
    collectionJob.finishedAt = new Date().toISOString();
    pushLog({
      stage: "done",
      message: `Done. Found ${result.found} places, upserted ${result.saved} cafe records.`,
    });
  } catch (err) {
    collectionJob.error = err.message || String(err);
    collectionJob.running = false;
    collectionJob.finishedAt = new Date().toISOString();
    pushLog({ stage: "error", message: collectionJob.error });
  }
});

app.post("/api/collect/cancel", (_req, res) => {
  if (!collectionJob?.running) {
    return res.status(400).json({ error: "No collection running" });
  }
  collectionJob.controller.abort();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Barcelona cafes admin → http://localhost:${PORT}`);
});
