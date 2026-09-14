/**
 * Composition root: pick CafeRepository from STORAGE_BACKEND.
 * DATABASE_URL is read only from the environment (never hardcoded).
 */
import "dotenv/config";
import {
  STORAGE_SQLITE_CHROMA,
  STORAGE_SUPABASE,
  getStorageBackend,
  requireDatabaseUrl,
} from "../core/contracts.js";
import { createSqliteRepository } from "./sqliteRepository.js";
import { createPostgresRepository } from "./postgresRepository.js";

let cached = null;

export function createRepository() {
  const backend = getStorageBackend();
  if (backend === STORAGE_SUPABASE) {
    requireDatabaseUrl();
    return createPostgresRepository();
  }
  return createSqliteRepository();
}

/** Lazy singleton used by Express / places. */
export function getRepository() {
  if (!cached) cached = createRepository();
  return cached;
}

export function resetRepositoryCache() {
  cached = null;
}

export { STORAGE_SQLITE_CHROMA, STORAGE_SUPABASE, getStorageBackend };
