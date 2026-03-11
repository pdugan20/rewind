CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  domain,
  entity_type,
  entity_id,
  title,
  subtitle,
  image_key,
  tokenize='unicode61'
);
