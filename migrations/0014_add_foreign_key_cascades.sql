-- Add ON DELETE CASCADE to watch_history.movie_id -> movies.id
-- D1/SQLite requires table recreation to modify FK constraints

CREATE TABLE watch_history_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  watched_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'plex',
  user_rating REAL,
  percent_complete REAL,
  rewatch INTEGER NOT NULL DEFAULT 0,
  review TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO watch_history_new SELECT * FROM watch_history;
DROP TABLE watch_history;
ALTER TABLE watch_history_new RENAME TO watch_history;

CREATE INDEX idx_watch_history_movie_id ON watch_history (movie_id);
CREATE INDEX idx_watch_history_watched_at ON watch_history (watched_at);
CREATE INDEX idx_watch_history_user_id ON watch_history (user_id);
CREATE INDEX idx_watch_history_source ON watch_history (source);
CREATE INDEX idx_watch_history_movie_watched ON watch_history (movie_id, watched_at);

-- Add ON DELETE CASCADE to movie_genres.movie_id -> movies.id
-- and movie_genres.genre_id -> genres.id

CREATE TABLE movie_genres_new (
  movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (movie_id, genre_id)
);

INSERT INTO movie_genres_new SELECT * FROM movie_genres;
DROP TABLE movie_genres;
ALTER TABLE movie_genres_new RENAME TO movie_genres;

CREATE INDEX idx_movie_genres_genre_id ON movie_genres (genre_id);

-- Add ON DELETE CASCADE to movie_directors.movie_id -> movies.id
-- and movie_directors.director_id -> directors.id

CREATE TABLE movie_directors_new (
  movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  director_id INTEGER NOT NULL REFERENCES directors(id) ON DELETE CASCADE,
  PRIMARY KEY (movie_id, director_id)
);

INSERT INTO movie_directors_new SELECT * FROM movie_directors;
DROP TABLE movie_directors;
ALTER TABLE movie_directors_new RENAME TO movie_directors;

CREATE INDEX idx_movie_directors_director_id ON movie_directors (director_id);

-- Add ON DELETE CASCADE to lastfm_scrobbles.track_id -> lastfm_tracks.id

CREATE TABLE lastfm_scrobbles_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  track_id INTEGER NOT NULL REFERENCES lastfm_tracks(id) ON DELETE CASCADE,
  scrobbled_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO lastfm_scrobbles_new SELECT * FROM lastfm_scrobbles;
DROP TABLE lastfm_scrobbles;
ALTER TABLE lastfm_scrobbles_new RENAME TO lastfm_scrobbles;

CREATE INDEX idx_lastfm_scrobbles_track_id ON lastfm_scrobbles (track_id);
CREATE INDEX idx_lastfm_scrobbles_scrobbled_at ON lastfm_scrobbles (scrobbled_at);
CREATE INDEX idx_lastfm_scrobbles_user_id ON lastfm_scrobbles (user_id);

-- Add ON DELETE CASCADE to lastfm_tracks.artist_id -> lastfm_artists.id
-- and SET NULL for lastfm_tracks.album_id -> lastfm_albums.id

CREATE TABLE lastfm_tracks_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  mbid TEXT,
  name TEXT NOT NULL,
  artist_id INTEGER NOT NULL REFERENCES lastfm_artists(id) ON DELETE CASCADE,
  album_id INTEGER REFERENCES lastfm_albums(id) ON DELETE SET NULL,
  url TEXT,
  duration_ms INTEGER,
  is_filtered INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO lastfm_tracks_new SELECT * FROM lastfm_tracks;
DROP TABLE lastfm_tracks;
ALTER TABLE lastfm_tracks_new RENAME TO lastfm_tracks;

CREATE UNIQUE INDEX idx_lastfm_tracks_unique ON lastfm_tracks (name, artist_id);
CREATE INDEX idx_lastfm_tracks_artist_id ON lastfm_tracks (artist_id);
CREATE INDEX idx_lastfm_tracks_album_id ON lastfm_tracks (album_id);
CREATE INDEX idx_lastfm_tracks_user_id ON lastfm_tracks (user_id);
CREATE INDEX idx_lastfm_tracks_filtered ON lastfm_tracks (is_filtered);
