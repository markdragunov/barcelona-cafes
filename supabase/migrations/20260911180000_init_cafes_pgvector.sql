-- Barcelona cafes: system of record + pgvector documents
create extension if not exists vector;

create table if not exists public.cafes (
  place_id text primary key,
  name text not null,
  address text,
  rating double precision,
  user_rating_count integer,
  website text,
  place_types text not null default '[]',
  latitude double precision,
  longitude double precision,
  neighborhood_id text,
  neighborhood_name text,
  coffee_content text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cafes_neighborhood on public.cafes (neighborhood_id);
create index if not exists idx_cafes_coords on public.cafes (latitude, longitude);

create table if not exists public.reviews (
  id bigserial primary key,
  place_id text not null references public.cafes (place_id) on delete cascade,
  author_name text,
  rating double precision,
  text text,
  publish_time text,
  relative_publish_time_description text,
  language_code text,
  unique (place_id, author_name, publish_time, text)
);

create index if not exists idx_reviews_place on public.reviews (place_id);

-- Replaces Chroma: one embedded document per indexable cafe
create table if not exists public.cafe_documents (
  place_id text primary key references public.cafes (place_id) on delete cascade,
  document_text text not null,
  embedding vector(1536) not null,
  metadata jsonb not null default '{}'::jsonb,
  content_hash text,
  updated_at timestamptz not null default now()
);

create index if not exists idx_cafe_documents_embedding_hnsw
  on public.cafe_documents
  using hnsw (embedding vector_cosine_ops);

-- Server uses DATABASE_URL / service role; no anon write access
alter table public.cafes enable row level security;
alter table public.reviews enable row level security;
alter table public.cafe_documents enable row level security;
