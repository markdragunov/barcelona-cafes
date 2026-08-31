# Barcelona Cafes

Local service for collecting Barcelona coffee shops, enriching them with website content, and answering natural-language questions with hybrid RAG — grounded only on your local data.

## What it does

1. **Collect** cafes from Google Places API (New) into a local SQLite database  
2. **Enrich** each cafe by extracting coffee-related content from its website (Parallel Extract)  
3. **Index** combined coffee content + reviews into ChromaDB (vectors) and BM25 (keywords)  
4. **Search** with location-aware hybrid retrieval + an OpenAI answer based only on retrieved cafes  

Two UIs share the same backend:

| URL | Purpose |
|-----|---------|
| http://localhost:3847/ | Public search page |
| http://localhost:3847/admin | Admin: API keys, collection, extract, indexing, CSV export |

## Architecture

```
Browser
  ├─ /            public search (index.html)
  └─ /admin       admin UI (public/)
         │
         ▼
   Express (src/server.js)     port 3847
         │
         ├─ SQLite             data/cafes.db
         ├─ Google Places      collect cafes
         ├─ Parallel Extract   coffee_content from websites
         └─ Python RAG CLI     python3 -m rag …
                ├─ ChromaDB    data/chroma/
                └─ BM25        data/bm25_index.pkl
```

- **Node / Express** — HTTP API, admin jobs, SQLite access  
- **Python (`rag/`)** — indexing, hybrid search, location filter, LLM answer formatting  
- **SQLite** — system of record (cafes, reviews, settings, coffee content)

## Requirements

- Node.js 18+ (tested with newer versions; uses built-in `node:sqlite`)
- Python 3.9+
- API keys (saved in admin, stored in SQLite — not in `.env`):
  - **Google** — Places API (New) + Geocoding API (for location-aware search)
  - **Parallel** — website extract
  - **OpenAI** — embeddings + chat

Enable **Geocoding API** on the same Google Cloud project as your key, and allow it under the key’s API restrictions.

## Setup

```bash
git clone https://github.com/markdragunov/barcelona-cafes.git
cd barcelona-cafes

npm install
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

## Typical workflow

### 1. Configure keys (Admin)

Open http://localhost:3847/admin and save:

- Google Places / Geocoding API key  
- Parallel API key  
- OpenAI API key  

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

1. Detect a location in the query (OpenAI) → geocode (Google) → keep cafes within **1 km** (optional)  
2. Hybrid search in parallel: vector (Chroma) + BM25  
3. Merge with Reciprocal Rank Fusion, dedupe by Places ID, take top N  
4. LLM writes a short intro + one “why” line per cafe; name, rating, address, map/site links are filled from the database  

Answers are grounded on local data only — no web search and no general LLM knowledge as the source of cafe facts.

## Data stored locally

| Path | Contents |
|------|----------|
| `data/cafes.db` | Cafes, reviews, `coffee_content`, API keys |
| `data/chroma/` | Vector index |
| `data/bm25_index.pkl` | BM25 index |

These paths are gitignored. Treat `cafes.db` as sensitive if it contains API keys.

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
- Location search needs a working Geocoding-enabled Google key; without a location in the query, search is citywide.  
- Dead or unregistered cafe websites will fail extract (e.g. DNS `NXDOMAIN`) — that is expected for some Places URLs.

## License

Private project (`package.json`). Add a license file if you plan to open-source it.
