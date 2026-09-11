#!/usr/bin/env bash
# Start local pgvector, wait healthy, apply migrations (idempotent re-apply safe for IF NOT EXISTS).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

docker compose -f docker-compose.pgvector.yml up -d
echo "Waiting for Postgres…"
for i in $(seq 1 40); do
  if docker compose -f docker-compose.pgvector.yml exec -T db pg_isready -U postgres -d barcelona_cafes >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54329/barcelona_cafes}"
# Re-apply for existing volumes that skipped init scripts
./scripts/apply-migrations.sh

psql "$DATABASE_URL" -c "\dx vector" -c "\dt public.*" -c "\d public.cafe_documents"
echo "Local pgvector ready: $DATABASE_URL"
