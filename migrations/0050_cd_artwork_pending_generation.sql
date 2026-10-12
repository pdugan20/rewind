-- A source transition must wait for its album's current automatic job.
-- No automatic jobs were admitted while the rollout switch was disabled.
CREATE UNIQUE INDEX idx_cd_automatic_pending_album ON cd_artwork_jobs(user_id,album_id)
WHERE automatic=1 AND (state IN ('queued','submitted','provider_unknown','pending')
  OR (state='needs_registration' AND COALESCE(validation_state,'') IN ('','claimed','passed')));
