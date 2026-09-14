#!/usr/bin/env bash
# Point mark-d.dev at the sandbox app. Requires:
#   - sandbox stack healthy (deploy/provision-sandbox.sh)
#   - production data stays on barcelona-cafes-pg
#   - topcafes.fyi DNS A record already live, OR you accept mark-d.dev no longer serving prod data
set -euo pipefail

PROD_DIR="${PROD_DIR:-/opt/barcelona-cafes}"
ENV_FILE="${PROD_DIR}/.env"

if ! docker inspect barcelona-cafes-sandbox-app-1 >/dev/null 2>&1; then
  echo "Sandbox app container missing. Run deploy/provision-sandbox.sh first." >&2
  exit 1
fi

python3 - "$ENV_FILE" <<'PY'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()

def upsert(text, key, value):
    line = f"{key}={value}"
    if re.search(rf"^{key}=", text, flags=re.M):
        return re.sub(rf"^{key}=.*$", line, text, count=1, flags=re.M)
    return text.rstrip() + "\n" + line + "\n"

text = upsert(text, "DOMAIN", "topcafes.fyi")
text = upsert(text, "SANDBOX_DOMAIN", "mark-d.dev")
text = upsert(text, "SANDBOX_UPSTREAM", "sandbox-app:3847")
path.write_text(text)
print("Updated DOMAIN / SANDBOX_DOMAIN in prod .env (values only, no secrets).")
PY

cd "$PROD_DIR"
docker compose up -d proxy --force-recreate
sleep 3
docker compose exec -T proxy cat /etc/caddy/Caddyfile
echo
echo "Verify: curl -sS https://mark-d.dev/api/ready"
echo "Prod public URL: https://topcafes.fyi/ (needs DNS A @ → droplet)"
