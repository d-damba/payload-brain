-- 1. Enable the pgvector extension
create extension if not exists vector;

-- 2. Drop existing structures to prevent conflict
drop function if exists match_payload_docs;
drop table if exists payload_docs;

-- 3. Create the documentation table
create table payload_docs (
  id bigserial primary key,
  url text not null,
  chunk_index smallint not null default 0,
  category text not null,       
  sync_batch_id uuid not null,
  content text not null,                      
  payload jsonb not null default '{}'::jsonb, 
  fts tsvector generated always as (to_tsvector('english', content)) stored, 
  embedding vector(1536),
  unique (url, chunk_index)
);

-- 4. Create the GIN index for exact keyword matching (Full Text Search)
create index on payload_docs using gin (fts);

-- 5. Create the HNSW index for fast semantic searching
create index on payload_docs using hnsw (embedding vector_cosine_ops);

-- 6. Enable Row Level Security (RLS)
alter table payload_docs enable row level security;

-- 7. Allow public read access (bypassed by Service Key for inserts)
create policy "Allow public read access" 
  on payload_docs 
  for select 
  using (true);

-- 8. Create the Hybrid Search (RRF) function
create or replace function match_payload_docs (
  query_text text,
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  filter_category text default null
)
returns table (
  id bigint,
  url text,
  chunk_index smallint,
  category text,
  content text,
  payload jsonb,             
  rrf_score float,
  fts_rank int,
  vector_rank int,
  vector_similarity float,
  is_adjacent boolean
)
language sql stable
as $$
  with fts_search as (
    select
      id,
      row_number() over (order by ts_rank(fts, websearch_to_tsquery('english', query_text)) desc) as rank_ix
    from payload_docs
    where fts @@ websearch_to_tsquery('english', query_text)
      and (filter_category is null or category = filter_category)
    order by ts_rank(fts, websearch_to_tsquery('english', query_text)) desc
    limit 100
  ),
  vector_search as (
    select
      id,
      1 - (embedding <=> query_embedding) as cosine_sim,
      row_number() over (order by embedding <=> query_embedding) as rank_ix
    from payload_docs
    where 1 - (embedding <=> query_embedding) > match_threshold
      and (filter_category is null or category = filter_category)
    order by embedding <=> query_embedding
    limit 100
  ),
  ranked as (
    select
      w.id,
      w.url,
      w.chunk_index,
      w.category,
      w.content,
      w.payload,
      (coalesce(1.0 / (60 + f.rank_ix), 0.0) * (case when w.content ilike '%' || query_text || '%' then 1.5 else 1.0 end)) + coalesce(1.0 / (60 + v.rank_ix), 0.0) as rrf_score,
      f.rank_ix::int as fts_rank,
      v.rank_ix::int as vector_rank,
      v.cosine_sim::float as vector_similarity
    from payload_docs w
    full outer join fts_search f on w.id = f.id
    full outer join vector_search v on w.id = v.id
    where coalesce(1.0 / (60 + f.rank_ix), 0.0) + coalesce(1.0 / (60 + v.rank_ix), 0.0) > 0
  ),
  deduplicated as (
    select distinct on (url) *
    from ranked
    order by url, rrf_score desc
  ),
  top_matches as (
    select *
    from deduplicated
    order by rrf_score desc
    limit match_count
  ),
  adjacent as (
    select distinct on (w.url, w.chunk_index)
      w.id,
      w.url,
      w.chunk_index,
      w.category,
      w.content,
      w.payload,
      0.0::float as rrf_score,
      null::int as fts_rank,
      null::int as vector_rank,
      null::float as vector_similarity
    from top_matches tm
    join payload_docs w
      on w.url = tm.url
      and w.chunk_index in (tm.chunk_index - 1, tm.chunk_index + 1)
    where not exists (
      select 1 from top_matches tm2
      where tm2.url = w.url and tm2.chunk_index = w.chunk_index
    )
  )
  select id, url, chunk_index, category, content, payload, rrf_score, fts_rank, vector_rank, vector_similarity, false as is_adjacent from top_matches
  union all
  select id, url, chunk_index, category, content, payload, rrf_score, fts_rank, vector_rank, vector_similarity, true as is_adjacent from adjacent;
$$;