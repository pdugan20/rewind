-- Review feedback is private and separate from generation/publication state.
ALTER TABLE cd_artwork_jobs ADD COLUMN review_claim TEXT;
ALTER TABLE cd_artwork_jobs ADD COLUMN feedback_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(feedback_status IN ('unreviewed','good','needs_revision','resolved'));
ALTER TABLE cd_artwork_jobs ADD COLUMN feedback_reason TEXT;
ALTER TABLE cd_artwork_jobs ADD COLUMN feedback_note TEXT NOT NULL DEFAULT '';
ALTER TABLE cd_artwork_jobs ADD COLUMN feedback_updated_at TEXT;
ALTER TABLE cd_artwork_albums ADD COLUMN review_hold INTEGER NOT NULL DEFAULT 0 CHECK(review_hold IN (0,1));
ALTER TABLE cd_artwork_albums ADD COLUMN hidden_job TEXT;
ALTER TABLE cd_artwork_albums ADD COLUMN visibility_revision INTEGER NOT NULL DEFAULT 1 CHECK(visibility_revision BETWEEN 1 AND 9007199254740991);
CREATE TRIGGER cd_artwork_visibility_revision AFTER UPDATE OF active_job,hidden_job ON cd_artwork_albums
WHEN NEW.active_job IS NOT OLD.active_job OR NEW.hidden_job IS NOT OLD.hidden_job
BEGIN
  UPDATE cd_artwork_albums SET visibility_revision=visibility_revision+1 WHERE user_id=NEW.user_id AND album_id=NEW.album_id;
END;
ALTER TABLE cd_artwork_events ADD COLUMN details TEXT;
CREATE INDEX idx_cd_jobs_gallery ON cd_artwork_jobs(user_id,created_at DESC,id DESC);
CREATE INDEX idx_cd_jobs_feedback ON cd_artwork_jobs(user_id,album_id,feedback_status);
CREATE INDEX idx_cd_events_job ON cd_artwork_events(user_id,job_id,id DESC);
DROP TRIGGER cd_artwork_on_listen;

CREATE TRIGGER cd_artwork_on_listen AFTER INSERT ON lastfm_scrobbles
WHEN (SELECT enabled FROM cd_artwork_control WHERE id=1)=1
  AND NEW.scrobbled_at >= (SELECT enroll_since FROM cd_artwork_control WHERE id=1)
BEGIN
  INSERT OR IGNORE INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check,discovery_outcome,discovery_evidence)
  SELECT a.user_id,a.id,'',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'identity_required','{}'
  FROM lastfm_tracks t JOIN lastfm_albums a ON a.id=IIF(NEW.album_recorded=1,NEW.album_id,t.album_id) AND a.user_id=t.user_id
  JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id
  WHERE t.id=NEW.track_id AND t.user_id=NEW.user_id AND NEW.user_id=1
    AND t.is_filtered=0 AND a.is_filtered=0 AND a.identity_conflict=0 AND r.is_filtered=0 AND r.identity_conflict=0;

  INSERT OR IGNORE INTO cd_artwork_checks(user_id,album_id,release_id,medium_position)
  SELECT c.user_id,c.album_id,c.release_id,c.medium_position
  FROM lastfm_tracks t JOIN lastfm_albums a ON a.id=IIF(NEW.album_recorded=1,NEW.album_id,t.album_id) AND a.user_id=t.user_id
  JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id
  JOIN cd_artwork_albums c ON c.album_id=a.id AND c.user_id=a.user_id
  LEFT JOIN cd_artwork_jobs j ON j.id=c.active_job AND j.user_id=c.user_id AND j.album_id=c.album_id
  WHERE t.id=NEW.track_id AND t.user_id=NEW.user_id
    AND t.is_filtered=0 AND a.is_filtered=0 AND a.identity_conflict=0 AND r.is_filtered=0 AND r.identity_conflict=0
    AND c.pinned=0 AND c.review_hold=0
    AND (c.release_id<>'' OR (NEW.user_id=1 AND (SELECT automatic_enabled FROM cd_artwork_control WHERE id=1)=1))
    AND (c.last_checked_at IS NULL OR c.next_check<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND NOT (COALESCE(j.state,'')='accepted' AND COALESCE(json_extract(j.input,'$.source_kind'),'')='retail');
END;
