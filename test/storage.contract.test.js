/**
 * Contract + factory tests for CafeRepository adapters.
 * Run: node --test test/storage.contract.test.js
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteRepository } from "../src/storage/sqliteRepository.js";
import {
  createRepository,
  resetRepositoryCache,
  getStorageBackend,
} from "../src/storage/factory.js";
import { STORAGE_SQLITE_CHROMA, STORAGE_SUPABASE } from "../src/core/contracts.js";

const sampleCafe = {
  place_id: "test_place_1",
  name: "Test Cafe",
  address: "Carrer de Test 1",
  rating: 4.5,
  user_rating_count: 10,
  website: "https://example.com",
  place_types: '["cafe"]',
  latitude: 41.4,
  longitude: 2.17,
  neighborhood_id: "gracia",
  neighborhood_name: "Gràcia",
};

const sampleReviews = [
  {
    place_id: "test_place_1",
    author_name: "Ada",
    rating: 5,
    text: "Great coffee",
    publish_time: "2024-01-01T00:00:00Z",
    relative_publish_time_description: "a year ago",
    language_code: "en",
  },
];

async function runRepositoryContract(repo) {
  await repo.upsertCafeWithReviews(sampleCafe, sampleReviews);
  const summary = await repo.getSummary("all-barcelona");
  assert.equal(summary.total_cafes, 1);
  assert.ok(summary.average_rating != null);

  const exported = await repo.getCafesForExport("all-barcelona");
  assert.equal(exported.length, 1);
  assert.equal(exported[0].place_id, "test_place_1");
  assert.equal(exported[0].reviews.length, 1);

  const needing = await repo.getCafesNeedingCoffeeContent("all-barcelona");
  assert.equal(needing.length, 1);

  await repo.updateCoffeeContent("test_place_1", '{"results":[]}');
  const withCoffee = await repo.countCafesWithCoffeeContent("all-barcelona");
  assert.equal(withCoffee, 1);

  assert.equal(await repo.getCafeCount(), 1);
  const coords = await repo.listCafeCoordinates();
  assert.equal(coords.length, 1);
  assert.equal(coords[0].place_id, "test_place_1");

  const known = await repo.listKnownPlaceIds();
  assert.deepEqual(known, ["test_place_1"]);

  const second = {
    ...sampleCafe,
    place_id: "test_place_2",
    name: "Second Cafe",
  };
  await repo.upsertCafeWithReviews(second, [
    { ...sampleReviews[0], place_id: "test_place_2", author_name: "Bea" },
  ]);
  const exportedTwo = await repo.getCafesForExport("all-barcelona");
  assert.equal(exportedTwo.length, 2);
  assert.equal(
    exportedTwo.find((row) => row.place_id === "test_place_1").reviews.length,
    1
  );
  assert.equal(
    exportedTwo.find((row) => row.place_id === "test_place_2").reviews.length,
    1
  );
}

describe("SqliteCafeRepository contract", () => {
  let tmpDir;
  let repo;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-sqlite-"));
    process.env.SQLITE_PATH = path.join(tmpDir, "cafes.db");
    process.env.DATA_DIR = tmpDir;
    repo = createSqliteRepository();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  it("upsert → summary → export → coffee content → count", async () => {
    await runRepositoryContract(repo);
  });

  it("indexes cafe coordinates", () => {
    const db = new DatabaseSync(process.env.SQLITE_PATH);
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all();
      assert.ok(rows.some((row) => row.name === "idx_cafes_coords"));
    } finally {
      db.close();
    }
  });
});

describe("storage factory", () => {
  after(() => {
    resetRepositoryCache();
    delete process.env.STORAGE_BACKEND;
    delete process.env.DATABASE_URL;
  });

  it("defaults to sqlite+chroma", () => {
    delete process.env.STORAGE_BACKEND;
    assert.equal(getStorageBackend(), STORAGE_SQLITE_CHROMA);
  });

  it("fails fast when supabase without DATABASE_URL", () => {
    process.env.STORAGE_BACKEND = "supabase";
    delete process.env.DATABASE_URL;
    resetRepositoryCache();
    assert.throws(() => createRepository(), /DATABASE_URL/);
  });

  it("selects supabase when DATABASE_URL is set", () => {
    process.env.STORAGE_BACKEND = STORAGE_SUPABASE;
    process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:54329/testdb";
    resetRepositoryCache();
    const repo = createRepository();
    assert.equal(repo.backend, "postgres");
  });
});

describe("PostgresCafeRepository contract", () => {
  const url = String(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "").trim();
  const shouldRun = Boolean(url) && process.env.RUN_PG_CONTRACT === "1";

  it(
    shouldRun
      ? "upsert → summary → export against disposable Postgres"
      : "skipped (set RUN_PG_CONTRACT=1 and TEST_DATABASE_URL)",
    { skip: !shouldRun },
    async () => {
      process.env.STORAGE_BACKEND = "supabase";
      process.env.DATABASE_URL = url;
      resetRepositoryCache();
      const { createPostgresRepository } = await import(
        "../src/storage/postgresRepository.js"
      );
      const repo = createPostgresRepository();
      const client = await repo.pool.connect();
      try {
        await client.query("DELETE FROM reviews WHERE place_id = $1", [
          sampleCafe.place_id,
        ]);
        await client.query("DELETE FROM cafes WHERE place_id = $1", [
          sampleCafe.place_id,
        ]);
      } finally {
        client.release();
      }
      await runRepositoryContract(repo);
      await repo.pool.end();
    }
  );
});
