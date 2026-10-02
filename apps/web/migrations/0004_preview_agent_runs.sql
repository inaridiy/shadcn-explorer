-- フォールバックの Coding Agent によるプレビュービルドの記録。
-- レジストリ単位の上限・遮断機 (成功率) の判断と、繰り返し使われる回避策 (workarounds) の把握に使う。
create table preview_agent_runs (
  id integer primary key autoincrement,
  component_id text not null,
  registry_id text not null,
  build_version text not null,
  outcome text not null,      -- succeeded | failed | rejected | gave_up | timed_out
  workarounds text not null,  -- JSON array of strings
  detail text not null,
  at integer not null
);
create index preview_agent_runs_registry_idx on preview_agent_runs (registry_id, build_version);
