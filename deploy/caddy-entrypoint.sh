#!/bin/sh
# Generate Caddyfile from DOMAIN / SANDBOX_DOMAIN / ADMIN_DOMAIN, then run Caddy.
# DOMAIN hosts → production app (compose service "app").
# SANDBOX_DOMAIN hosts → SANDBOX_UPSTREAM (default sandbox-app:3847).
# Admin UI is always /admin on those hosts. ADMIN_DOMAIN is optional extra hostname.
set -eu

emit_site() {
  host="$1"
  upstream="$2"
  cat <<EOF
${host} {
	encode gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		X-Frame-Options "DENY"
	}
	reverse_proxy ${upstream}
}

EOF
}

if [ -z "${DOMAIN:-}" ] && [ -z "${SANDBOX_DOMAIN:-}" ]; then
  cat > /etc/caddy/Caddyfile <<'EOF'
:80 {
	encode gzip
	reverse_proxy app:3847
}
EOF
  echo "Caddy HTTP-only on :80 (set DOMAIN for HTTPS)"
  exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
fi

SANDBOX_UPSTREAM="${SANDBOX_UPSTREAM:-sandbox-app:3847}"

{
  if [ -n "${DOMAIN:-}" ]; then
    for host in $(printf '%s' "$DOMAIN" | tr ', ' '\n' | sed '/^$/d'); do
      emit_site "$host" "app:3847"
    done
  fi

  if [ -n "${SANDBOX_DOMAIN:-}" ]; then
    for host in $(printf '%s' "$SANDBOX_DOMAIN" | tr ', ' '\n' | sed '/^$/d'); do
      emit_site "$host" "$SANDBOX_UPSTREAM"
    done
  fi

  if [ -n "${ADMIN_DOMAIN:-}" ]; then
    cat <<EOF
${ADMIN_DOMAIN} {
	encode gzip
	@root path /
	redir @root /admin 302
	reverse_proxy app:3847
}

EOF
  fi
} > /etc/caddy/Caddyfile

echo "Caddy TLS: DOMAIN=${DOMAIN:-} SANDBOX_DOMAIN=${SANDBOX_DOMAIN:-} ADMIN_DOMAIN=${ADMIN_DOMAIN:-}"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
