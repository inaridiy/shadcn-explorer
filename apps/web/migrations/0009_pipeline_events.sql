-- 生成過程の公開ログ (v0.7、packages/core/src/domain/pipeline.ts)。追記だけで、30 日で消す (日次 cron)
create table pipeline_events (
  id integer primary key autoincrement,
  at integer not null,
  registry_id text not null,
  component_id text,
  stage text not null,
  status text not null,
  message text not null,
  detail text not null default '{}'
);
create index pipeline_events_component on pipeline_events (component_id, id);
create index pipeline_events_registry on pipeline_events (registry_id, id);
create index pipeline_events_at on pipeline_events (at);
