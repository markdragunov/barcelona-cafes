# Production runbook — Barcelona Cafes

Environments: `local` | `staging` | `production` (same image; different `.env` + data volume).

## Phase 0 checklist (before public traffic)

### Domain & DNS
- [ ] Register domain (example: `cafes.yourdomain.com`)
- [ ] Create A record → droplet public IP (current: `164.90.200.60`)
- [ ] Set `DOMAIN=cafes.yourdomain.com` in production `.env`
- [ ] Wait for DNS propagation, then confirm Caddy issues TLS

Without a domain yet, the stack still runs on HTTP at `http://<IP>/` (Caddy listens on 80).

### Secrets inventory
| Variable | Purpose | Where |
|----------|---------|--------|
| `GOOGLE_PLACES_API_KEY` / `GOOGLE_API_KEY` | Places + Geocoding | `.env` on host / Docker env |
| `PARALLEL_API_KEY` | Website extract | `.env` |
| `OPENAI_API_KEY` | Embeddings + answers | `.env` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | App + proxy admin auth | `.env` (strong unique password) |
| `DATA_DIR` | Persistent data path | `/data` in containers |
| `DOMAIN` | Public hostname for TLS | production `.env` only |
| `PORT` | Internal app port | `3847` (not exposed publicly) |

Never commit `.env`. Recreate secrets from a password manager on the server.

### Google Cloud key restrictions
- [ ] Enable **Places API (New)** and **Geocoding API** on the project
- [ ] Application restriction: **IP addresses** → add droplet egress IP `164.90.200.60`
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
./deploy/remote-setup.sh          # install Docker on droplet if needed
./deploy/sync-and-up.sh           # build/up stack + optional data sync

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
