-- Albums judged "no match" before catalog edition titles were accepted
-- ("Midnights (3am Edition)" for "Midnights") have no stored tracklist and a
-- 90-day cooldown stamp. Clear the stamp so the next sync retries them once.
UPDATE lastfm_albums
SET tracklist_synced_at = NULL
WHERE tracklist_synced_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM lastfm_album_tracks t
    WHERE t.album_id = lastfm_albums.id AND t.user_id = lastfm_albums.user_id
  );
