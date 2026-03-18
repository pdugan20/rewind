-- Add Robert A. Caro as audiobook artist filter
INSERT INTO lastfm_filters (filter_type, pattern, scope, reason, user_id, created_at)
VALUES ('audiobook', 'robert a. caro', 'artist', 'Author - The Years of Lyndon Johnson audiobooks', 1, datetime('now'));

-- Mark existing Robert A. Caro artist, albums, and tracks as filtered
UPDATE lastfm_artists SET is_filtered = 1
WHERE LOWER(name) = 'robert a. caro';

UPDATE lastfm_albums SET is_filtered = 1
WHERE artist_id IN (
  SELECT id FROM lastfm_artists WHERE LOWER(name) = 'robert a. caro'
);

UPDATE lastfm_tracks SET is_filtered = 1
WHERE artist_id IN (
  SELECT id FROM lastfm_artists WHERE LOWER(name) = 'robert a. caro'
);
