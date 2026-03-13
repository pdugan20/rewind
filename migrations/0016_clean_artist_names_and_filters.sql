-- 1. Merge fragmented "feat." artist entries into their base artist.

-- Step 1a: Build mapping from feat. artist IDs to base artist IDs.
CREATE TABLE _artist_merge_map (old_id INTEGER, new_id INTEGER);

INSERT INTO _artist_merge_map (old_id, new_id)
SELECT
  feat.id,
  base.id
FROM lastfm_artists feat
INNER JOIN lastfm_artists base ON LOWER(base.name) = LOWER(
  TRIM(
    SUBSTR(feat.name, 1,
      MIN(
        CASE WHEN INSTR(LOWER(feat.name), ' feat.') > 0 THEN INSTR(LOWER(feat.name), ' feat.') ELSE 999999 END,
        CASE WHEN INSTR(LOWER(feat.name), ' feat ') > 0 THEN INSTR(LOWER(feat.name), ' feat ') ELSE 999999 END,
        CASE WHEN INSTR(LOWER(feat.name), ' ft.') > 0 THEN INSTR(LOWER(feat.name), ' ft.') ELSE 999999 END,
        CASE WHEN INSTR(LOWER(feat.name), ' ft ') > 0 THEN INSTR(LOWER(feat.name), ' ft ') ELSE 999999 END,
        CASE WHEN INSTR(LOWER(feat.name), ' featuring ') > 0 THEN INSTR(LOWER(feat.name), ' featuring ') ELSE 999999 END
      ) - 1
    )
  )
)
WHERE (LOWER(feat.name) LIKE '% feat.%'
    OR LOWER(feat.name) LIKE '% feat %'
    OR LOWER(feat.name) LIKE '% ft.%'
    OR LOWER(feat.name) LIKE '% ft %'
    OR LOWER(feat.name) LIKE '% featuring %')
  AND feat.id != base.id;

-- Step 1b: Delete ALL top-list entries for feat. artists upfront.
DELETE FROM lastfm_top_artists
WHERE artist_id IN (SELECT old_id FROM _artist_merge_map);

DELETE FROM lastfm_top_albums
WHERE album_id IN (
  SELECT id FROM lastfm_albums WHERE artist_id IN (SELECT old_id FROM _artist_merge_map)
);

DELETE FROM lastfm_top_tracks
WHERE track_id IN (
  SELECT id FROM lastfm_tracks WHERE artist_id IN (SELECT old_id FROM _artist_merge_map)
);

-- Step 1c: For each feat. track, try to find a matching base track (same name, base artist).
--          If found, move scrobbles to the base track.
UPDATE lastfm_scrobbles SET track_id = (
  SELECT base_track.id FROM lastfm_tracks base_track
  INNER JOIN lastfm_tracks dup_track ON dup_track.id = lastfm_scrobbles.track_id
  INNER JOIN _artist_merge_map m ON dup_track.artist_id = m.old_id
    AND base_track.name = dup_track.name
    AND base_track.artist_id = m.new_id
  LIMIT 1
)
WHERE track_id IN (
  SELECT t.id FROM lastfm_tracks t
  INNER JOIN _artist_merge_map m ON t.artist_id = m.old_id
  WHERE EXISTS (
    SELECT 1 FROM lastfm_tracks base_t
    WHERE base_t.name = t.name AND base_t.artist_id = m.new_id
  )
);

-- Delete the now-orphaned duplicate tracks (base track exists).
DELETE FROM lastfm_tracks
WHERE id IN (
  SELECT dup.id FROM lastfm_tracks dup
  INNER JOIN _artist_merge_map m ON dup.artist_id = m.old_id
  WHERE EXISTS (
    SELECT 1 FROM lastfm_tracks base
    WHERE base.name = dup.name AND base.artist_id = m.new_id
  )
);

-- Step 1d: For feat. tracks with NO base match, we need to pick one "winner" per
--          (track_name, new_id) group to avoid unique constraint collisions when re-parenting.
--          Move scrobbles from losers to winner, then delete losers.

-- Build a table of winner track IDs (lowest id per group).
CREATE TABLE _track_winners (name TEXT, new_artist_id INTEGER, winner_id INTEGER);

INSERT INTO _track_winners (name, new_artist_id, winner_id)
SELECT t.name, m.new_id, MIN(t.id)
FROM lastfm_tracks t
INNER JOIN _artist_merge_map m ON t.artist_id = m.old_id
GROUP BY t.name, m.new_id
HAVING COUNT(*) > 1;

-- Move scrobbles from loser tracks to winner tracks.
UPDATE lastfm_scrobbles SET track_id = (
  SELECT w.winner_id FROM _track_winners w
  INNER JOIN lastfm_tracks t ON t.id = lastfm_scrobbles.track_id
  INNER JOIN _artist_merge_map m ON t.artist_id = m.old_id
  WHERE w.name = t.name AND w.new_artist_id = m.new_id
  LIMIT 1
)
WHERE track_id IN (
  SELECT t.id FROM lastfm_tracks t
  INNER JOIN _artist_merge_map m ON t.artist_id = m.old_id
  INNER JOIN _track_winners w ON w.name = t.name AND w.new_artist_id = m.new_id
  WHERE t.id != w.winner_id
);

-- Delete loser tracks.
DELETE FROM lastfm_tracks
WHERE id IN (
  SELECT t.id FROM lastfm_tracks t
  INNER JOIN _artist_merge_map m ON t.artist_id = m.old_id
  INNER JOIN _track_winners w ON w.name = t.name AND w.new_artist_id = m.new_id
  WHERE t.id != w.winner_id
);

DROP TABLE _track_winners;

-- Step 1e: Same dedup for albums -- pick one winner per (album_name, new_id) group.
CREATE TABLE _album_winners (name TEXT, new_artist_id INTEGER, winner_id INTEGER);

INSERT INTO _album_winners (name, new_artist_id, winner_id)
SELECT a.name, m.new_id, MIN(a.id)
FROM lastfm_albums a
INNER JOIN _artist_merge_map m ON a.artist_id = m.old_id
GROUP BY a.name, m.new_id
HAVING COUNT(*) > 1;

-- Re-parent tracks from loser albums to winner albums.
UPDATE lastfm_tracks SET album_id = (
  SELECT w.winner_id FROM _album_winners w
  INNER JOIN lastfm_albums a ON a.id = lastfm_tracks.album_id
  INNER JOIN _artist_merge_map m ON a.artist_id = m.old_id
  WHERE w.name = a.name AND w.new_artist_id = m.new_id
  LIMIT 1
)
WHERE album_id IN (
  SELECT a.id FROM lastfm_albums a
  INNER JOIN _artist_merge_map m ON a.artist_id = m.old_id
  INNER JOIN _album_winners w ON w.name = a.name AND w.new_artist_id = m.new_id
  WHERE a.id != w.winner_id
);

-- Merge playcounts into winner albums.
UPDATE lastfm_albums SET playcount = playcount + COALESCE(
  (SELECT SUM(loser.playcount) FROM lastfm_albums loser
   INNER JOIN _artist_merge_map m ON loser.artist_id = m.old_id
   INNER JOIN _album_winners w ON w.name = loser.name AND w.new_artist_id = m.new_id
   WHERE loser.id != w.winner_id
     AND w.winner_id = lastfm_albums.id),
  0
)
WHERE id IN (SELECT winner_id FROM _album_winners);

-- Delete loser albums.
DELETE FROM lastfm_albums
WHERE id IN (
  SELECT a.id FROM lastfm_albums a
  INNER JOIN _artist_merge_map m ON a.artist_id = m.old_id
  INNER JOIN _album_winners w ON w.name = a.name AND w.new_artist_id = m.new_id
  WHERE a.id != w.winner_id
);

DROP TABLE _album_winners;

-- Step 1f: Now handle albums that collide with an existing base artist album.
-- Re-parent tracks from feat. album to base album.
UPDATE lastfm_tracks SET album_id = (
  SELECT base_album.id FROM lastfm_albums base_album
  INNER JOIN lastfm_albums dup_album ON dup_album.id = lastfm_tracks.album_id
  INNER JOIN _artist_merge_map m ON dup_album.artist_id = m.old_id
    AND base_album.name = dup_album.name
    AND base_album.artist_id = m.new_id
  LIMIT 1
)
WHERE album_id IN (
  SELECT dup.id FROM lastfm_albums dup
  INNER JOIN _artist_merge_map m ON dup.artist_id = m.old_id
  WHERE EXISTS (
    SELECT 1 FROM lastfm_albums base
    WHERE base.name = dup.name AND base.artist_id = m.new_id
  )
);

-- Merge playcounts into base albums.
UPDATE lastfm_albums SET playcount = playcount + COALESCE(
  (SELECT dup.playcount FROM lastfm_albums dup
   INNER JOIN _artist_merge_map m ON dup.artist_id = m.old_id
   WHERE dup.name = lastfm_albums.name
     AND lastfm_albums.artist_id = m.new_id),
  0
)
WHERE id IN (
  SELECT base_album.id
  FROM lastfm_albums base_album
  INNER JOIN lastfm_albums dup_album ON dup_album.name = base_album.name
  INNER JOIN _artist_merge_map m ON dup_album.artist_id = m.old_id AND base_album.artist_id = m.new_id
);

-- Delete the duplicate albums.
DELETE FROM lastfm_albums
WHERE id IN (
  SELECT dup.id FROM lastfm_albums dup
  INNER JOIN _artist_merge_map m ON dup.artist_id = m.old_id
  WHERE EXISTS (
    SELECT 1 FROM lastfm_albums base
    WHERE base.name = dup.name AND base.artist_id = m.new_id
  )
);

-- Step 1g: Re-parent all remaining feat. tracks and albums to base artist.
-- These are guaranteed unique now (no collisions with base or each other).
UPDATE lastfm_tracks SET artist_id = (
  SELECT new_id FROM _artist_merge_map WHERE old_id = lastfm_tracks.artist_id
)
WHERE artist_id IN (SELECT old_id FROM _artist_merge_map);

UPDATE lastfm_albums SET artist_id = (
  SELECT new_id FROM _artist_merge_map WHERE old_id = lastfm_albums.artist_id
)
WHERE artist_id IN (SELECT old_id FROM _artist_merge_map);

-- Step 1h: Clean up feat. artist metadata.
DELETE FROM images
WHERE domain = 'listening' AND entity_type = 'artists'
  AND CAST(entity_id AS INTEGER) IN (SELECT old_id FROM _artist_merge_map);

DELETE FROM search_index
WHERE domain = 'listening' AND entity_type = 'artist'
  AND CAST(entity_id AS INTEGER) IN (SELECT old_id FROM _artist_merge_map);

-- Step 1i: Delete the orphaned feat. artist rows.
DELETE FROM lastfm_artists
WHERE id IN (SELECT old_id FROM _artist_merge_map);

DROP TABLE _artist_merge_map;

-- 2. Seed new audiobook/podcast filters.

INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at)
VALUES (1, 'audiobook', 'andrew ross sorkin', 'artist', 'Podcast/interview, not music', '2026-03-13T00:00:00.000Z');

INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at)
VALUES (1, 'audiobook', 'inherent vice', 'album', 'Audiobook album', '2026-03-13T00:00:00.000Z');

INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at)
VALUES (1, 'audiobook', 'toddler songs', 'album', 'Kids music, not personal listening', '2026-03-13T00:00:00.000Z');

-- 3. Mark existing entities as filtered based on new rules.
UPDATE lastfm_artists SET is_filtered = 1
WHERE LOWER(name) = 'andrew ross sorkin';

UPDATE lastfm_albums SET is_filtered = 1
WHERE LOWER(name) LIKE '%inherent vice%'
   OR LOWER(name) LIKE '%toddler songs%';
