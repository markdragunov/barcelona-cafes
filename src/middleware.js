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

/** Simple in-memory rate limit for public search (per IP). */
export function rateLimit({ windowMs = 60_000, max = 30 } = {}) {
  const hits = new Map();

  return (req, res, next) => {
    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "unknown";
    const now = Date.now();
    let bucket = hits.get(ip);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      hits.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return res
        .status(429)
        .json({ error: "Too many search requests. Try again shortly." });
    }
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
