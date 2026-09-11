/**
 * Secrets and runtime config from environment (.env via dotenv).
 * Never hardcode API keys here.
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function env(...names) {
  for (const name of names) {
    const value = String(process.env[name] ?? "").trim();
    if (value) return value;
  }
  return "";
}

/** Integer env value, clamped to [min, max]; falls back when unset or unparseable. */
function envInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function getDataDir() {
  const configured = env("DATA_DIR");
  if (configured) return path.resolve(configured);
  return path.join(ROOT, "data");
}

export function getGoogleApiKey() {
  return env("GOOGLE_PLACES_API_KEY", "GOOGLE_API_KEY");
}

export function getParallelApiKey() {
  return env("PARALLEL_API_KEY");
}

export function getOpenAiApiKey() {
  return env("OPENAI_API_KEY");
}

/*
 * Public search limits. /api/rag/search is unauthenticated and every call bills
 * an OpenAI embedding, an OpenAI completion and often a Google geocode, so the
 * endpoint needs both per-client and absolute ceilings.
 */

/** Window shared by the per-client and global search limits. */
export function getSearchRateLimitWindowMs() {
  return envInt("SEARCH_RATE_LIMIT_WINDOW_MS", 60_000, {
    min: 1_000,
    max: 3_600_000,
  });
}

/** Per-client search requests allowed per window. */
export function getSearchRateLimitMax() {
  return envInt("SEARCH_RATE_LIMIT_MAX", 30, { min: 1 });
}

/** Search requests allowed per window across all clients combined. */
export function getSearchGlobalRateLimitMax() {
  return envInt("SEARCH_GLOBAL_RATE_LIMIT_MAX", 120, { min: 1 });
}

/** Longest search query accepted before anything is sent to OpenAI. */
export function getSearchMaxQueryChars() {
  return envInt("SEARCH_MAX_QUERY_CHARS", 300, { min: 16, max: 4_000 });
}

/** Lifetime of a cached search answer. 0 disables the cache. */
export function getSearchCacheTtlMs() {
  return envInt("SEARCH_CACHE_TTL_MS", 300_000, { min: 0, max: 3_600_000 });
}

/** Cached search answers kept in memory before the oldest are evicted. */
export function getSearchCacheMaxEntries() {
  return envInt("SEARCH_CACHE_MAX_ENTRIES", 200, { min: 1, max: 10_000 });
}

export function getAdminUser() {
  return env("ADMIN_USER") || "admin";
}

export function getAdminPassword() {
  return env("ADMIN_PASSWORD");
}

export function getSupabaseUrl() {
  return env("SUPABASE_URL").replace(/\/$/, "");
}

export function getSupabaseAnonKey() {
  return env("SUPABASE_ANON_KEY");
}

/** Shared HS256 secret. Absent on projects that use asymmetric JWT signing keys. */
export function getSupabaseJwtSecret() {
  return env("SUPABASE_JWT_SECRET");
}

/** Expected `iss` claim on Supabase access tokens. */
export function getSupabaseIssuer() {
  const url = getSupabaseUrl();
  return url ? `${url}/auth/v1` : "";
}

/** JWKS endpoint used when the project signs tokens with ES256/RS256. */
export function getSupabaseJwksUrl() {
  const url = getSupabaseUrl();
  return url ? `${url}/auth/v1/.well-known/jwks.json` : "";
}

export function getSupabaseServiceRoleKey() {
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

/** Normalized allowlist of admin emails. */
export function getAdminEmails() {
  return env("ADMIN_EMAILS")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * True when magic-link Supabase Auth is fully configured.
 * SUPABASE_JWT_SECRET is optional: projects using asymmetric signing keys are
 * verified against the project JWKS, which only needs SUPABASE_URL.
 */
export function isSupabaseAdminAuthEnabled() {
  return Boolean(
    getSupabaseUrl() && getSupabaseAnonKey() && getAdminEmails().length > 0
  );
}

/** True when ADMIN_PASSWORD is set — legacy HTTP Basic (used only if Supabase Auth is off). */
export function isBasicAdminAuthEnabled() {
  return Boolean(getAdminPassword()) && !isSupabaseAdminAuthEnabled();
}

/** True when any admin gate is active. */
export function isAdminAuthEnabled() {
  return isSupabaseAdminAuthEnabled() || isBasicAdminAuthEnabled();
}

/** @deprecated Use getGoogleApiKey */
export function getApiKey() {
  return getGoogleApiKey();
}
