-- ドメインの集約は JSON で保存し、読み出し時に Effect Schema でデコードする。
-- 検索・結合に使う列だけを正規化して持つ。

create table registries (
  id text primary key,
  name text not null,
  namespace text,
  index_url text not null unique,
  owner_id text references "user" ("id") on delete set null,
  status_tag text not null,
  data text not null, -- Registry (JSON)
  created_at integer not null,
  updated_at integer not null
);
create index registries_owner_idx on registries (owner_id);

create table components (
  id text primary key,
  registry_id text not null references registries (id) on delete cascade,
  name text not null,
  kind text not null,
  content_hash text not null,
  snapshot text not null,   -- ComponentSnapshot (JSON)
  doc text,                 -- UsageDoc (JSON)
  enrichment text not null, -- EnrichmentState (JSON)
  updated_at integer not null
);
create index components_registry_idx on components (registry_id);
create index components_kind_idx on components (kind);

-- 実コストの台帳。月次集計で予算判断に使う
create table usage_records (
  id integer primary key autoincrement,
  category text not null,
  amount_micro_usd integer not null,
  subject text not null,
  detail text not null,
  at integer not null
);
create index usage_records_at_idx on usage_records (at);

-- D1 FTS5 による BM25 キーワード検索 (TEXT_SEARCH_BACKEND=d1 / ローカル開発)。
-- trigram トークナイザで日本語の部分一致にも対応する。
create virtual table component_fts using fts5 (
  component_id unindexed,
  registry_id unindexed,
  kind unindexed,
  body,
  tokenize = 'trigram'
);

-- ローカル開発用のベクトル保存 (本番は Vectorize)
create table local_vectors (
  id text primary key,
  component_id text not null,
  registry_id text not null,
  kind text not null,
  modality text not null,
  vector text not null
);
create index local_vectors_component_idx on local_vectors (component_id);
