-- Recreate search_index with a `body` column so we can index article body
-- text (and any other long-form per-entity text) separately from title/subtitle.
-- FTS5 virtual tables can't be ALTERed to add columns, so we drop and
-- recreate. After this migration runs, search will return empty results
-- until POST /v1/admin/reindex-search is called to backfill rows from the
-- source tables.
DROP TABLE IF EXISTS search_index;

CREATE VIRTUAL TABLE search_index USING fts5(
  domain UNINDEXED,
  entity_type UNINDEXED,
  entity_id UNINDEXED,
  title,
  subtitle,
  body,
  image_key UNINDEXED,
  tokenize='unicode61'
);
