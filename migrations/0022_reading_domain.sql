-- Reading domain: articles (Instapaper) and books (future)
CREATE TABLE reading_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  item_type TEXT NOT NULL DEFAULT 'article',
  source TEXT NOT NULL DEFAULT 'instapaper',
  source_id TEXT NOT NULL,

  -- Core metadata
  url TEXT,
  title TEXT NOT NULL,
  author TEXT,
  description TEXT,

  -- Article-specific
  domain TEXT,
  site_name TEXT,
  content TEXT,
  word_count INTEGER,
  estimated_read_min INTEGER,

  -- Book-specific (future)
  isbn TEXT,
  page_count INTEGER,
  publisher TEXT,
  published_year INTEGER,

  -- Status & progress
  status TEXT NOT NULL DEFAULT 'unread',
  progress REAL NOT NULL DEFAULT 0.0,
  progress_updated_at TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  rating INTEGER,

  -- Organization
  folder TEXT,
  tags TEXT,

  -- Timestamps
  saved_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(source, source_id, user_id)
);

CREATE INDEX idx_reading_items_user_status ON reading_items(user_id, status);
CREATE INDEX idx_reading_items_user_type ON reading_items(user_id, item_type);
CREATE INDEX idx_reading_items_saved_at ON reading_items(saved_at);
CREATE INDEX idx_reading_items_finished_at ON reading_items(finished_at);
CREATE INDEX idx_reading_items_domain ON reading_items(domain);
CREATE INDEX idx_reading_items_source ON reading_items(source, source_id);

-- Highlights / annotations
CREATE TABLE reading_highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  item_id INTEGER NOT NULL REFERENCES reading_items(id) ON DELETE CASCADE,
  source_id TEXT,
  text TEXT NOT NULL,
  note TEXT,
  position INTEGER DEFAULT 0,
  chapter TEXT,
  page INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(source_id, user_id)
);

CREATE INDEX idx_reading_highlights_item ON reading_highlights(item_id);
CREATE INDEX idx_reading_highlights_user ON reading_highlights(user_id);
CREATE INDEX idx_reading_highlights_created ON reading_highlights(created_at);
