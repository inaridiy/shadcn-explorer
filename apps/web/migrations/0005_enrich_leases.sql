-- エンリッチのキュー (Cloudflare Queues) の消費者が、同じコンポーネントを同時に 2 本処理しないための lease。
-- message_id: lease を持つキューメッセージ (再配信でも同じ ID なので、自分の lease を引き継げる)
-- instance_id: そのメッセージが起動したエンリッチ Workflow (再配信されたら、作り直さずに続きを待つ)
create table enrich_leases (
  component_id text primary key,
  message_id text not null,
  instance_id text,
  expires_at integer not null
);
