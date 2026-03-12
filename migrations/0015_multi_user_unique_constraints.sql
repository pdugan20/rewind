-- Change lastfm_artists unique constraint from (name) to (user_id, name)
-- D1/SQLite requires table recreation to modify unique constraints

CREATE TABLE lastfm_artists_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  mbid TEXT,
  name TEXT NOT NULL,
  url TEXT,
  playcount INTEGER DEFAULT 0,
  is_filtered INTEGER DEFAULT 0,
  image_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO lastfm_artists_new SELECT * FROM lastfm_artists;
DROP TABLE lastfm_artists;
ALTER TABLE lastfm_artists_new RENAME TO lastfm_artists;

CREATE UNIQUE INDEX idx_lastfm_artists_user_name ON lastfm_artists (user_id, name);
CREATE INDEX idx_lastfm_artists_user_id ON lastfm_artists (user_id);
CREATE INDEX idx_lastfm_artists_filtered ON lastfm_artists (is_filtered);

-- Change strava_activities unique constraint from (strava_id) to (user_id, strava_id)

CREATE TABLE strava_activities_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  strava_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sport_type TEXT NOT NULL DEFAULT 'Run',
  workout_type INTEGER DEFAULT 0,
  distance_meters REAL NOT NULL DEFAULT 0,
  distance_miles REAL NOT NULL DEFAULT 0,
  moving_time_seconds INTEGER NOT NULL DEFAULT 0,
  elapsed_time_seconds INTEGER NOT NULL DEFAULT 0,
  total_elevation_gain_meters REAL NOT NULL DEFAULT 0,
  total_elevation_gain_feet REAL NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL,
  start_date_local TEXT NOT NULL,
  timezone TEXT,
  start_lat REAL,
  start_lng REAL,
  city TEXT,
  state TEXT,
  country TEXT,
  average_speed_ms REAL,
  max_speed_ms REAL,
  pace_min_per_mile REAL,
  pace_formatted TEXT,
  average_heartrate REAL,
  max_heartrate REAL,
  average_cadence REAL,
  calories INTEGER,
  suffer_score INTEGER,
  map_polyline TEXT,
  gear_id TEXT,
  achievement_count INTEGER DEFAULT 0,
  pr_count INTEGER DEFAULT 0,
  is_race INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  strava_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO strava_activities_new SELECT * FROM strava_activities;
DROP TABLE strava_activities;
ALTER TABLE strava_activities_new RENAME TO strava_activities;

CREATE UNIQUE INDEX idx_strava_activities_user_strava ON strava_activities (user_id, strava_id);
CREATE INDEX idx_strava_activities_user_id ON strava_activities (user_id);
CREATE INDEX idx_strava_activities_start_date ON strava_activities (start_date);
CREATE INDEX idx_strava_activities_city ON strava_activities (city);
CREATE INDEX idx_strava_activities_gear_id ON strava_activities (gear_id);
CREATE INDEX idx_strava_activities_workout_type ON strava_activities (workout_type);
CREATE INDEX idx_strava_activities_is_deleted ON strava_activities (is_deleted);
