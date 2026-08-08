-- Permanently exclude the Prologue/Plex audiobook that arrived under its
-- author and remove every public/listening-history side effect already made.
INSERT INTO lastfm_filters (
  filter_type,
  pattern,
  scope,
  reason,
  user_id,
  created_at
)
SELECT
  'audiobook',
  'robert m. pirsig',
  'artist',
  'Author - Zen and the Art of Motorcycle Maintenance audiobook',
  1,
  datetime('now')
WHERE NOT EXISTS (
  SELECT 1
  FROM lastfm_filters
  WHERE user_id = 1
    AND filter_type = 'audiobook'
    AND scope = 'artist'
    AND LOWER(pattern) = 'robert m. pirsig'
);

UPDATE lastfm_artists
SET is_filtered = 1
WHERE LOWER(name) = 'robert m. pirsig';

UPDATE lastfm_albums
SET is_filtered = 1
WHERE artist_id IN (
  SELECT id FROM lastfm_artists WHERE LOWER(name) = 'robert m. pirsig'
);

UPDATE lastfm_tracks
SET is_filtered = 1
WHERE artist_id IN (
  SELECT id FROM lastfm_artists WHERE LOWER(name) = 'robert m. pirsig'
);

DELETE FROM activity_feed
WHERE domain = 'listening'
  AND (
    source_id IN (
      SELECT 'artist:' || id
      FROM lastfm_artists
      WHERE LOWER(name) = 'robert m. pirsig'
    )
    OR source_id IN (
      SELECT 'album:' || id
      FROM lastfm_albums
      WHERE artist_id IN (
        SELECT id
        FROM lastfm_artists
        WHERE LOWER(name) = 'robert m. pirsig'
      )
    )
  );

DELETE FROM search_index
WHERE domain = 'listening'
  AND (
    (entity_type = 'artist' AND entity_id IN (
      SELECT CAST(id AS TEXT)
      FROM lastfm_artists
      WHERE LOWER(name) = 'robert m. pirsig'
    ))
    OR (entity_type = 'album' AND entity_id IN (
      SELECT CAST(id AS TEXT)
      FROM lastfm_albums
      WHERE artist_id IN (
        SELECT id
        FROM lastfm_artists
        WHERE LOWER(name) = 'robert m. pirsig'
      )
    ))
  );

DELETE FROM images
WHERE domain = 'listening'
  AND (
    (entity_type = 'artists' AND entity_id IN (
      SELECT CAST(id AS TEXT)
      FROM lastfm_artists
      WHERE LOWER(name) = 'robert m. pirsig'
    ))
    OR (entity_type = 'albums' AND entity_id IN (
      SELECT CAST(id AS TEXT)
      FROM lastfm_albums
      WHERE artist_id IN (
        SELECT id
        FROM lastfm_artists
        WHERE LOWER(name) = 'robert m. pirsig'
      )
    ))
  );

DELETE FROM lastfm_top_tracks
WHERE track_id IN (
  SELECT id
  FROM lastfm_tracks
  WHERE artist_id IN (
    SELECT id FROM lastfm_artists WHERE LOWER(name) = 'robert m. pirsig'
  )
);

DELETE FROM lastfm_top_albums
WHERE album_id IN (
  SELECT id
  FROM lastfm_albums
  WHERE artist_id IN (
    SELECT id FROM lastfm_artists WHERE LOWER(name) = 'robert m. pirsig'
  )
);

DELETE FROM lastfm_top_artists
WHERE artist_id IN (
  SELECT id FROM lastfm_artists WHERE LOWER(name) = 'robert m. pirsig'
);

DELETE FROM lastfm_scrobbles
WHERE track_id IN (
  SELECT id
  FROM lastfm_tracks
  WHERE artist_id IN (
    SELECT id FROM lastfm_artists WHERE LOWER(name) = 'robert m. pirsig'
  )
);

-- Keep the cached summary aligned immediately. The deployed full sync refreshes
-- all monthly/yearly aggregates after the migration.
UPDATE lastfm_user_stats
SET
  total_scrobbles = (
    SELECT COUNT(*)
    FROM lastfm_scrobbles s
    JOIN lastfm_tracks t ON t.id = s.track_id
    JOIN lastfm_artists a ON a.id = t.artist_id
    WHERE t.is_filtered = 0 AND a.is_filtered = 0
  ),
  unique_artists = (
    SELECT COUNT(DISTINCT t.artist_id)
    FROM lastfm_scrobbles s
    JOIN lastfm_tracks t ON t.id = s.track_id
    JOIN lastfm_artists a ON a.id = t.artist_id
    WHERE t.is_filtered = 0 AND a.is_filtered = 0
  ),
  unique_albums = (
    SELECT COUNT(DISTINCT t.album_id)
    FROM lastfm_scrobbles s
    JOIN lastfm_tracks t ON t.id = s.track_id
    JOIN lastfm_artists a ON a.id = t.artist_id
    WHERE t.is_filtered = 0 AND a.is_filtered = 0
  ),
  unique_tracks = (
    SELECT COUNT(DISTINCT s.track_id)
    FROM lastfm_scrobbles s
    JOIN lastfm_tracks t ON t.id = s.track_id
    JOIN lastfm_artists a ON a.id = t.artist_id
    WHERE t.is_filtered = 0 AND a.is_filtered = 0
  ),
  updated_at = datetime('now')
WHERE user_id = 1;
