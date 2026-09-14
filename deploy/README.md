# Production deploy helpers

## Environments

| Env | URLs | Droplet paths | Cafe DB |
|-----|------|---------------|---------|
| Local | http://localhost:3847/ · `/admin` | laptop | sqlite+chroma (default) |
| Production | https://topcafes.fyi/ · `/admin` | `/opt/barcelona-cafes` + `/opt/barcelona-cafes-pg` | volume `barcelona-cafes-pg_pgvector-data` |
| Sandbox | https://mark-d.dev/ · `/admin` | `/opt/barcelona-cafes-sandbox` + `/opt/barcelona-cafes-sandbox-pg` | volume `barcelona-cafes-sandbox-pg_pgvector-data` |

One Caddy (production compose `proxy`) owns :80/:443:

- `DOMAIN` hosts → production `app:3847`
- `SANDBOX_DOMAIN` hosts → `sandbox-app:3847`

Do not create `admin.topcafes.fyi` / `admin.mark-d.dev` unless you set `ADMIN_DOMAIN`.

## Prerequisites
- Droplet SSH (`REMOTE=root@164.90.200.60`, key `~/.ssh/do_ed25519`)
- Local `.env` with API keys + `ADMIN_PASSWORD` (used for **production** sync)
- Prefer **4 GB RAM**. The current 1 GB droplet can run two stacks only with swap; expect pressure.

## First-time setup
```bash
chmod +x deploy/*.sh
./deploy/remote-setup.sh
SYNC_DATA=0 TARGET=prod ./deploy/sync-and-up.sh
SYNC_DATA=0 TARGET=sandbox ./deploy/sync-and-up.sh
```

`SYNC_DATA` defaults to **0**. Setting `SYNC_DATA=1` can replace the sqlite volume from local `data/` — do not use that on production Postgres.

## Updates
```bash
SYNC_DATA=0 TARGET=prod ./deploy/sync-and-up.sh
SYNC_DATA=0 TARGET=sandbox ./deploy/sync-and-up.sh
# or TARGET=both
```

Sandbox `.env` is created on the droplet from production keys with a rewritten `DATABASE_URL`. It is not overwritten on later syncs.

Bring the sandbox app up with `docker compose -p barcelona-cafes-sandbox -f docker-compose.sandbox.yml up -d` (service name `sandbox-app` so it does not collide with production DNS `app`).

## Caddy cutover (only when topcafes.fyi DNS works)

Until then keep production `.env` as:

```
DOMAIN=topcafes.fyi,mark-d.dev
SANDBOX_DOMAIN=
```

so `https://mark-d.dev` still serves the 636-cafe production database.

When `topcafes.fyi` A `@` → `164.90.200.60` (Cloudflare **DNS only** / grey cloud until Let's Encrypt succeeds):

```
DOMAIN=topcafes.fyi
SANDBOX_DOMAIN=mark-d.dev
```

On the droplet: `./deploy/cutover-sandbox-caddy.sh` (from `/opt/barcelona-cafes`). After cutover, mark-d.dev is isolated (empty until you collect/ETL into sandbox).

## Database (droplet Postgres + pgvector)

**Production** — `/opt/barcelona-cafes-pg`, loopback `127.0.0.1:54329`, Docker DNS `db:5432` on `barcelona-cafes_internal`:

```bash
cd /opt/barcelona-cafes-pg
docker compose -f docker-compose.pgvector.yml -f docker-compose.pgvector.droplet.yml \
  -p barcelona-cafes-pg up -d
```

**Sandbox** — provisioned by `deploy/provision-sandbox.sh`: loopback `127.0.0.1:54330`, own volume, `db:5432` on `barcelona-cafes-sandbox_internal`. Never restore a prod dump into this container unless you intend to copy data (it still will not overwrite the prod volume).

- Prod app `DATABASE_URL=postgresql://postgres:<pw>@db:5432/barcelona_cafes` in `/opt/barcelona-cafes/.env`
- Sandbox app URL uses the sandbox password in `/opt/barcelona-cafes-sandbox/.env`
- Never publish 5432/54329/54330 on `0.0.0.0`

## Data / backups
- Live production data: volume `barcelona-cafes-pg_pgvector-data`
- Nightly dump: `deploy/backup-postgres.sh` (cron 03:30 UTC)
- Restore **production only**: `./deploy/restore-postgres.sh /opt/barcelona-cafes/backups/pg-<stamp>.sql.gz`
- Sandbox restore: same script with `PG_CONTAINER=barcelona-cafes-sandbox-pg-db-1`

## Smoke test
```bash
BASE_URL=https://mark-d.dev ./deploy/smoke-test.sh
# after cutover + DNS:
BASE_URL=https://topcafes.fyi ./deploy/smoke-test.sh
```

## HTTPS / DNS
1. Cloudflare DNS only (grey cloud) until Caddy has certificates:
   - `topcafes.fyi` A `@` → `164.90.200.60`
   - `mark-d.dev` A `@` → `164.90.200.60`
2. No `admin` A record required.
3. Recreate `proxy` after changing `DOMAIN` / `SANDBOX_DOMAIN`.

## Rollback
Keep the previous `pg-*.sql.gz` for 48h. Caddy rollback: set `SANDBOX_DOMAIN=` and `DOMAIN=topcafes.fyi,mark-d.dev`, recreate proxy — mark-d.dev points at production again.
