-- Migration 0055 cleared the retry stamp for albums whose stored Apple Music
-- id names another release, but the recovery search used the album name
-- alone, and a common name ("Star Wars") returned only other artists'
-- albums. The search now adds the artist when the name alone confirms
-- nothing; clear the stamp once more so the next sync retries them.
UPDATE lastfm_albums
SET tracklist_synced_at = NULL
WHERE tracklist_synced_at IS NOT NULL
  AND apple_music_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM lastfm_album_tracks t
    WHERE t.album_id = lastfm_albums.id AND t.user_id = lastfm_albums.user_id
  );
