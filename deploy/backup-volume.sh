#!/usr/bin/env bash
# Backup the live Docker volume cafes-data on the server.
set -euo pipefail
cd /opt/barcelona-cafes
BACKUP_ROOT="${BACKUP_ROOT:-/opt/barcelona-cafes/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_ROOT"
VOL=$(docker volume ls -q --filter name=cafes-data | head -1)
if [[ -z "$VOL" ]]; then
  echo "cafes-data volume not found" >&2
  exit 1
fi
docker run --rm -v "${VOL}:/data:ro" -v "${BACKUP_ROOT}:/backups" alpine \
  sh -c "tar -C /data -czf /backups/barcelona-data-${STAMP}.tar.gz ."
ls -1t "$BACKUP_ROOT"/barcelona-data-*.tar.gz | tail -n +8 | xargs -r rm -f
echo "Wrote $BACKUP_ROOT/barcelona-data-${STAMP}.tar.gz"
