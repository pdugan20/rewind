# Reading Domain Schema

## Tables

### reading_items

Unified table for all reading content. Articles from Instapaper now, books from Goodreads/Literal in the future.

```sql
CREATE TABLE reading_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  item_type TEXT NOT NULL,                      -- 'article' | 'book'
  source TEXT NOT NULL DEFAULT 'instapaper',    -- 'instapaper' | 'goodreads' | 'manual'
  source_id TEXT NOT NULL,                      -- instapaper bookmark_id

  -- Core metadata
  url TEXT,                                     -- article URL or book link
  title TEXT NOT NULL,
  author TEXT,
  description TEXT,                             -- article excerpt or book blurb

  -- Article-specific
  domain TEXT,                                  -- parsed from url (wired.com, theatlantic.com)
  site_name TEXT,                               -- from og:site_name ("Wired", "The Atlantic")
  content TEXT,                                 -- processed HTML from get_text (for full-text search, word count)
  word_count INTEGER,                           -- derived from content
  estimated_read_min INTEGER,                   -- ceil(word_count / 238)
  published_at TEXT,                            -- article:published_time from OG
  og_image_url TEXT,                            -- og:image URL (for image pipeline)
  og_description TEXT,                          -- og:description fallback
  article_tags TEXT,                            -- JSON: article:section + article:tag
  enrichment_status TEXT DEFAULT 'pending',     -- pending | completed | failed
  enrichment_error TEXT,                        -- error message if failed

  -- Book-specific (future)
  isbn TEXT,
  page_count INTEGER,
  publisher TEXT,
  published_year INTEGER,

  -- Status & progress
  status TEXT NOT NULL DEFAULT 'unread',        -- 'unread' | 'reading' | 'finished' | 'skipped' | 'abandoned'
  progress REAL NOT NULL DEFAULT 0.0,           -- 0.0-1.0
  progress_updated_at TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  rating INTEGER,                               -- 1-5 (future)

  -- Organization
  folder TEXT,                                  -- instapaper folder name
  tags TEXT,                                    -- JSON array of strings

  -- Timestamps
  saved_at TEXT NOT NULL,                       -- when user saved it
  started_at TEXT,                              -- first progress > 0
  finished_at TEXT,                             -- when moved to archive
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
```

### reading_highlights

Highlighted passages from articles or books. Links back to reading_items.

```sql
CREATE TABLE reading_highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  item_id INTEGER NOT NULL REFERENCES reading_items(id) ON DELETE CASCADE,
  source_id TEXT,                               -- instapaper highlight_id
  text TEXT NOT NULL,
  note TEXT,                                    -- personal annotation (future)
  position INTEGER DEFAULT 0,                  -- position in article
  chapter TEXT,                                 -- for books (future)
  page INTEGER,                                 -- for books (future)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(source_id, user_id)
);

CREATE INDEX idx_reading_highlights_item ON reading_highlights(item_id);
CREATE INDEX idx_reading_highlights_user ON reading_highlights(user_id);
CREATE INDEX idx_reading_highlights_created ON reading_highlights(created_at);
```

## Status Derivation

Instapaper doesn't have an explicit "read" status. Status is derived from folder and progress:

| Instapaper state                              | Rewind status | Rationale                                             |
| --------------------------------------------- | ------------- | ----------------------------------------------------- |
| `progress == 0`, folder `unread`              | `unread`      | Never opened                                          |
| `progress > 0` and `< 0.75`, folder `unread`  | `reading`     | Started but not finished                              |
| `progress >= 0.75`, any folder                | `finished`    | Read most of it (threshold accounts for footers/bios) |
| `progress == 0`, folder `archive`             | `skipped`     | Archived without reading                              |
| `progress > 0` and `< 0.75`, folder `archive` | `abandoned`   | Started but gave up                                   |

Starred is orthogonal to status — a bookmark can be starred in any status. `starred=1` is set independently.

Valid statuses: `unread`, `reading`, `finished`, `skipped`, `abandoned`

### Timestamp derivation

- `saved_at` = bookmark `time` field from Instapaper
- `started_at` = first time we see `progress > 0` (set once, never overwritten)
- `finished_at` = first time we see `progress >= 0.75` (set once)

## Response Shapes

### Article (in list endpoints)

```json
{
  "id": 1,
  "title": "OpenAI's President Gave Millions to Trump",
  "url": "https://www.wired.com/story/openai-greg-brockman-trump/",
  "author": "Maxwell Zeff",
  "domain": "wired.com",
  "site_name": "Wired",
  "description": "OpenAI's president and cofounder...",
  "word_count": 2400,
  "estimated_read_min": 10,
  "status": "finished",
  "progress": 1.0,
  "starred": true,
  "tags": ["tech", "politics"],
  "image": {
    "url": "https://cdn.rewind.rest/reading/articles/1/...",
    "thumbhash": "...",
    "dominant_color": "#1a1a2e",
    "accent_color": "#e94560"
  },
  "highlight_count": 3,
  "saved_at": "2026-03-22T14:00:00Z",
  "finished_at": "2026-03-22T16:00:00Z"
}
```

### Article detail (includes highlights)

Same as above, plus:

```json
{
  "highlights": [
    {
      "id": 5,
      "text": "doesn't consider himself political, which is surprising",
      "note": null,
      "position": 42,
      "created_at": "2026-03-22T15:30:00Z"
    }
  ]
}
```

### Highlight (in highlights list)

```json
{
  "id": 5,
  "text": "doesn't consider himself political, which is surprising",
  "note": null,
  "position": 42,
  "created_at": "2026-03-22T15:30:00Z",
  "article": {
    "id": 1,
    "title": "OpenAI's President Gave Millions to Trump",
    "author": "Maxwell Zeff",
    "domain": "wired.com",
    "url": "https://www.wired.com/story/openai-greg-brockman-trump/"
  }
}
```

## Migration Strategy

Single migration file creating both tables with all columns, including future book fields. This avoids needing ALTER TABLE when books are added -- the columns will already exist, just unused until then.
