#!/usr/bin/env bash
# Smoke-test production endpoints (health, ready, public search, admin auth gate).
set -euo pipefail

BASE="${BASE_URL:-https://mark-d.dev}"

echo "== health =="
curl -sf "$BASE/api/health" | tee /dev/stderr | grep -q '"ok":true'

echo "== ready =="
curl -sS "$BASE/api/ready" | tee /dev/stderr || true

echo "== auth config (public) =="
curl -sf "$BASE/api/auth/config" | tee /dev/stderr | grep -q authMode

echo "== admin page public =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin")
[[ "$CODE" == "200" ]] || { echo "expected 200 for /admin HTML, got $CODE"; exit 1; }

echo "== admin API unauthorized =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/summary?neighborhood=all-barcelona")
[[ "$CODE" == "401" ]] || { echo "expected 401 for admin API without bearer, got $CODE"; exit 1; }

echo "== admin API rejects garbage bearer =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer not-a-real-token' \
  "$BASE/api/summary?neighborhood=all-barcelona")
[[ "$CODE" == "401" ]] || { echo "expected 401 for bad bearer, got $CODE"; exit 1; }

echo "== public search =="
curl -sf -X POST "$BASE/api/rag/search" \
  -H 'Content-Type: application/json' \
  -d '{"query":"specialty coffee for laptop work","topN":3}' \
  | tee /dev/stderr | grep -q '"answer"'

echo "SMOKE OK (magic-link login is manual: open /admin and use email allowlist)"
