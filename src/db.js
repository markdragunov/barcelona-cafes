import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const dbPath = path.join(dataDir, "cafes.db");

fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cafes (
    place_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT,
    rating REAL,
    user_rating_count INTEGER,
    website TEXT,
    place_types TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    neighborhood_id TEXT,
    neighborhood_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    place_id TEXT NOT NULL,
    author_name TEXT,
    rating REAL,
    text TEXT,
    publish_time TEXT,
    relative_publish_time_description TEXT,
    language_code TEXT,
    UNIQUE(place_id, author_name, publish_time, text),
    FOREIGN KEY (place_id) REFERENCES cafes(place_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_cafes_neighborhood ON cafes(neighborhood_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_place ON reviews(place_id);
`);

const cafeColumns = db.prepare("PRAGMA table_info(cafes)").all();
if (!cafeColumns.some((col) => col.name === "coffee_content")) {
  db.exec("ALTER TABLE cafes ADD COLUMN coffee_content TEXT");
}

export function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? null;
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export function getApiKey() {
  return getSetting("google_places_api_key");
}

export function setApiKey(apiKey) {
  setSetting("google_places_api_key", apiKey);
}

export function getParallelApiKey() {
  return getSetting("parallel_api_key");
}

export function setParallelApiKey(apiKey) {
  setSetting("parallel_api_key", apiKey);
}

export function getOpenAiApiKey() {
  return getSetting("openai_api_key");
}

export function setOpenAiApiKey(apiKey) {
  setSetting("openai_api_key", apiKey);
}

const upsertCafeStmt = db.prepare(`
  INSERT INTO cafes (
    place_id, name, address, rating, user_rating_count, website,
    place_types, latitude, longitude, neighborhood_id, neighborhood_name, updated_at
  ) VALUES (
    @place_id, @name, @address, @rating, @user_rating_count, @website,
    @place_types, @latitude, @longitude, @neighborhood_id, @neighborhood_name, datetime('now')
  )
  ON CONFLICT(place_id) DO UPDATE SET
    name = excluded.name,
    address = COALESCE(excluded.address, cafes.address),
    rating = COALESCE(excluded.rating, cafes.rating),
    user_rating_count = COALESCE(excluded.user_rating_count, cafes.user_rating_count),
    website = COALESCE(excluded.website, cafes.website),
    place_types = excluded.place_types,
    latitude = COALESCE(excluded.latitude, cafes.latitude),
    longitude = COALESCE(excluded.longitude, cafes.longitude),
    neighborhood_id = CASE
      WHEN cafes.neighborhood_id IS NULL OR cafes.neighborhood_id = '' THEN excluded.neighborhood_id
      ELSE cafes.neighborhood_id
    END,
    neighborhood_name = CASE
      WHEN cafes.neighborhood_name IS NULL OR cafes.neighborhood_name = '' THEN excluded.neighborhood_name
      ELSE cafes.neighborhood_name
    END,
    updated_at = datetime('now')
`);

const insertReviewStmt = db.prepare(`
  INSERT OR IGNORE INTO reviews (
    place_id, author_name, rating, text, publish_time,
    relative_publish_time_description, language_code
  ) VALUES (
    @place_id, @author_name, @rating, @text, @publish_time,
    @relative_publish_time_description, @language_code
  )
`);

export function upsertCafeWithReviews(cafe, reviews) {
  db.exec("BEGIN");
  try {
    upsertCafeStmt.run(cafe);
    for (const review of reviews) {
      insertReviewStmt.run(review);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function neighborhoodFilter(neighborhoodId) {
  if (!neighborhoodId || neighborhoodId === "all-barcelona") {
    return { clause: "", params: [] };
  }
  return {
    clause: "WHERE neighborhood_id = ?",
    params: [neighborhoodId],
  };
}

export function getSummary(neighborhoodId) {
  const { clause, params } = neighborhoodFilter(neighborhoodId);
  const row = db
    .prepare(
      `SELECT
        COUNT(*) AS total_cafes,
        ROUND(AVG(rating), 2) AS average_rating,
        SUM(CASE WHEN website IS NOT NULL AND website != '' THEN 1 ELSE 0 END) AS with_website,
        SUM(CASE WHEN user_rating_count IS NOT NULL AND user_rating_count > 0 THEN 1 ELSE 0 END) AS with_reviews,
        SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END) AS with_coordinates
      FROM cafes
      ${clause}`
    )
    .get(...params);

  return {
    total_cafes: Number(row?.total_cafes ?? 0),
    average_rating: row?.average_rating ?? null,
    with_website: Number(row?.with_website ?? 0),
    with_reviews: Number(row?.with_reviews ?? 0),
    with_coordinates: Number(row?.with_coordinates ?? 0),
  };
}

export function getCafesForExport(neighborhoodId) {
  const { clause, params } = neighborhoodFilter(neighborhoodId);
  const cafes = db
    .prepare(
      `SELECT
        place_id, name, address, rating, user_rating_count, website,
        place_types, latitude, longitude, neighborhood_id, neighborhood_name,
        coffee_content
      FROM cafes
      ${clause}
      ORDER BY name COLLATE NOCASE`
    )
    .all(...params);

  const reviewStmt = db.prepare(
    `SELECT author_name, rating, text, publish_time,
            relative_publish_time_description, language_code
     FROM reviews WHERE place_id = ? ORDER BY publish_time DESC`
  );

  return cafes.map((cafe) => ({
    ...cafe,
    reviews: reviewStmt.all(cafe.place_id),
  }));
}

/**
 * Cafes with a website and empty coffee_content for Parallel extract.
 * neighborhoodId "all-barcelona" (or empty) = all neighborhoods.
 */
export function getCafesNeedingCoffeeContent(neighborhoodId) {
  const filters = [
    "website IS NOT NULL",
    "TRIM(website) != ''",
    "(coffee_content IS NULL OR TRIM(coffee_content) = '')",
  ];
  const params = [];

  if (neighborhoodId && neighborhoodId !== "all-barcelona") {
    filters.push("neighborhood_id = ?");
    params.push(neighborhoodId);
  }

  return db
    .prepare(
      `SELECT place_id, name, website, neighborhood_id, neighborhood_name
       FROM cafes
       WHERE ${filters.join(" AND ")}
       ORDER BY name COLLATE NOCASE`
    )
    .all(...params);
}

/** Cafes in scope that already have coffee_content (skipped). */
export function countCafesWithCoffeeContent(neighborhoodId) {
  const filters = [
    "website IS NOT NULL",
    "TRIM(website) != ''",
    "coffee_content IS NOT NULL",
    "TRIM(coffee_content) != ''",
  ];
  const params = [];

  if (neighborhoodId && neighborhoodId !== "all-barcelona") {
    filters.push("neighborhood_id = ?");
    params.push(neighborhoodId);
  }

  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM cafes WHERE ${filters.join(" AND ")}`
    )
    .get(...params);
  return Number(row?.n ?? 0);
}

export function updateCoffeeContent(placeId, coffeeContent) {
  db.prepare(
    `UPDATE cafes
     SET coffee_content = ?, updated_at = datetime('now')
     WHERE place_id = ?`
  ).run(coffeeContent, placeId);
}

export function getCafeCount() {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM cafes").get().n);
}

export default db;
