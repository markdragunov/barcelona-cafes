# Production runbook — Barcelona Cafes

Environments: **local** (localhost:3847) | **sandbox** (mark-d.dev, isolated DB) | **production** (topcafes.fyi, current 636-cafe Postgres). Same image; different compose project + `.env` + volume.

Until `topcafes.fyi` has a DNS A record, `mark-d.dev` is still routed to **production** on purpose. Do not run `cutover-sandbox-caddy.sh` before that or the only working public URL will serve an empty sandbox.

## Phase 0 checklist (before public traffic)

### Domain & DNS
- [ ] Register domain `topcafes.fyi`
- [ ] Cloudflare A `@` → `YOUR_DROPLET_IP` (DNS only / grey cloud until TLS works)
- [ ] Set `DOMAIN=topcafes.fyi` (and after cutover `SANDBOX_DOMAIN=mark-d.dev`) in production `.env`
- [ ] Wait for DNS, confirm Caddy issues TLS for topcafes.fyi
- [ ] Supabase Auth Site URL + redirects for all three `/admin` URLs

Without a domain yet, the stack still runs on HTTP at `http://<IP>/` (Caddy listens on 80).

### Secrets inventory
| Variable | Purpose | Where |
|----------|---------|--------|
| `GOOGLE_PLACES_API_KEY` / `GOOGLE_API_KEY` | Places + Geocoding | `.env` on host / Docker env |
| `PARALLEL_API_KEY` | Website extract | `.env` |
| `OPENAI_API_KEY` | Embeddings + answers | `.env` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Legacy Basic auth fallback | `.env` — prefer magic link (`ADMIN_EMAILS` + Supabase) |
| `DATA_DIR` | Persistent data path | `/data` in containers |
| `DOMAIN` | Production hostname(s) for TLS | production `.env` |
| `SANDBOX_DOMAIN` | Sandbox hostname (`mark-d.dev`) after cutover | production `.env` (Caddy only) |
| `PORT` | Internal app port | `3847` (not exposed publicly) |

Never commit `.env`. Recreate secrets from a password manager on the server.

### Google Cloud key restrictions
- [ ] Enable **Places API (New)** and **Geocoding API** on the project
- [ ] Application restriction: **IP addresses** → add the droplet's egress IP (confirm with `curl -4 ifconfig.me` on the host)
- [ ] API restriction: allow Places API (New) + Geocoding API only
- [ ] Verify from server: location query like `coffee near Sagrada Familia` succeeds

### Quota / cost budget (monthly estimate)
| Provider | Typical use | Watch |
|----------|-------------|--------|
| Google Places | Rare re-collects | Text Search + Details quotas |
| Google Geocoding | Per location-aware search | Set billing alerts |
| Parallel Extract | Re-enrich websites | Per-URL cost |
| OpenAI | Every search + full re-index | TPM/RPM; `text-embedding-3-small` + `gpt-4o-mini` |

Set billing alerts on all three clouds before launch.

### Host sizing
- Target: **2 vCPU / 4 GB RAM**, 2 GB+ swap (1 GB is too small for Node + Chroma + BM25).
- Current droplet may need resize in DigitalOcean UI before heavy search/index load.

---

## Deploy commands (summary)

```bash
# On laptop (from repo root)
./deploy/remote-setup.sh
SYNC_DATA=0 TARGET=prod ./deploy/sync-and-up.sh
SYNC_DATA=0 TARGET=sandbox ./deploy/sync-and-up.sh

# Backups on server
./deploy/backup-data.sh
./deploy/restore-data.sh /path/to/backup.tar.gz
```

See [deploy/README.md](../deploy/README.md) for full steps.

## Launch day
1. Staging smoke: health, ready, authenticated admin, public search
2. Confirm geocoding from server IP
3. 3–5 search prompts vs local quality
4. Enable nightly cron backup
5. Point DNS / open 443
6. Watch logs + provider dashboards 24h
7. Keep prior DB snapshot 48h for rollback
