-- Add genre tag columns to lastfm_artists.
-- `tags` stores normalized Last.fm top tags as JSON: [{"name":"Rock","count":100},...]
-- `genre` stores the primary genre (highest-weighted allowlisted tag) for fast indexed queries.

ALTER TABLE lastfm_artists ADD COLUMN tags TEXT;
ALTER TABLE lastfm_artists ADD COLUMN genre TEXT;
CREATE INDEX idx_lastfm_artists_genre ON lastfm_artists(genre);
