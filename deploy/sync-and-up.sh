#!/usr/bin/env bash
# Sync repo to droplet and bring up prod and/or sandbox compose stacks.
# Never copies local data/ onto the server unless you set SYNC_DATA=1.
set -euo pipefail

REMOTE="${REMOTE:-root@164.90.200.60}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/do_ed25519}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Default 0: live Postgres/volume must not be replaced by an empty laptop data/.
SYNC_DATA="${SYNC_DATA:-0}"
# prod | sandbox | both
TARGET="${TARGET:-prod}"
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes)
RSYNC=(rsync -az --delete -e "ssh -i ${SSH_KEY} -o BatchMode=yes")

cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example and fill secrets (including ADMIN_PASSWORD)." >&2
  exit 1
fi
if ! grep -qE '^ADMIN_PASSWORD=.+' .env; then
  echo "ADMIN_PASSWORD must be set in .env for production." >&2
  exit 1
fi

sync_code() {
  local dest="$1"
  "${SSH[@]}" "$REMOTE" "mkdir -p ${dest} ${dest}/backups /var/lib/barcelona-cafes-data"
  "${RSYNC[@]}" \
    --exclude node_modules \
    --exclude .git \
    --exclude .venv \
    --exclude data \
    --exclude backups \
    --exclude .env \
    --exclude .cursor \
    "$ROOT/" "$REMOTE:${dest}/"
}

case "$TARGET" in
  prod|sandbox|both) ;;
  *)
    echo "TARGET must be prod, sandbox, or both (got $TARGET)" >&2
    exit 1
    ;;
esac

if [[ "$TARGET" == "prod" || "$TARGET" == "both" ]]; then
  sync_code /opt/barcelona-cafes
  scp -i "$SSH_KEY" -o BatchMode=yes "$ROOT/.env" "$REMOTE:/opt/barcelona-cafes/.env"
fi

if [[ "$TARGET" == "sandbox" || "$TARGET" == "both" ]]; then
  sync_code /opt/barcelona-cafes-sandbox
fi

if [[ "$SYNC_DATA" == "1" ]]; then
  if [[ -z "${DATA_SRC:-}" ]]; then
    if [[ -f /Users/markd/barcelona-cafes/data/cafes.db ]]; then
      DATA_SRC=/Users/markd/barcelona-cafes/data
    else
      DATA_SRC="$ROOT/data"
    fi
  fi
  STAGE=$(mktemp -d)
  trap 'rm -rf "$STAGE"' EXIT
  if [[ -f "$DATA_SRC/cafes.db" ]]; then
    python3 - <<PY
import sqlite3
src=sqlite3.connect("$DATA_SRC/cafes.db")
dst=sqlite3.connect("$STAGE/cafes.db")
src.backup(dst); dst.close(); src.close()
print("db snapshot ready")
PY
  fi
  [[ -d "$DATA_SRC/chroma" ]] && rsync -a "$DATA_SRC/chroma/" "$STAGE/chroma/"
  [[ -f "$DATA_SRC/bm25_index.pkl" ]] && cp -a "$DATA_SRC/bm25_index.pkl" "$STAGE/"
  "${RSYNC[@]}" "$STAGE/" "$REMOTE:/var/lib/barcelona-cafes-data/"
fi

if [[ "$TARGET" == "prod" || "$TARGET" == "both" ]]; then
  "${SSH[@]}" "$REMOTE" env SYNC_DATA="$SYNC_DATA" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/barcelona-cafes
chmod +x deploy/*.sh

docker compose build
docker compose up -d

# Only replace the sqlite volume when the operator opted into SYNC_DATA=1.
if [[ "${SYNC_DATA:-0}" == "1" && -f /var/lib/barcelona-cafes-data/cafes.db ]]; then
  docker compose stop app
  VOL=$(docker volume ls -q --filter name=barcelona-cafes_cafes-data | head -1)
  docker run --rm -v "${VOL}:/data" -v /var/lib/barcelona-cafes-data:/seed:ro alpine \
    sh -c 'rm -rf /data/cafes.db /data/cafes.db-* /data/chroma /data/bm25_index.pkl 2>/dev/null || true; cp -a /seed/. /data/; chown -R 1000:1000 /data; chmod -R u+rwX /data; ls -la /data'
  docker compose start app
fi

CRON_DOCKER="15 3 * * * /opt/barcelona-cafes/deploy/backup-volume.sh >> /var/log/barcelona-backup.log 2>&1"
(crontab -l 2>/dev/null | grep -v backup-volume | grep -v barcelona-backup || true; echo "$CRON_DOCKER") | crontab -

sleep 4
docker compose ps
curl -sf -o /tmp/health.json http://127.0.0.1/api/health || curl -sf https://mark-d.dev/api/health >/dev/null
echo "prod health ok"
REMOTE
fi

if [[ "$TARGET" == "sandbox" || "$TARGET" == "both" ]]; then
  "${SSH[@]}" "$REMOTE" bash -s <<'REMOTE'
set -euo pipefail
chmod +x /opt/barcelona-cafes-sandbox/deploy/*.sh /opt/barcelona-cafes/deploy/provision-sandbox.sh
/opt/barcelona-cafes-sandbox/deploy/provision-sandbox.sh
REMOTE
fi

echo "Deploy finished (TARGET=${TARGET} SYNC_DATA=${SYNC_DATA})."
echo "  Production (after DNS): https://topcafes.fyi/"
echo "  Sandbox (after Caddy cutover): https://mark-d.dev/"
echo "  Local: http://localhost:3847/"
echo "Caddy still routes mark-d.dev to production until SANDBOX_DOMAIN=mark-d.dev is set on the prod stack."
