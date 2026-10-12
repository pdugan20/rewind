-- Additive artwork state; no existing listening rows are rewritten.
CREATE TABLE IF NOT EXISTS cd_artwork_jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  album_id INTEGER NOT NULL REFERENCES lastfm_albums(id),
  state TEXT NOT NULL CHECK(state IN ('queued','submitted','provider_unknown','provider_failed','needs_registration','needs_material_review','pending','accepted','rejected')),
  input TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_mime TEXT NOT NULL,
  raw_key TEXT,
  candidate_hash TEXT,
  candidate_key TEXT,
  provenance TEXT NOT NULL,
  error_code TEXT,
  submitted_at TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cd_jobs_user_album ON cd_artwork_jobs(user_id, album_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cd_jobs_state ON cd_artwork_jobs(state, updated_at);
CREATE TABLE IF NOT EXISTS cd_artwork_albums (
  user_id INTEGER NOT NULL,
  album_id INTEGER NOT NULL REFERENCES lastfm_albums(id),
  release_id TEXT NOT NULL,
  medium_position INTEGER NOT NULL,
  active_job TEXT REFERENCES cd_artwork_jobs(id),
  pinned INTEGER NOT NULL DEFAULT 0,
  discovery_outcome TEXT,
  discovery_evidence TEXT,
  next_check TEXT NOT NULL,
  lease_until TEXT,
  PRIMARY KEY(user_id, album_id)
);
CREATE INDEX IF NOT EXISTS idx_cd_albums_due ON cd_artwork_albums(next_check, lease_until);
CREATE TABLE IF NOT EXISTS cd_artwork_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  album_id INTEGER NOT NULL,
  job_id TEXT,
  action TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cd_artwork_control (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled INTEGER NOT NULL DEFAULT 1,
  daily_limit INTEGER NOT NULL DEFAULT 3 CHECK(daily_limit BETWEEN 0 AND 10),
  budget_day TEXT NOT NULL DEFAULT '',
  submitted_count INTEGER NOT NULL DEFAULT 0,
  provider_next_ms INTEGER NOT NULL DEFAULT 0,
  discovery_lease_until TEXT,
  enroll_since TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO cd_artwork_control(id) VALUES(1);

CREATE INDEX IF NOT EXISTS idx_cd_scrobbles_user_date_track ON lastfm_scrobbles(user_id,scrobbled_at,track_id);
