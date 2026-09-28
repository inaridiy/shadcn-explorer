-- コストの帰属: どのレジストリの処理で発生したコストか (レジストリ別・登録者別の集計とクォータに使う)
alter table usage_records add column registry_id text;
create index usage_records_registry_idx on usage_records (registry_id, at);
