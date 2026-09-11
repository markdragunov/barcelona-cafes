/**
 * CafeRepository contract (JSDoc). Implementations: SQLite | Postgres.
 *
 * @typedef {object} CafeRepository
 * @property {(cafe: object, reviews: object[]) => Promise<void>} upsertCafeWithReviews
 * @property {(neighborhoodId: string) => Promise<object>} getSummary
 * @property {(neighborhoodId: string) => Promise<object[]>} getCafesForExport
 * @property {(neighborhoodId: string) => Promise<object[]>} getCafesNeedingCoffeeContent
 * @property {(neighborhoodId: string) => Promise<number>} countCafesWithCoffeeContent
 * @property {(placeId: string, coffeeContent: string) => Promise<void>} updateCoffeeContent
 * @property {() => Promise<number>} getCafeCount
 * @property {() => Promise<{place_id: string, latitude: number, longitude: number}[]>} listCafeCoordinates
 */

/**
 * @typedef {object} IndexStoreStatus
 * @property {boolean} ready
 * @property {number} document_count
 * @property {string} backend
 */

/**
 * IndexStore is owned by Python RAG; Node only triggers rebuild via ragBridge.
 * This file documents the shared env contract for STORAGE_BACKEND.
 */

export const STORAGE_SQLITE_CHROMA = "sqlite+chroma";
export const STORAGE_SUPABASE = "supabase";

export function getStorageBackend() {
  const raw = String(process.env.STORAGE_BACKEND || STORAGE_SQLITE_CHROMA)
    .trim()
    .toLowerCase();
  if (raw === STORAGE_SUPABASE || raw === "postgres" || raw === "pg") {
    return STORAGE_SUPABASE;
  }
  return STORAGE_SQLITE_CHROMA;
}

export function requireDatabaseUrl() {
  const url = String(process.env.DATABASE_URL || "").trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is required when STORAGE_BACKEND=supabase (set it in .env; never hardcode)."
    );
  }
  return url;
}
