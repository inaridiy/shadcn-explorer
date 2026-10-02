-- v0.7 取り込みのライフサイクル
-- registries.listing_tag: 出自 (Official / Shadcn / Community)。data.listing の非正規化で、カードとギャラリーの絞り込みに使う。
-- 既存の行は Community として読み、日次のディレクトリ同期が公式のものを Official に直す
alter table registries add column listing_tag text not null default 'Community';

-- 公式ディレクトリ (registries.json) の写しと取り込みの状態 (packages/core/src/domain/directory.ts)
create table directory_entries (
  name text primary key,          -- @acme
  url text not null,              -- アイテムの URL テンプレート
  homepage text,
  description text,
  health_status text,
  health_score real,
  ranking_score real,
  item_count integer,
  hidden integer not null default 0,
  state text not null,            -- New | Imported | Skipped | Delisted
  registry_id text,
  skip_reason text,
  attempts integer not null default 0,
  first_seen_at integer not null,
  checked_at integer not null
);
create index directory_entries_state on directory_entries (state, ranking_score);
