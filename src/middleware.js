import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import {
  getAdminEmails,
  getAdminPassword,
  getAdminUser,
  getSupabaseIssuer,
  getSupabaseJwksUrl,
  getSupabaseJwtSecret,
  isBasicAdminAuthEnabled,
  isSupabaseAdminAuthEnabled,
} from "./config.js";

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function extractBearer(header) {
  if (!header || typeof header !== "string") return null;
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

let jwksCache = null;
let jwksCacheUrl = "";

/** Remote JWKS for projects using asymmetric signing keys (ES256/RS256). */
function getJwks() {
  const url = getSupabaseJwksUrl();
  if (!url) {
    const err = new Error("SUPABASE_URL is required to verify asymmetric tokens");
    err.code = "invalid_token";
    throw err;
  }
  if (!jwksCache || jwksCacheUrl !== url) {
    jwksCacheUrl = url;
    jwksCache = createRemoteJWKSet(new URL(url));
  }
  return jwksCache;
}

/** Reset the cached JWKS (tests, or after SUPABASE_URL changes). */
export function resetJwksCache() {
  jwksCache = null;
  jwksCacheUrl = "";
}

/**
 * Verify a Supabase access token. Legacy projects sign with the shared HS256
 * secret; projects created with JWT signing keys use ES256/RS256 over JWKS.
 */
async function verifySupabaseAccessToken(token) {
  const { alg } = decodeProtectedHeader(token);
  const options = { audience: "authenticated", issuer: getSupabaseIssuer() };

  let payload;
  if (alg === "HS256") {
    const secret = getSupabaseJwtSecret();
    if (!secret) {
      const err = new Error("SUPABASE_JWT_SECRET is required for HS256 tokens");
      err.code = "invalid_token";
      throw err;
    }
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      ...options,
      algorithms: ["HS256"],
    }));
  } else {
    ({ payload } = await jwtVerify(token, getJwks(), {
      ...options,
      algorithms: ["ES256", "RS256"],
    }));
  }

  const email = String(payload.email || "")
    .trim()
    .toLowerCase();
  if (!email) {
    const err = new Error("Token missing email claim");
    err.code = "invalid_token";
    throw err;
  }
  return { email, sub: payload.sub, payload };
}

/**
 * Protect admin UI APIs (and optionally admin HTML when called directly).
 * - Supabase Auth (preferred): Bearer JWT + ADMIN_EMAILS allowlist
 * - Legacy Basic: ADMIN_USER / ADMIN_PASSWORD when Supabase Auth is not configured
 * - Dev: if neither is configured, allows all requests
 */
export async function requireAdmin(req, res, next) {
  if (isSupabaseAdminAuthEnabled()) {
    const token = extractBearer(req.headers.authorization || "");
    if (!token) {
      return res.status(401).json({ error: "Admin authentication required" });
    }
    try {
      const user = await verifySupabaseAccessToken(token);
      const allowed = getAdminEmails();
      if (!allowed.includes(user.email)) {
        return res.status(403).json({
          error: "This account is not authorized for admin access",
        });
      }
      req.admin = user;
      return next();
    } catch {
      return res.status(401).json({ error: "Invalid or expired admin session" });
    }
  }

  if (!isBasicAdminAuthEnabled()) {
    return next();
  }

  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Barcelona Cafes Admin"');
    return res.status(401).json({ error: "Admin authentication required" });
  }

  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return res.status(401).json({ error: "Invalid authorization header" });
  }

  const sep = decoded.indexOf(":");
  const user = sep >= 0 ? decoded.slice(0, sep) : "";
  const pass = sep >= 0 ? decoded.slice(sep + 1) : "";

  if (!safeEqual(user, getAdminUser()) || !safeEqual(pass, getAdminPassword())) {
    res.set("WWW-Authenticate", 'Basic realm="Barcelona Cafes Admin"');
    return res.status(401).json({ error: "Invalid admin credentials" });
  }

  req.admin = { email: getAdminUser(), sub: "basic" };
  return next();
}

/**
 * Rate-limit key for a request.
 *
 * `req.ip` is resolved by Express from the `trust proxy` setting, so it is the
 * address of the last untrusted hop. Reading `X-Forwarded-For` directly would
 * let any caller rotate the header and get unlimited throughput.
 *
 * @param {import("express").Request} req
 * @returns {string}
 */
function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function setRetryAfter(res, resetAt, now) {
  res.set("Retry-After", String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
}

/** Drop expired buckets, then the oldest ones, to keep the map bounded. */
function prune(hits, now, windowMs, maxKeys) {
  for (const [key, bucket] of hits) {
    if (now - bucket.start >= windowMs) hits.delete(key);
  }
  while (hits.size > maxKeys) {
    const oldest = hits.keys().next().value;
    if (oldest === undefined) break;
    hits.delete(oldest);
  }
}

/** Simple in-memory rate limit for public search (per client address). */
export function rateLimit({
  windowMs = 60_000,
  max = 30,
  maxKeys = 20_000,
} = {}) {
  const hits = new Map();

  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > maxKeys) prune(hits, now, windowMs, maxKeys);

    const key = clientKey(req);
    let bucket = hits.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      hits.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      setRetryAfter(res, bucket.start + windowMs, now);
      return res
        .status(429)
        .json({ error: "Too many search requests. Try again shortly." });
    }
    return next();
  };
}

/**
 * Ceiling on total requests per window, ignoring who is calling. Per-client
 * limits do nothing against a flood spread over many addresses; this bounds
 * the worst-case spend regardless of how the traffic is distributed.
 */
export function globalRateLimit({ windowMs = 60_000, max = 120 } = {}) {
  let start = Date.now();
  let count = 0;

  return (_req, res, next) => {
    const now = Date.now();
    if (now - start >= windowMs) {
      start = now;
      count = 0;
    }
    count += 1;
    if (count > max) {
      setRetryAfter(res, start + windowMs, now);
      return res.status(429).json({
        error: "Search is busy right now. Try again in a minute.",
      });
    }
    return next();
  };
}

/**
 * Validate a public search query before any billable work happens: an
 * unbounded body would otherwise be embedded and charged in full.
 * Stores the normalized query on `req.searchQuery`.
 */
export function validateSearchQuery({ maxChars = 300 } = {}) {
  return (req, res, next) => {
    const query = String(req.body?.query ?? "").trim();
    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }
    if (query.length > maxChars) {
      return res.status(400).json({
        error: `Query is too long. Use ${maxChars} characters or fewer.`,
      });
    }
    req.searchQuery = query;
    return next();
  };
}

export function requestLog(req, res, next) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  req.requestId = id;
  const start = Date.now();
  res.setHeader("X-Request-Id", id);
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(
      JSON.stringify({
        requestId: id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: ms,
      })
    );
  });
  next();
}
