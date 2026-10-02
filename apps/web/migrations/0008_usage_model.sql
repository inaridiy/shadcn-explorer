-- LLM のモデル名。OpenAI の無料枠 (Complimentary daily tokens) をモデル群 × UTC 日で集計する (v0.7)
alter table usage_records add column model text;
create index usage_records_model_idx on usage_records (at, model);
