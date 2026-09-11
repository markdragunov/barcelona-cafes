#!/usr/bin/env bash
# Backup Postgres (system of record when STORAGE_BACKEND=supabase).
# Runs pg_dump inside the database container so no client tools are needed on the host.
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/opt/barcelona-cafes/backups}"
PG_CONTAINER="${PG_CONTAINER:-barcelona-cafes-pg-db-1}"
PG_USER="${PG_USER:-postgres}"
PG_DB="${PG_DB:-barcelona_cafes}"
KEEP="${KEEP:-7}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_ROOT}/pg-${PG_DB}-${STAMP}.sql.gz"

if ! docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
  echo "Postgres container not found: $PG_CONTAINER" >&2
  exit 1
fi

mkdir -p "$BACKUP_ROOT"

# --clean --if-exists so the dump can be restored over an existing database.
docker exec "$PG_CONTAINER" \
  pg_dump -U "$PG_USER" -d "$PG_DB" --clean --if-exists --no-owner \
  | gzip -9 > "$OUT"

if [[ ! -s "$OUT" ]]; then
  echo "Dump is empty, removing $OUT" >&2
  rm -f "$OUT"
  exit 1
fi

ls -1t "${BACKUP_ROOT}"/pg-"${PG_DB}"-*.sql.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "Wrote ${OUT} ($(du -h "$OUT" | cut -f1))"
