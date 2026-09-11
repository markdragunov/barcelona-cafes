#!/usr/bin/env bash
# Apply supabase/migrations to DATABASE_URL (local or remote).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source <(grep -E '^(DATABASE_URL)=' .env | sed 's/\r$//' || true)
  set +a
fi

DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54329/barcelona_cafes}"

echo "Applying migrations to ${DATABASE_URL%%@*}@…"
for f in supabase/migrations/*.sql; do
  echo "→ $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
echo "Migrations OK"
