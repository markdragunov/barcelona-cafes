#!/bin/bash
set -euo pipefail
# Applied once on first container init via docker-entrypoint-initdb.d
for f in /migrations/*.sql; do
  echo "Applying $f"
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$f"
done
