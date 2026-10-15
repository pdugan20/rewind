-- Manual Apple Music album pins, and the retry stamp for linking shelf albums
-- that have no catalog id (services/discman/link-albums.ts).
ALTER TABLE lastfm_albums ADD COLUMN apple_music_pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lastfm_albums ADD COLUMN catalog_link_checked_at TEXT;
