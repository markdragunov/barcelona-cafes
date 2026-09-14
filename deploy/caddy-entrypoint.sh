#!/bin/sh
# Generate Caddyfile from DOMAIN / ADMIN_DOMAIN, then run Caddy.
set -eu

if [ -z "${DOMAIN:-}" ]; then
  cat > /etc/caddy/Caddyfile <<'EOF'
:80 {
	encode gzip
	reverse_proxy app:3847
}
EOF
  echo "Caddy HTTP-only on :80 (set DOMAIN for HTTPS)"
  exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
fi

ADMIN_HOST="${ADMIN_DOMAIN:-}"
if [ -z "$ADMIN_HOST" ]; then
  ADMIN_HOST="admin.${DOMAIN}"
fi

# Main site + admin subdomain (same app; admin UI remains under /admin).
# On the admin host, "/" redirects to "/admin" for convenience.
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	encode gzip
	reverse_proxy app:3847
}

${ADMIN_HOST} {
	encode gzip
	@root path /
	redir @root /admin 302
	reverse_proxy app:3847
}
EOF

echo "Caddy TLS sites: DOMAIN=${DOMAIN} ADMIN_DOMAIN=${ADMIN_HOST}"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
