-- Filter the Odyssey audiobook that Plex scrobbles to Last.fm under a
-- composite author/translator artist name. Last.fm has no tag data for this
-- artist, so tag-based audiobook detection cannot classify it.
INSERT INTO lastfm_filters (filter_type, pattern, scope, reason, user_id, created_at)
VALUES ('audiobook', 'homer, robert fagles', 'artist', 'Author and translator - The Odyssey audiobook', 1, datetime('now'));

UPDATE lastfm_artists SET is_filtered = 1
WHERE LOWER(name) = 'homer, robert fagles';

UPDATE lastfm_albums SET is_filtered = 1
WHERE artist_id IN (
  SELECT id FROM lastfm_artists WHERE LOWER(name) = 'homer, robert fagles'
);

UPDATE lastfm_tracks SET is_filtered = 1
WHERE artist_id IN (
  SELECT id FROM lastfm_artists WHERE LOWER(name) = 'homer, robert fagles'
);

-- Remove side effects emitted before the artist was recognized as filtered.
DELETE FROM activity_feed
WHERE domain = 'listening'
  AND (
    source_id IN (
      SELECT 'artist:' || id FROM lastfm_artists
      WHERE LOWER(name) = 'homer, robert fagles'
    )
    OR source_id IN (
      SELECT 'album:' || id FROM lastfm_albums
      WHERE artist_id IN (
        SELECT id FROM lastfm_artists
        WHERE LOWER(name) = 'homer, robert fagles'
      )
    )
  );

DELETE FROM search_index
WHERE domain = 'listening'
  AND (
    (entity_type = 'artist' AND entity_id IN (
      SELECT CAST(id AS TEXT) FROM lastfm_artists
      WHERE LOWER(name) = 'homer, robert fagles'
    ))
    OR (entity_type = 'album' AND entity_id IN (
      SELECT CAST(id AS TEXT) FROM lastfm_albums
      WHERE artist_id IN (
        SELECT id FROM lastfm_artists
        WHERE LOWER(name) = 'homer, robert fagles'
      )
    ))
  );
