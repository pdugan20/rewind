-- Add Thomas Pynchon as an audiobook artist filter.
-- Plex scrobbled the "Inherent Vice" audiobook to Last.fm (artist = author),
-- and it surfaced as "now playing". Pynchon's Last.fm tags are literature/
-- novel rather than "audiobook", so the broadened tag heuristic now catches
-- authors like him going forward; this explicit artist rule covers the
-- existing data immediately and acts as a precise override.
INSERT INTO lastfm_filters (filter_type, pattern, scope, reason, user_id, created_at)
VALUES ('audiobook', 'thomas pynchon', 'artist', 'Author - Inherent Vice and other audiobooks', 1, datetime('now'));

-- Mark existing Thomas Pynchon artist, albums, and tracks as filtered.
UPDATE lastfm_artists SET is_filtered = 1
WHERE LOWER(name) = 'thomas pynchon';

UPDATE lastfm_albums SET is_filtered = 1
WHERE artist_id IN (
  SELECT id FROM lastfm_artists WHERE LOWER(name) = 'thomas pynchon'
);

UPDATE lastfm_tracks SET is_filtered = 1
WHERE artist_id IN (
  SELECT id FROM lastfm_artists WHERE LOWER(name) = 'thomas pynchon'
);
