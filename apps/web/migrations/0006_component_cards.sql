-- カード (一覧・検索結果) を JSON 全体のデコード無しで引くための非正規化列。saveEnrichment が書き換える。
-- preview_tag: enrichment.preview._tag (ギャラリーは Captured だけを出す)
-- has_motion:  動き続ける部品 (Captured.motion がある) なら 1
alter table components add column preview_tag text not null default 'NotCaptured';
alter table components add column has_motion integer not null default 0;

update components set
  preview_tag = coalesce(json_extract(enrichment, '$.preview._tag'), 'NotCaptured'),
  has_motion = case when json_extract(enrichment, '$.preview.motion') is not null then 1 else 0 end;

-- ギャラリーは content_hash 順 (レジストリをまたいで混ざる安定した並び) の keyset ページング
create index components_gallery on components (preview_tag, content_hash);
create index components_registry_name on components (registry_id, name);
