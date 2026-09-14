#!/usr/bin/env bash
# Create isolated sandbox Postgres + app on this droplet.
# Does not touch production volume barcelona-cafes-pg_pgvector-data.
# Does not change Caddy routing (mark-d.dev stays on prod until cutover).
set -euo pipefail

PROD_DIR="${PROD_DIR:-/opt/barcelona-cafes}"
SB_DIR="${SB_DIR:-/opt/barcelona-cafes-sandbox}"
PG_DIR="${PG_DIR:-/opt/barcelona-cafes-sandbox-pg}"

if [[ ! -d "$SB_DIR" ]]; then
  echo "Missing $SB_DIR — rsync with TARGET=sandbox first." >&2
  exit 1
fi
if [[ ! -f "$PROD_DIR/.env" ]]; then
  echo "Missing $PROD_DIR/.env (source for API keys, not copied to git)." >&2
  exit 1
fi

mkdir -p "$PG_DIR" "$SB_DIR/backups"
chmod 700 "$PG_DIR"

# Compose files + migrations for sandbox Postgres (code only, no prod data)
cp "$SB_DIR/docker-compose.pgvector.sandbox.yml" "$PG_DIR/"
mkdir -p "$PG_DIR/supabase" "$PG_DIR/scripts"
rm -rf "$PG_DIR/supabase/migrations"
cp -a "$SB_DIR/supabase/migrations" "$PG_DIR/supabase/"
cp -a "$SB_DIR/scripts/docker-init-migrations.sh" "$PG_DIR/scripts/"

if [[ ! -f "$PG_DIR/.env" ]]; then
  umask 077
  PW="$(openssl rand -base64 24 | tr -d '\n=/+' | head -c 32)"
  printf 'POSTGRES_PASSWORD=%s\n' "$PW" > "$PG_DIR/.env"
  chmod 600 "$PG_DIR/.env"
  echo "Wrote new sandbox Postgres password file (not printed)."
else
  echo "Reusing existing $PG_DIR/.env"
fi

# App .env: copy keys from prod once, point DATABASE_URL at sandbox db.
if [[ ! -f "$SB_DIR/.env" ]]; then
  umask 077
  PW="$(grep -E '^POSTGRES_PASSWORD=' "$PG_DIR/.env" | cut -d= -f2-)"
  grep -vE '^(DATABASE_URL|DOMAIN|SANDBOX_DOMAIN|SANDBOX_UPSTREAM|POSTGRES_PASSWORD|ADMIN_DOMAIN)=' \
    "$PROD_DIR/.env" > "$SB_DIR/.env"
  {
    echo "DOMAIN=mark-d.dev"
    echo "SANDBOX_DOMAIN="
    echo "ADMIN_DOMAIN="
    echo "POSTGRES_PASSWORD=${PW}"
    echo "DATABASE_URL=postgresql://postgres:${PW}@sandbox-db:5432/barcelona_cafes"
  } >> "$SB_DIR/.env"
  chmod 600 "$SB_DIR/.env"
  echo "Created sandbox app .env from production keys (DATABASE_URL rewritten)."
else
  echo "Keeping existing $SB_DIR/.env"
fi

# Sandbox app network must exist before Postgres can join it.
# Drop the previous container first so it cannot keep Docker DNS name "app"
# on the production Caddy network.
docker rm -f barcelona-cafes-sandbox-app-1 >/dev/null 2>&1 || true
cd "$SB_DIR"
docker compose -p barcelona-cafes-sandbox -f docker-compose.sandbox.yml build
docker compose -p barcelona-cafes-sandbox -f docker-compose.sandbox.yml up --no-start
docker network inspect barcelona-cafes-sandbox_internal >/dev/null

cd "$PG_DIR"
docker compose -f docker-compose.pgvector.sandbox.yml -p barcelona-cafes-sandbox-pg up -d

echo "Waiting for sandbox Postgres…"
for _ in $(seq 1 40); do
  if docker exec barcelona-cafes-sandbox-pg-db-1 pg_isready -U postgres -d barcelona_cafes >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec barcelona-cafes-sandbox-pg-db-1 pg_isready -U postgres -d barcelona_cafes

cd "$SB_DIR"
docker compose -p barcelona-cafes-sandbox -f docker-compose.sandbox.yml up -d

echo "Waiting for sandbox app health…"
for _ in $(seq 1 40); do
  if docker exec barcelona-cafes-sandbox-app-1 \
    node -e "fetch('http://127.0.0.1:3847/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    echo "sandbox app healthy"
    break
  fi
  sleep 2
done

echo "Sandbox stack is up on Docker DNS sandbox-app:3847 (not public until Caddy cutover)."
echo "Production Caddy is unchanged. To flip mark-d.dev:"
echo "  Set SANDBOX_DOMAIN=mark-d.dev and DOMAIN=topcafes.fyi in $PROD_DIR/.env"
echo "  then: cd $PROD_DIR && docker compose up -d proxy --force-recreate"
echo
free -h | head -2
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'barcelona-cafes|NAMES'
