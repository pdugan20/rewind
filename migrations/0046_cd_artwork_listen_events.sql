-- Admission is atomic with a newly recorded play; no historical library scan.
ALTER TABLE cd_artwork_albums ADD COLUMN last_checked_at TEXT;
CREATE TABLE cd_artwork_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  album_id INTEGER NOT NULL REFERENCES lastfm_albums(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL,
  medium_position INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  dispatched_at TEXT,
  completed_at TEXT,
  recoveries INTEGER NOT NULL DEFAULT 0,
  outcome TEXT
);
CREATE UNIQUE INDEX idx_cd_check_pending_album ON cd_artwork_checks(user_id,album_id) WHERE completed_at IS NULL;
CREATE INDEX idx_cd_check_dispatch ON cd_artwork_checks(dispatched_at,completed_at,id);
CREATE TRIGGER cd_artwork_on_listen AFTER INSERT ON lastfm_scrobbles
WHEN (SELECT enabled FROM cd_artwork_control WHERE id=1)=1
  AND NEW.scrobbled_at >= (SELECT enroll_since FROM cd_artwork_control WHERE id=1)
BEGIN
  -- Unknown owner albums remain non-paid identity holds. Do not infer editions.
  INSERT OR IGNORE INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check,discovery_outcome,discovery_evidence)
  SELECT a.user_id,a.id,'',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'identity_required','{}'
  FROM lastfm_tracks t JOIN lastfm_albums a ON a.id=t.album_id AND a.user_id=t.user_id
  JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id
  WHERE t.id=NEW.track_id AND t.user_id=NEW.user_id AND NEW.user_id=1
    AND t.is_filtered=0 AND a.is_filtered=0 AND r.is_filtered=0;

  -- Existing monthly dates are superseded on the first new play. Thereafter,
  -- a completed check's cooldown must expire AND another play must arrive.
  INSERT OR IGNORE INTO cd_artwork_checks(user_id,album_id,release_id,medium_position)
  SELECT c.user_id,c.album_id,c.release_id,c.medium_position
  FROM lastfm_tracks t JOIN lastfm_albums a ON a.id=t.album_id AND a.user_id=t.user_id
  JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id
  JOIN cd_artwork_albums c ON c.album_id=a.id AND c.user_id=a.user_id
  LEFT JOIN cd_artwork_jobs j ON j.id=c.active_job AND j.user_id=c.user_id AND j.album_id=c.album_id
  WHERE t.id=NEW.track_id AND t.user_id=NEW.user_id
    AND t.is_filtered=0 AND a.is_filtered=0 AND r.is_filtered=0
    AND c.release_id<>''
    AND (c.last_checked_at IS NULL OR c.next_check<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND NOT (COALESCE(j.state,'')='accepted' AND COALESCE(json_extract(j.input,'$.source_kind'),'')='retail');
END;
