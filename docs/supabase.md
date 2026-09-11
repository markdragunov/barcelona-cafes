# Supabase / pgvector

## Schema
Versioned SQL: [`supabase/migrations/`](../supabase/migrations/).

Tables: `cafes`, `reviews`, `cafe_documents` (`vector(1536)` + HNSW cosine).

## Local / staging Postgres
```bash
# needs Docker
npm run db:up          # or ./scripts/pgvector-up.sh
npm run db:migrate     # python3 scripts/apply_migrations.py
```

Default local URL: `postgresql://postgres:postgres@127.0.0.1:54329/barcelona_cafes`

The container publishes **loopback only**. On the droplet, add
`docker-compose.pgvector.droplet.yml` so the app container can reach it as
`db:5432` on the shared network, and set a strong `POSTGRES_PASSWORD` in
`/opt/barcelona-cafes-pg/.env`. See [`deploy/README.md`](../deploy/README.md).

## ETL from SQLite
```bash
export DATABASE_URL=...
export OPENAI_API_KEY=...
npm run db:etl -- --sqlite /path/to/cafes.db
# or skip embeddings: python3 scripts/migrate_sqlite_to_supabase.py --skip-embed
```

## Runtime

Pick a backend via env (never hardcode URLs or passwords in source):

| Variable | Role |
|----------|------|
| `STORAGE_BACKEND` | `sqlite+chroma` (default, local) or `supabase` |
| `DATABASE_URL` | Required only for `supabase` — from Supabase dashboard / secrets manager |
| `DATA_DIR` / `SQLITE_PATH` | Local SQLite + Chroma roots |

```bash
# Local / offline
STORAGE_BACKEND=sqlite+chroma

# Production-style Postgres + pgvector
STORAGE_BACKEND=supabase
DATABASE_URL=postgresql://...   # from secrets; never commit
```

Node (`src/db.js` → CafeRepository) and Python RAG (`IndexStore`) honor the same names.
BM25 stays **in memory**, rebuilt from whatever the IndexStore returns as documents.

## Admin Auth (magic link)

Admin UI at `/admin` uses **Supabase Auth magic links**. Only emails in `ADMIN_EMAILS` can call admin APIs.

| Variable | Role |
|----------|------|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | Public anon key (browser login) |
| `SUPABASE_JWT_SECRET` | Optional — only for projects on the legacy HS256 shared secret |
| `ADMIN_EMAILS` | Comma-separated allowlist |
| `SUPABASE_SERVICE_ROLE_KEY` | Invite script only (never in browser) |

Access tokens are verified two ways, chosen from the token's `alg` header:

- **HS256** (legacy projects) — verified with `SUPABASE_JWT_SECRET`.
- **ES256 / RS256** (projects using JWT signing keys, the current default) —
  verified against `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`. No secret
  needed, so leave `SUPABASE_JWT_SECRET` empty.

Both paths also require `aud=authenticated` and `iss=${SUPABASE_URL}/auth/v1`,
so a token minted by another Supabase project is rejected.

### Dashboard (once)
1. Auth → URL configuration — add redirect URLs:
   - `https://mark-d.dev/admin`
   - `https://admin.mark-d.dev/admin`
   - `http://localhost:3847/admin`
2. Auth → Providers → Email enabled (magic link)

### Invite an admin
```bash
# .env must include SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm run admin:invite -- you@example.com
# also set ADMIN_EMAILS=you@example.com
```

Then open `https://admin.mark-d.dev/`, enter the email, and open the magic link.

When Supabase Auth env is complete, legacy `ADMIN_PASSWORD` Basic auth is ignored.
