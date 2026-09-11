/**
 * Auth config + middleware smoke (no live Supabase).
 * Run: node --test test/auth.middleware.test.js
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";

describe("Supabase admin auth gate", () => {
  const secret = "test-jwt-secret-for-unit-tests-only";
  let requireAdmin;
  let resetEnv;

  before(async () => {
    resetEnv = {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
      SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
      ADMIN_EMAILS: process.env.ADMIN_EMAILS,
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    };
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-test";
    process.env.SUPABASE_JWT_SECRET = secret;
    process.env.ADMIN_EMAILS = "admin@example.com, other@example.com";
    delete process.env.ADMIN_PASSWORD;

    // Re-import modules after env set (config reads env at call time; middleware imports config fns)
    ({ requireAdmin } = await import("../src/middleware.js"));
  });

  after(() => {
    for (const [k, v] of Object.entries(resetEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function mockRes() {
    const res = {
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
      set() {
        return this;
      },
    };
    return res;
  }

  it("rejects missing bearer with 401", async () => {
    const req = { headers: {} };
    const res = mockRes();
    let nextCalled = false;
    await requireAdmin(req, res, () => {
      nextCalled = true;
    });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  });

  const issuer = "https://example.supabase.co/auth/v1";

  function signHs256(claims, { iss = issuer } = {}) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("authenticated")
      .setIssuer(iss)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));
  }

  it("allows allowlisted email JWT", async () => {
    const token = await signHs256({ email: "Admin@Example.com" });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    let nextCalled = false;
    await requireAdmin(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(req.admin.email, "admin@example.com");
  });

  it("forbids non-allowlisted email with 403", async () => {
    const token = await signHs256({ email: "stranger@example.com" });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    await requireAdmin(req, res, () => {});
    assert.equal(res.statusCode, 403);
  });

  it("rejects a token issued by a different project", async () => {
    const token = await signHs256(
      { email: "admin@example.com" },
      { iss: "https://attacker.supabase.co/auth/v1" }
    );
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    let nextCalled = false;
    await requireAdmin(req, res, () => {
      nextCalled = true;
    });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  });

  it("rejects an expired token", async () => {
    const token = await new SignJWT({ email: "admin@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("authenticated")
      .setIssuer(issuer)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(secret));
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    await requireAdmin(req, res, () => {});
    assert.equal(res.statusCode, 401);
  });
});

describe("asymmetric (JWKS) Supabase projects", () => {
  it("treats auth as enabled without SUPABASE_JWT_SECRET", async () => {
    const saved = {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
      SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
      ADMIN_EMAILS: process.env.ADMIN_EMAILS,
    };
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-test";
    delete process.env.SUPABASE_JWT_SECRET;
    process.env.ADMIN_EMAILS = "admin@example.com";

    const { isSupabaseAdminAuthEnabled, getSupabaseJwksUrl, getSupabaseIssuer } =
      await import("../src/config.js");

    assert.equal(isSupabaseAdminAuthEnabled(), true);
    assert.equal(
      getSupabaseJwksUrl(),
      "https://example.supabase.co/auth/v1/.well-known/jwks.json"
    );
    assert.equal(getSupabaseIssuer(), "https://example.supabase.co/auth/v1");

    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
});
