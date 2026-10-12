-- Rollout starts dark. Only a new play admits automatic work; no history scan.
ALTER TABLE cd_artwork_control ADD COLUMN automatic_enabled INTEGER NOT NULL DEFAULT 0 CHECK(automatic_enabled IN (0,1));
ALTER TABLE cd_artwork_jobs ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1));
ALTER TABLE cd_artwork_jobs ADD COLUMN expected_active_job TEXT;
ALTER TABLE cd_artwork_jobs ADD COLUMN validation_state TEXT;
ALTER TABLE cd_artwork_jobs ADD COLUMN validation_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cd_artwork_jobs ADD COLUMN validation_lease_until TEXT;
ALTER TABLE cd_artwork_jobs ADD COLUMN validation_claim TEXT;
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
    AND c.pinned=0
    AND (c.release_id<>'' OR (NEW.user_id=1 AND (SELECT automatic_enabled FROM cd_artwork_control WHERE id=1)=1))
    AND (c.last_checked_at IS NULL OR c.next_check<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND NOT (COALESCE(j.state,'')='accepted' AND COALESCE(json_extract(j.input,'$.source_kind'),'')='retail');
END;
