#!/usr/bin/env bash
# Restore a pg_dump backup produced by deploy/backup-postgres.sh.
#   ./deploy/restore-postgres.sh /opt/barcelona-cafes/backups/pg-barcelona_cafes-STAMP.sql.gz
set -euo pipefail

ARCHIVE="${1:?usage: restore-postgres.sh <pg-*.sql.gz>}"
PG_CONTAINER="${PG_CONTAINER:-barcelona-cafes-pg-db-1}"
PG_USER="${PG_USER:-postgres}"
PG_DB="${PG_DB:-barcelona_cafes}"

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Backup not found: $ARCHIVE" >&2
  exit 1
fi

echo "Restoring ${ARCHIVE} into ${PG_DB} (existing objects are dropped)…"
gunzip -c "$ARCHIVE" | docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1

echo "Restore finished. Verify with: docker exec ${PG_CONTAINER} psql -U ${PG_USER} -d ${PG_DB} -c 'select count(*) from cafes'"
