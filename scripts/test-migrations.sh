#!/usr/bin/env bash
# Assert migration schema exists on DATABASE_URL.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -f .env ]]; then
  set -a
  source <(grep -E '^(DATABASE_URL)=' .env | sed 's/\r$//' || true)
  set +a
fi
DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54329/barcelona_cafes}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT extname FROM pg_extension WHERE extname = 'vector';
SELECT to_regclass('public.cafes') IS NOT NULL AS cafes_ok;
SELECT to_regclass('public.reviews') IS NOT NULL AS reviews_ok;
SELECT to_regclass('public.cafe_documents') IS NOT NULL AS docs_ok;
SELECT indexname FROM pg_indexes WHERE tablename = 'cafe_documents' AND indexdef ILIKE '%hnsw%';
SQL
echo "schema test OK"
