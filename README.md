# Barcelona Cafes

Local service for collecting Barcelona coffee shops, enriching them with website content, and answering natural-language questions with hybrid RAG — grounded only on your local data.

## What it does

1. **Collect** cafes from Google Places API (New) into SQLite (local default) or Postgres (production)  
2. **Enrich** each cafe by extracting coffee-related content from its website (Parallel Extract)  
3. **Index** combined coffee content + reviews (Chroma locally, pgvector in production) plus BM25  
4. **Search** with location-aware hybrid retrieval + an OpenAI answer based only on retrieved cafes  

Same Express app on one production host:

| Surface | Local | Production |
|---------|-------|------------|
| Public search | http://localhost:3847/ | https://mark-d.dev/ |
| Admin | http://localhost:3847/admin | https://mark-d.dev/admin |

One Node/Express process serves both. Production public is Express `GET /` (`index.html` at the project root). Production admin is Express serving `public/index.html` at `/admin`.

## Architecture

```
Browser
  ├─ public search   /            (local :3847 or https://mark-d.dev/)
  └─ admin UI        /admin       (local :3847/admin or https://mark-d.dev/admin)
         │
         ▼
   Express (src/server.js)     port 3847   one process
         │
         ├─ sqlite+chroma      data/cafes.db + data/chroma/   (local default)
         ├─ supabase           Postgres + pgvector            (production)
         ├─ Google Places      collect cafes
         ├─ Parallel Extract   coffee_content from websites
         └─ Python RAG CLI     python3 -m rag …
                └─ BM25        in memory / data/bm25_index.pkl
```

- **Node / Express** — HTTP API, admin jobs, cafe store  
- **Python (`rag/`)** — indexing, hybrid search, location filter, LLM answer formatting  
- **Local** — `STORAGE_BACKEND=sqlite+chroma` (`data/cafes.db` + Chroma)  
- **Production** — `STORAGE_BACKEND=supabase` (Postgres + pgvector on the droplet). SQLite is not the prod system of record.

## Requirements

- Node.js 18+ (tested with newer versions; uses built-in `node:sqlite`)
- Python 3.9+
- API keys via `.env` (copy from `.env.example`):
  - **Google** — `GOOGLE_PLACES_API_KEY` (or `GOOGLE_API_KEY`) for Places API (New) + Geocoding
  - **Parallel** — `PARALLEL_API_KEY` for website extract
  - **OpenAI** — `OPENAI_API_KEY` for embeddings + chat

Enable **Geocoding API** on the same Google Cloud project as your key, and allow it under the key’s API restrictions.

## Database

Pick a backend with `STORAGE_BACKEND`:

| Value | When | Store |
|-------|------|--------|
| `sqlite+chroma` | Local default | `data/cafes.db` + `data/chroma/` |
| `supabase` | Production (and optional local Postgres) | Postgres + pgvector; needs `DATABASE_URL` |

On the droplet the app reaches Postgres as `db:5432` (compose overlay). Details: [docs/supabase.md](docs/supabase.md).

```bash
npm run db:up && npm run db:migrate
npm run db:etl -- --sqlite data/cafes.db
npm start
```

## Setup

```bash
git clone https://github.com/markdragunov/barcelona-cafes.git
cd barcelona-cafes

npm install
cp .env.example .env   # then fill in API keys
npm run setup:python   # or: python3 -m pip install -r requirements.txt

npm start              # http://localhost:3847
```

Dev mode (auto-reload Node):

```bash
npm run dev
```

Check RAG indexes:

```bash
npm run rag:status
```

## Production (Docker on DigitalOcean)

Docker + Caddy on the droplet. Public: `https://mark-d.dev` · Admin: `https://mark-d.dev/admin` (`DOMAIN`).

Admin is **magic-link** (Supabase Auth + `ADMIN_EMAILS`). `ADMIN_PASSWORD` Basic auth is a legacy fallback when Supabase Auth env is incomplete.

Production must use `STORAGE_BACKEND=supabase` and `SYNC_DATA=0`. The sync script defaults to `SYNC_DATA=1`; leaving that on can copy an empty local `data/` over the volume.

See [docs/production-runbook.md](docs/production-runbook.md) and [deploy/README.md](deploy/README.md) (Postgres overlay, `db:5432`).

```bash
# .env: STORAGE_BACKEND=supabase, DATABASE_URL=@db:5432, DOMAIN, ADMIN_DOMAIN, ADMIN_EMAILS, …
./deploy/remote-setup.sh
SYNC_DATA=0 ./deploy/sync-and-up.sh
```

## Typical workflow

### 1. Configure keys

Copy `.env.example` → `.env` and set real values (never commit `.env`):

```bash
cp .env.example .env
```

| Variable | Provider |
|----------|----------|
| `STORAGE_BACKEND` | `sqlite+chroma` (local) or `supabase` (Postgres + pgvector) |
| `DATABASE_URL` | Required when `STORAGE_BACKEND=supabase` (never commit) |
| `GOOGLE_PLACES_API_KEY` (or `GOOGLE_API_KEY`) | Google Places + Geocoding |
| `PARALLEL_API_KEY` | Parallel Extract |
| `OPENAI_API_KEY` | OpenAI embeddings + answers |
| `ADMIN_EMAILS` | Magic-link allowlist (comma-separated) |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Admin magic-link UI |
| `SUPABASE_JWT_SECRET` | Optional; leave empty for JWKS (asymmetric) projects |
| `ADMIN_PASSWORD` | Legacy Basic auth fallback only |

Admin (`/admin`) only shows whether each env var is loaded — it does not store keys.

### 2. Collect cafes

Pick a neighborhood (or **All Barcelona**) and run collection.

Neighborhoods use `locationRestriction` map viewports (not address-text filters):

- El Born, Eixample, Poblenou, Gràcia, Gothic Quarter, All Barcelona  

Only places whose Places `types` include `cafe` are saved. Deduping is by Places ID.

### 3. Fetch coffee content

Runs Parallel Extract on cafes that have a website and empty `coffee_content`.

Goal used for extraction: coffee beans, origin, roast profiles, brew methods, menu items, and related content.

### 4. Index for RAG

Click **Index cafes** (admin). This rebuilds:

- OpenAI embeddings → local ChromaDB  
- BM25 keyword index from the same documents  

Each document = `coffee_content` + all reviews for that cafe.

### 5. Search

- **Public page:** natural-language query + result count (3 / 5 / 10)  
- **Admin:** same RAG pipeline with progress/status  

Search pipeline:

1. Resolve location: neighborhood **gazetteer** first; Google geocode only for unknown places → keep cafes within **1 km** (optional)  
2. Hybrid search in parallel: vector (Chroma or pgvector) + BM25  
3. Merge with Reciprocal Rank Fusion, dedupe by Places ID, take top N  
4. LLM writes a short intro + one “why” line per cafe; name, rating, address, map/site links are filled from the database  

Public `POST /api/rag/search` is rate-limited (per client and globally). Answers are grounded on stored cafe data only — no web search and no general LLM knowledge as the source of cafe facts.

## Data stored locally

| Path | Contents |
|------|----------|
| `data/cafes.db` | Cafes, reviews, `coffee_content` (local SQLite only) |
| `data/chroma/` | Vector index (local Chroma) |
| `data/bm25_index.pkl` | BM25 index |

These paths are gitignored. API keys live in `.env` only — they are not stored in the database.

### Cafe fields (high level)

- `place_id` (unique), name, address, rating, review count, website  
- `place_types`, latitude, longitude, neighborhood  
- `coffee_content` (Parallel extract JSON)  
- related rows in `reviews`

## Project layout

```
├── index.html           Public search UI
├── public/              Admin UI assets
├── src/
│   ├── server.js        Express app & API routes
│   ├── config.js        API keys from environment (.env)
│   ├── db.js            SQLite schema & helpers
│   ├── places.js        Google Places collection
│   ├── extract.js       Parallel Extract client
│   ├── neighborhoods.js Viewport definitions
│   ├── queries.js       Places text-search queries
│   └── ragBridge.js     Node → Python RAG bridge
├── rag/
│   ├── documents.py     Build index documents
│   ├── index.py         Rebuild Chroma + BM25
│   ├── location.py      Location detect + geocode + radius filter
│   ├── search.py        Hybrid search + answer assembly
│   └── __main__.py      CLI: status | index | search
├── data/                Local DB & indexes
├── package.json
└── requirements.txt
```

## Useful scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run the server |
| `npm run dev` | Run with `--watch` |
| `npm run setup:python` | Install Python RAG dependencies |
| `npm run rag:status` | Print whether Chroma/BM25 indexes are ready |

## Notes & limits

- Collection and extract jobs can take a long time and consume Places / Parallel quota.  
- Indexing calls OpenAI embeddings; rate limits apply (batching is built in).  
- Known neighborhoods use the gazetteer (no geocode call). Unknown places still need a Geocoding-enabled Google key; without a location in the query, search is citywide.  
- Dead or unregistered cafe websites will fail extract (e.g. DNS `NXDOMAIN`) — that is expected for some Places URLs.

## License

Private project (`package.json`). Add a license file if you plan to open-source it.
