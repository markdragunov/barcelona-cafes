# Production deploy helpers

## Prerequisites
- Droplet with SSH (`REMOTE=root@164.90.200.60`, key `~/.ssh/do_ed25519`)
- Local `.env` with API keys + `ADMIN_PASSWORD` (and optional `DOMAIN`, `ADMIN_USER`)
- Prefer **4 GB RAM** droplet for RAG workloads

## First-time setup
```bash
chmod +x deploy/*.sh
./deploy/remote-setup.sh
./deploy/sync-and-up.sh
```

## Updates
```bash
./deploy/sync-and-up.sh
```

## Database (droplet Postgres + pgvector)

Postgres runs as its own compose project at `/opt/barcelona-cafes-pg` and is
**published on loopback only** (`127.0.0.1:54329`). The app reaches it over the
shared Docker network as `db:5432`:

```bash
# on the droplet
cd /opt/barcelona-cafes-pg
docker compose -f docker-compose.pgvector.yml -f docker-compose.pgvector.droplet.yml \
  -p barcelona-cafes-pg up -d
```

- App/RAG connection: `DATABASE_URL=postgresql://postgres:<pw>@db:5432/barcelona_cafes` in `/opt/barcelona-cafes/.env`
- Password lives in `/opt/barcelona-cafes-pg/.env` as `POSTGRES_PASSWORD` (chmod 600)
- Host-side tooling (migrations, ETL) connects through the loopback port `127.0.0.1:54329`
- Never publish 5432/54329 on `0.0.0.0` — Docker port publishing bypasses `ufw`

## Data
- Live data lives in Postgres volume `barcelona-cafes-pg_pgvector-data`.
- Nightly Postgres dump: `deploy/backup-postgres.sh` (cron 03:30 UTC) → `/opt/barcelona-cafes/backups/pg-*.sql.gz`, keeps 7.
- Restore: `./deploy/restore-postgres.sh /opt/barcelona-cafes/backups/pg-<stamp>.sql.gz`
- Legacy SQLite/Chroma volume `*_cafes-data` is still backed up by `deploy/backup-volume.sh` (cron 03:15 UTC); it is only relevant when `STORAGE_BACKEND=sqlite+chroma`.

Restore into volume:
```bash
# on server
cd /opt/barcelona-cafes
docker compose stop app
VOL=$(docker volume ls -q --filter name=cafes-data | head -1)
docker run --rm -v "$VOL:/data" -v /opt/barcelona-cafes/backups:/backups alpine \
  sh -c 'cd /data && rm -rf ./* && tar -xzf /backups/barcelona-data-STAMP.tar.gz'
docker compose start app
```

## Smoke test
```bash
ADMIN_PASSWORD='…' ./deploy/smoke-test.sh
```

## HTTPS
1. At Cloudflare (DNS only / grey cloud first): A `@` and A `admin` → droplet IP.
2. In `.env`: `DOMAIN=mark-d.dev` and optional `ADMIN_DOMAIN=admin.mark-d.dev`.
3. Sync/restart proxy: `./deploy/sync-and-up.sh` (or recreate `proxy` on the server).
Caddy obtains Let's Encrypt certs for both hostnames. Admin UI: `https://mark-d.dev/admin` or `https://admin.mark-d.dev/` (redirects to `/admin`).

## Rollback
Keep the previous `barcelona-data-*.tar.gz` for 48h and restore as above; `docker compose up -d` previous image tag if needed.
