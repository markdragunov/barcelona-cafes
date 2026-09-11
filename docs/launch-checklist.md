# Launch checklist

## Pre-flight
- [ ] Droplet ≥ 2 GB RAM (prefer 4 GB); swap enabled
- [ ] Google key allows droplet IP; Places + Geocoding enabled
- [ ] `.env` on server has API keys + `ADMIN_PASSWORD`
- [ ] `./deploy/remote-setup.sh` and `./deploy/sync-and-up.sh` succeeded
- [ ] `./deploy/backup-volume.sh` produced a tarball under `/opt/barcelona-cafes/backups`
- [ ] Restore drill once (optional but recommended)

## Staging smoke
- [ ] `GET /api/health` → `{"ok":true}`
- [ ] `GET /api/ready` → `ready: true` with cafe/document counts
- [ ] Unauthenticated `/api/summary` → 401
- [ ] Authenticated admin summary → cafe counts
- [ ] Public search without landmark works
- [ ] Public search with landmark works (after Google IP fix)
- [ ] `/admin` prompts for Basic auth

## Cutover
- [ ] DNS A record → droplet IP (if using `DOMAIN`)
- [ ] Re-deploy so Caddy issues TLS cert
- [ ] Confirm `https://DOMAIN/` and `https://DOMAIN/admin`
- [ ] Firewall: 22/80/443 only; 3847 closed
- [ ] Cron backup present (`crontab -l`)

## Post-launch (24h)
- [ ] Watch `docker compose logs -f app proxy`
- [ ] Check OpenAI / Google / Parallel dashboards for anomalies
- [ ] Keep previous `barcelona-data-*.tar.gz` for 48h rollback
