# Postgres + pgvector

## Schema
Versioned SQL: [`supabase/migrations/`](../supabase/migrations/).

Tables: `cafes`, `reviews`, `cafe_documents` (`vector(1536)` + HNSW cosine).

## Local / staging Postgres
```bash
npm run db:up          # or ./scripts/pgvector-up.sh
npm run db:migrate     # python3 scripts/apply_migrations.py
```

Default local URL: `postgresql://postgres:postgres@127.0.0.1:54329/barcelona_cafes`

The container publishes **loopback only**. On the droplet, add
`docker-compose.pgvector.droplet.yml` so the app can reach it as `db:5432`.
See [`deploy/README.md`](../deploy/README.md).

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
| `DATABASE_URL` | Required only for `supabase` |
| `DATA_DIR` / `SQLITE_PATH` | Local SQLite + Chroma roots |

```bash
STORAGE_BACKEND=sqlite+chroma

STORAGE_BACKEND=supabase
DATABASE_URL=postgresql://...   # from secrets; never commit
```

Node (`src/db.js` → CafeRepository) and Python RAG (`IndexStore`) honor the same names.
BM25 stays **in memory**, rebuilt from whatever the IndexStore returns as documents.
