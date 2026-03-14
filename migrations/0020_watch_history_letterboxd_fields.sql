-- Add review_url and letterboxd_guid columns to watch_history
ALTER TABLE watch_history ADD COLUMN review_url TEXT;
ALTER TABLE watch_history ADD COLUMN letterboxd_guid TEXT;

-- Unique index on letterboxd_guid for dedup (NULLs are not constrained by UNIQUE in SQLite)
CREATE UNIQUE INDEX idx_watch_history_letterboxd_guid ON watch_history(letterboxd_guid);
