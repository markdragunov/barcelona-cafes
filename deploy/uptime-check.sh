#!/usr/bin/env bash
# Local/remote health probe for cron or external monitors.
set -euo pipefail
BASE="${BASE_URL:-http://127.0.0.1}"
curl -sf --max-time 10 "$BASE/api/health" >/dev/null
# Ready may be 503 during reindex; log but do not fail hard for uptime of process
curl -sS --max-time 60 "$BASE/api/ready" >/dev/null || true
