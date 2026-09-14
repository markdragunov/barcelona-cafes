/**
 * Cost-abuse protections for the public /api/rag/search endpoint.
 * Run: node --test test/search.protection.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  rateLimit,
  globalRateLimit,
  validateSearchQuery,
  securityHeaders,
} from "../src/middleware.js";
import { createSearchCache, searchCacheKey } from "../src/searchCache.js";

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    set(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
  };
}

/** Run one request through a middleware; returns { res, passed }. */
function call(middleware, req) {
  const res = mockRes();
  let passed = false;
  middleware(req, res, () => {
    passed = true;
  });
  return { res, passed };
}

describe("per-client search rate limit", () => {
  it("ignores X-Forwarded-For so a spoofed header cannot rotate buckets", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 3 });
    const attacker = (i) => ({
      ip: "203.0.113.9",
      socket: { remoteAddress: "10.0.0.2" },
      headers: { "x-forwarded-for": `198.51.100.${i}, 10.0.0.2` },
    });

    for (let i = 0; i < 3; i += 1) {
      const { passed } = call(limiter, attacker(i));
      assert.equal(passed, true, `request ${i + 1} should pass`);
    }

    const blocked = call(limiter, attacker(99));
    assert.equal(blocked.passed, false);
    assert.equal(blocked.res.statusCode, 429);
    assert.match(blocked.res.body.error, /Too many search requests/);
    assert.ok(Number(blocked.res.headers["retry-after"]) > 0);
  });

  it("keeps separate buckets per real client address", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1 });
    const req = (ip) => ({ ip, socket: {}, headers: {} });

    assert.equal(call(limiter, req("203.0.113.1")).passed, true);
    assert.equal(call(limiter, req("203.0.113.1")).passed, false);
    assert.equal(call(limiter, req("203.0.113.2")).passed, true);
  });

  it("falls back to the socket address when req.ip is unavailable", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1 });
    const req = () => ({
      socket: { remoteAddress: "203.0.113.7" },
      headers: { "x-forwarded-for": `${Math.random()}` },
    });

    assert.equal(call(limiter, req()).passed, true);
    assert.equal(call(limiter, req()).passed, false);
  });

  it("starts a fresh window once the old one elapses", () => {
    const limiter = rateLimit({ windowMs: 1, max: 1 });
    const req = { ip: "203.0.113.5", socket: {}, headers: {} };

    assert.equal(call(limiter, req).passed, true);
    const later = Date.now() + 5;
    while (Date.now() < later) {
      // spin briefly so the window expires
    }
    assert.equal(call(limiter, req).passed, true);
  });
});

describe("global search ceiling", () => {
  it("blocks past the cap even when every request has a different address", () => {
    const limiter = globalRateLimit({ windowMs: 60_000, max: 4 });
    const req = (i) => ({
      ip: `198.51.100.${i}`,
      socket: {},
      headers: {},
    });

    for (let i = 0; i < 4; i += 1) {
      assert.equal(call(limiter, req(i)).passed, true, `request ${i + 1}`);
    }

    const blocked = call(limiter, req(200));
    assert.equal(blocked.passed, false);
    assert.equal(blocked.res.statusCode, 429);
    assert.match(blocked.res.body.error, /busy/i);
  });
});

describe("search query validation", () => {
  const guard = validateSearchQuery({ maxChars: 50 });

  it("rejects a query longer than the limit with 400", () => {
    const { res, passed } = call(guard, { body: { query: "a".repeat(51) } });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /50 characters or fewer/);
  });

  it("rejects a missing or blank query with 400", () => {
    assert.equal(call(guard, { body: {} }).res.statusCode, 400);
    assert.equal(call(guard, { body: { query: "   " } }).res.statusCode, 400);
  });

  it("accepts a normal query and exposes it trimmed", () => {
    const req = { body: { query: "  quiet cafe in Gracia with wifi  " } };
    const { passed } = call(guard, req);
    assert.equal(passed, true);
    assert.equal(req.searchQuery, "quiet cafe in Gracia with wifi");
  });

  it("counts characters, so a multi-megabyte body cannot slip through", () => {
    const { res } = call(guard, { body: { query: "x".repeat(200_000) } });
    assert.equal(res.statusCode, 400);
  });
});

describe("search response cache", () => {
  it("normalizes case and whitespace but not topN", () => {
    assert.equal(
      searchCacheKey("  Best   Coffee ", 5),
      searchCacheKey("best coffee", 5)
    );
    assert.notEqual(searchCacheKey("best coffee", 5), searchCacheKey("best coffee", 6));
  });

  it("serves a stored answer for an identical query", () => {
    const cache = createSearchCache({ ttlMs: 60_000, maxEntries: 10 });
    const key = searchCacheKey("flat white in Eixample", 5);
    assert.equal(cache.get(key), null);
    cache.set(key, { answer: "cached" });
    assert.deepEqual(cache.get(key), { answer: "cached" });
  });

  it("expires entries after the TTL", async () => {
    const cache = createSearchCache({ ttlMs: 5, maxEntries: 10 });
    cache.set("k", { answer: "stale" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(cache.get("k"), null);
  });

  it("evicts the oldest entries past maxEntries", () => {
    const cache = createSearchCache({ ttlMs: 60_000, maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    assert.equal(cache.size, 2);
    assert.equal(cache.get("a"), null);
    assert.equal(cache.get("c"), 3);
  });

  it("stores nothing when the TTL is 0", () => {
    const cache = createSearchCache({ ttlMs: 0 });
    cache.set("k", 1);
    assert.equal(cache.enabled, false);
    assert.equal(cache.get("k"), null);
    assert.equal(cache.size, 0);
  });
});

describe("security headers", () => {
  it("sets CSP and nosniff, and HSTS only behind https", () => {
    const httpReq = { headers: {} };
    const httpRes = mockRes();
    securityHeaders(httpReq, httpRes, () => {});
    assert.equal(httpRes.headers["x-content-type-options"], "nosniff");
    assert.match(httpRes.headers["content-security-policy"], /default-src 'self'/);
    assert.equal(httpRes.headers["strict-transport-security"], undefined);

    const httpsRes = mockRes();
    securityHeaders(
      { headers: { "x-forwarded-proto": "https" } },
      httpsRes,
      () => {}
    );
    assert.match(httpsRes.headers["strict-transport-security"], /max-age=31536000/);
  });
});

describe("search limit config", () => {
  it("uses safe defaults and honours env overrides", async () => {
    const {
      getSearchMaxQueryChars,
      getSearchRateLimitMax,
      getSearchGlobalRateLimitMax,
    } = await import("../src/config.js");
    const saved = {
      SEARCH_MAX_QUERY_CHARS: process.env.SEARCH_MAX_QUERY_CHARS,
      SEARCH_RATE_LIMIT_MAX: process.env.SEARCH_RATE_LIMIT_MAX,
    };

    delete process.env.SEARCH_MAX_QUERY_CHARS;
    delete process.env.SEARCH_RATE_LIMIT_MAX;
    assert.equal(getSearchMaxQueryChars(), 300);
    assert.equal(getSearchRateLimitMax(), 30);
    assert.equal(getSearchGlobalRateLimitMax(), 120);

    process.env.SEARCH_MAX_QUERY_CHARS = "120";
    assert.equal(getSearchMaxQueryChars(), 120);

    process.env.SEARCH_MAX_QUERY_CHARS = "not-a-number";
    assert.equal(getSearchMaxQueryChars(), 300);

    process.env.SEARCH_RATE_LIMIT_MAX = "0";
    assert.equal(getSearchRateLimitMax(), 1);

    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
});
