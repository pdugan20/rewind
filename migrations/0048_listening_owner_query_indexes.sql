-- User scope must stay selective when combined with per-track/album joins.
CREATE INDEX IF NOT EXISTS idx_lastfm_scrobbles_user_track_date
  ON lastfm_scrobbles(user_id,track_id,scrobbled_at);
CREATE INDEX IF NOT EXISTS idx_lastfm_scrobbles_user_date
  ON lastfm_scrobbles(user_id,scrobbled_at,id);
CREATE INDEX IF NOT EXISTS idx_lastfm_tracks_user_album
  ON lastfm_tracks(user_id,album_id);
CREATE INDEX IF NOT EXISTS idx_lastfm_tracks_user_artist
  ON lastfm_tracks(user_id,artist_id);
