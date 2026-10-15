-- Albums judged "no match" because their stored Apple Music id names another
-- release (Wilco's "Star Wars" stored as the "Alpha Mike Foxtrot" box) have no
-- stored tracklist and a 90-day cooldown stamp. Tracklist sync can now find
-- the right catalog album by name; clear the stamp so the next sync retries
-- them once. Sync only visits albums on the current shelf.
UPDATE lastfm_albums
SET tracklist_synced_at = NULL
WHERE tracklist_synced_at IS NOT NULL
  AND apple_music_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM lastfm_album_tracks t
    WHERE t.album_id = lastfm_albums.id AND t.user_id = lastfm_albums.user_id
  );
