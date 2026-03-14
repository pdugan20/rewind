-- Add is_compilation flag to lastfm_albums
ALTER TABLE lastfm_albums ADD COLUMN is_compilation INTEGER DEFAULT 0;
CREATE INDEX idx_lastfm_albums_compilation ON lastfm_albums(is_compilation, name);

-- 1. Build merge map: for each compilation album name (3+ distinct artists),
--    pick the lowest ID as the winner, all others are losers.
CREATE TABLE _compilation_map (
  album_name TEXT,
  winner_id INTEGER,
  loser_id INTEGER
);

INSERT INTO _compilation_map (album_name, winner_id, loser_id)
SELECT a.name, w.winner_id, a.id
FROM lastfm_albums a
INNER JOIN (
  SELECT LOWER(name) as lname, MIN(id) as winner_id
  FROM lastfm_albums
  GROUP BY LOWER(name)
  HAVING COUNT(DISTINCT artist_id) >= 3
) w ON LOWER(a.name) = w.lname
WHERE a.id != w.winner_id;

-- 2. Clean up dependent tables for loser albums.

DELETE FROM lastfm_top_albums
WHERE album_id IN (SELECT loser_id FROM _compilation_map);

DELETE FROM search_index
WHERE domain = 'listening' AND entity_type = 'album'
  AND CAST(entity_id AS INTEGER) IN (SELECT loser_id FROM _compilation_map);

DELETE FROM images
WHERE domain = 'listening' AND entity_type = 'albums'
  AND CAST(entity_id AS INTEGER) IN (SELECT loser_id FROM _compilation_map);

-- 3. Reparent tracks from loser albums to winner albums.
UPDATE lastfm_tracks SET album_id = (
  SELECT winner_id FROM _compilation_map WHERE loser_id = lastfm_tracks.album_id
)
WHERE album_id IN (SELECT loser_id FROM _compilation_map);

-- 4. Merge playcounts into winners and flag as compilation.
UPDATE lastfm_albums SET
  playcount = playcount + COALESCE(
    (SELECT SUM(loser.playcount)
     FROM lastfm_albums loser
     INNER JOIN _compilation_map m ON loser.id = m.loser_id
     WHERE m.winner_id = lastfm_albums.id),
    0
  ),
  is_compilation = 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') || 'Z'
WHERE id IN (SELECT DISTINCT winner_id FROM _compilation_map);

-- 5. Delete loser album rows.
DELETE FROM lastfm_albums
WHERE id IN (SELECT loser_id FROM _compilation_map);

DROP TABLE _compilation_map;
