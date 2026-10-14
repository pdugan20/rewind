-- Apple Music catalog tracklist per album, in disc/track order. A successful
-- catalog read replaces an album's rows as one set; tracklist_synced_at gates
-- the refresh and also cools down confirmed no-matches.
CREATE TABLE lastfm_album_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 1,
  album_id INTEGER NOT NULL REFERENCES lastfm_albums(id) ON DELETE CASCADE,
  apple_music_id INTEGER NOT NULL,
  disc_number INTEGER NOT NULL DEFAULT 1,
  track_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  artist_name TEXT,
  duration_ms INTEGER,
  isrc TEXT,
  preview_url TEXT,
  apple_music_url TEXT,
  synced_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_lastfm_album_tracks_position
  ON lastfm_album_tracks(user_id, album_id, disc_number, track_number);
ALTER TABLE lastfm_albums ADD COLUMN tracklist_synced_at TEXT;

-- One prepared recent-albums shelf per owner, rebuilt after each scrobble sync.
CREATE TABLE listening_discman_snapshots (
  user_id INTEGER PRIMARY KEY NOT NULL,
  snapshot TEXT NOT NULL,
  built_at TEXT NOT NULL
);
