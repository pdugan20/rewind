import type { ArtworkEnv, Job } from './types.js';
import { now } from './types.js';
import { ownedAlbum, getPendingAutomatic, getJob } from './store.js';
import { ArtworkError } from './sources.js';
import { PROCESSOR_HASH } from './processor-version.js';
import { VERIFICATION_POLICY, automaticEligible } from './automatic.js';
import { HUB_POLICY } from './rendering.js';

/** v8 already enforced the shared edge, final light/dark view and no invented
 * rim effects. v9 makes cosmetic material confidence advisory, so accepted v8
 * results remain valid. Earlier/manual selections must enter automation. */
export function currentPublishedArtwork(
  job: Pick<
    Job,
    'automatic' | 'state' | 'candidate_hash' | 'source_hash' | 'provenance'
  > | null
) {
  if (!job?.automatic || job.state !== 'accepted' || !job.candidate_hash)
    return false;
  try {
    const p = JSON.parse(job.provenance);
    return (
      [VERIFICATION_POLICY, 'source-shaped-hub-material-fidelity-v8'].includes(
        p.verificationPolicy
      ) &&
      p.hubPolicy === HUB_POLICY &&
      p.normalization?.outerEdge?.width === 10 &&
      p.normalization?.outerEdge?.printRadius === 470 &&
      p.verifiedCandidateHash === job.candidate_hash &&
      p.verifiedMaterialHash === job.candidate_hash &&
      p.verifiedSourceHash === job.source_hash &&
      p.automaticVerification?.confidence === 'high' &&
      p.automaticVerification?.artwork_preserved === true &&
      p.automaticVerification?.lettering_preserved === true &&
      p.automaticVerification?.no_invented_content === true &&
      p.automaticVerification?.no_visible_defects === true &&
      p.automaticVerification?.concentric_geometry === true &&
      p.automaticVerification?.material_preserved === true &&
      (p.verificationPolicy !== VERIFICATION_POLICY ||
        p.automaticVerification?.no_added_rim_effects === true)
    );
  } catch {
    return false;
  }
}

/** Owner-requested reset queues the existing discovery outbox. It never imports
 * an image, changes listening history, or accepts a candidate. */
export async function queueArtworkReprocessing(
  env: ArtworkEnv,
  userId: number,
  albumIds: number[],
  dryRun = true,
  retry?: { jobId: string; allowLegacy: boolean }
) {
  const control = await env.DB.prepare(
    'SELECT enabled,automatic_enabled FROM cd_artwork_control WHERE id=1'
  ).first<{ enabled: number; automatic_enabled: number }>();
  if (userId !== 1 || !control?.enabled || !control.automatic_enabled)
    throw new ArtworkError('automatic_processing_disabled', 409);
  // Validate the whole owner batch before any writes.
  for (const id of albumIds) await ownedAlbum(env, id, userId);
  const plan = [];
  for (const id of albumIds) {
    const eligible = await env.DB.prepare(
      'SELECT a.id FROM lastfm_albums a JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id WHERE a.id=? AND a.user_id=? AND a.is_filtered=0 AND r.is_filtered=0 AND a.identity_conflict=0 AND r.identity_conflict=0'
    )
      .bind(id, userId)
      .first();
    const play = await env.DB.prepare(
      'SELECT id FROM lastfm_scrobbles WHERE user_id=? AND album_recorded=1 AND album_id=? UNION ALL SELECT s.id FROM lastfm_tracks t INDEXED BY idx_lastfm_tracks_user_album JOIN lastfm_scrobbles s INDEXED BY idx_lastfm_scrobbles_user_track_date ON s.track_id=t.id AND s.user_id=t.user_id WHERE t.user_id=? AND t.album_id=? AND s.album_recorded=0 LIMIT 1'
    )
      .bind(userId, id, userId, id)
      .first();
    const state = await env.DB.prepare(
      'SELECT c.active_job,c.pinned,c.review_hold,j.* FROM cd_artwork_albums c LEFT JOIN cd_artwork_jobs j ON j.id=c.active_job AND j.user_id=c.user_id AND j.album_id=c.album_id WHERE c.user_id=? AND c.album_id=?'
    )
      .bind(userId, id)
      .first<
        Job & { active_job: string | null; pinned: number; review_hold: number }
      >();
    const pending = await getPendingAutomatic(env, id, userId);
    const currentPending =
      pending &&
      JSON.parse(pending.provenance).processorHash === PROCESSOR_HASH;
    const existingCheck = await env.DB.prepare(
      "SELECT k.id,(SELECT json_extract(e.details,'$.processorHash') FROM cd_artwork_events e WHERE e.user_id=k.user_id AND e.album_id=k.album_id AND e.action IN ('automatic-reprocess-requested','automatic-render-retry-requested') AND json_extract(e.details,'$.checkId')=k.id ORDER BY e.id DESC LIMIT 1) AS processor_hash FROM cd_artwork_checks k WHERE k.user_id=? AND k.album_id=? AND k.completed_at IS NULL"
    )
      .bind(userId, id)
      .first<{ id: number; processor_hash: string | null }>();
    const staleCheck =
      existingCheck?.processor_hash &&
      existingCheck.processor_hash !== PROCESSOR_HASH;
    const status = !eligible
      ? 'ineligible'
      : !play
        ? 'no_recorded_play'
        : state?.pinned
          ? 'pinned'
          : state?.review_hold
            ? 'review_hold'
            : !retry && currentPublishedArtwork(state)
              ? 'current_artwork'
              : currentPending
                ? 'processing'
                : existingCheck && !staleCheck
                  ? 'already_queued'
                  : 'would_queue';
    plan.push({ id, status, state });
  }
  const items = [];
  for (const { id, state, status: plannedStatus } of plan) {
    let status = plannedStatus;
    if (status === 'would_queue' && !dryRun) {
      const stamp = now(),
        token = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT OR IGNORE INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check,discovery_evidence) VALUES(?,?,'',1,?,'{}')"
        ).bind(userId, id, stamp),
        // The token binds all following statements to this CAS winner.
        env.DB.prepare(
          "UPDATE cd_artwork_albums SET active_job=CASE WHEN ? THEN active_job ELSE NULL END,hidden_job=CASE WHEN ? THEN hidden_job ELSE COALESCE(active_job,hidden_job) END,last_checked_at=NULL,next_check=?,discovery_outcome='reprocess_requested',discovery_evidence=? WHERE user_id=? AND album_id=? AND active_job IS ? AND pinned=0 AND review_hold=0 AND (SELECT enabled=1 AND automatic_enabled=1 FROM cd_artwork_control WHERE id=1) AND EXISTS(SELECT 1 FROM lastfm_albums a JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id WHERE a.id=cd_artwork_albums.album_id AND a.user_id=cd_artwork_albums.user_id AND a.is_filtered=0 AND r.is_filtered=0 AND a.identity_conflict=0 AND r.identity_conflict=0) AND NOT EXISTS(SELECT 1 FROM cd_artwork_checks c WHERE c.user_id=cd_artwork_albums.user_id AND c.album_id=cd_artwork_albums.album_id AND c.completed_at IS NULL AND NOT EXISTS(SELECT 1 FROM cd_artwork_events e WHERE e.user_id=c.user_id AND e.album_id=c.album_id AND e.action IN ('automatic-reprocess-requested','automatic-render-retry-requested') AND json_extract(e.details,'$.checkId')=c.id AND json_extract(e.details,'$.processorHash')<>?)) AND NOT EXISTS(SELECT 1 FROM cd_artwork_jobs n WHERE n.user_id=cd_artwork_albums.user_id AND n.album_id=cd_artwork_albums.album_id AND n.automatic=1 AND json_extract(n.provenance,'$.processorHash')=? AND (n.state IN ('queued','submitted','provider_unknown','pending') OR (n.state='needs_registration' AND COALESCE(n.validation_state,'') IN ('','claimed','passed')))) AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM cd_artwork_events e WHERE e.user_id=cd_artwork_albums.user_id AND e.album_id=cd_artwork_albums.album_id AND e.job_id=? AND e.action='automatic-render-retry-requested')) RETURNING album_id"
        ).bind(
          Number(!!retry),
          Number(!!retry),
          stamp,
          JSON.stringify({
            reprocessing: token,
            processorHash: PROCESSOR_HASH,
          }),
          userId,
          id,
          state?.active_job ?? null,
          PROCESSOR_HASH,
          PROCESSOR_HASH,
          retry?.jobId ?? null,
          retry?.jobId ?? null
        ),
        env.DB.prepare(
          "UPDATE cd_artwork_checks SET completed_at=?,outcome='processor_replaced' WHERE user_id=? AND album_id=? AND completed_at IS NULL AND EXISTS(SELECT 1 FROM cd_artwork_events e WHERE e.user_id=cd_artwork_checks.user_id AND e.album_id=cd_artwork_checks.album_id AND e.action IN ('automatic-reprocess-requested','automatic-render-retry-requested') AND json_extract(e.details,'$.checkId')=cd_artwork_checks.id AND json_extract(e.details,'$.processorHash')<>?) AND EXISTS(SELECT 1 FROM cd_artwork_albums c WHERE c.user_id=? AND c.album_id=? AND json_extract(c.discovery_evidence,'$.reprocessing')=?)"
        ).bind(stamp, userId, id, PROCESSOR_HASH, userId, id, token),
        env.DB.prepare(
          "UPDATE cd_artwork_jobs SET state='needs_registration',validation_state='held',error_code='automatic_reprocess_requested',updated_at=? WHERE user_id=? AND album_id=? AND automatic=1 AND state IN ('queued','submitted','provider_unknown','needs_registration','pending') AND COALESCE(validation_state,'')<>'held' AND COALESCE(json_extract(provenance,'$.processorHash'),'')<>? AND EXISTS(SELECT 1 FROM cd_artwork_albums c WHERE c.user_id=? AND c.album_id=? AND json_extract(c.discovery_evidence,'$.reprocessing')=?)"
        ).bind(stamp, userId, id, PROCESSOR_HASH, userId, id, token),
        env.DB.prepare(
          "INSERT OR IGNORE INTO cd_artwork_checks(user_id,album_id,release_id,medium_position) SELECT user_id,album_id,release_id,medium_position FROM cd_artwork_albums WHERE user_id=? AND album_id=? AND json_extract(discovery_evidence,'$.reprocessing')=?"
        ).bind(userId, id, token),
        env.DB.prepare(
          "INSERT INTO cd_artwork_events(user_id,album_id,job_id,action,reviewer,created_at,details) SELECT user_id,album_id,COALESCE(?,hidden_job),?,?,?,json_object('processorHash',?,'allowLegacy',?,'checkId',(SELECT k.id FROM cd_artwork_checks k WHERE k.user_id=cd_artwork_albums.user_id AND k.album_id=cd_artwork_albums.album_id AND k.completed_at IS NULL)) FROM cd_artwork_albums WHERE user_id=? AND album_id=? AND json_extract(discovery_evidence,'$.reprocessing')=?"
        ).bind(
          retry?.jobId ?? null,
          retry
            ? 'automatic-render-retry-requested'
            : 'automatic-reprocess-requested',
          retry
            ? 'automatic-render-recovery'
            : 'owner-requested-pipeline-reset',
          stamp,
          PROCESSOR_HASH,
          Number(retry?.allowLegacy ?? true),
          userId,
          id,
          token
        ),
      ]);
      // Report durable admission. Retries reuse the outbox, never image imports.
      const queued = await env.DB.prepare(
        'SELECT id FROM cd_artwork_checks WHERE user_id=? AND album_id=? AND completed_at IS NULL'
      )
        .bind(userId, id)
        .first();
      status = queued ? 'queued' : 'state_changed';
    }
    items.push({ album_id: id, status });
  }
  return { dry_run: dryRun, items };
}

/** A held render admits source selection again; selection already exhausts
 * each source after its single corrective generation. No image is accepted
 * here. Provider interruptions and explicit owner review holds are excluded. */
export async function queueRenderRetry(
  env: ArtworkEnv,
  id: string,
  userId: number
) {
  const job = await getJob(env, id, userId);
  if (
    !job?.automatic ||
    job.validation_state !== 'held' ||
    !['automatic_geometry_hold', 'automatic_quality_hold'].includes(
      job.error_code ?? ''
    ) ||
    JSON.parse(job.provenance).processorHash !== PROCESSOR_HASH ||
    !(await automaticEligible(env, job))
  )
    return false;
  const previous = await env.DB.prepare(
    "SELECT id FROM cd_artwork_events WHERE user_id=? AND album_id=? AND job_id=? AND action='automatic-render-retry-requested' LIMIT 1"
  )
    .bind(userId, job.album_id, id)
    .first();
  if (previous) return false;
  const origin = JSON.parse(job.provenance).sourceIdentityEvidence
    ?.admitted_check_id;
  const replay =
    Number.isSafeInteger(origin) &&
    (await env.DB.prepare(
      "SELECT id FROM cd_artwork_events WHERE user_id=? AND album_id=? AND json_extract(details,'$.checkId')=? AND (action='automatic-reprocess-requested' OR (action='automatic-render-retry-requested' AND json_extract(details,'$.allowLegacy')=1)) LIMIT 1"
    )
      .bind(userId, job.album_id, origin)
      .first());
  // Retire only this job's admitted check, which may be waiting to revisit a
  // temporarily unavailable retail provider. Its old Workflow will cancel.
  if (Number.isSafeInteger(origin))
    await env.DB.prepare(
      "UPDATE cd_artwork_checks SET completed_at=?,outcome='render_retry' WHERE id=? AND user_id=? AND album_id=? AND completed_at IS NULL AND EXISTS(SELECT 1 FROM cd_artwork_jobs j WHERE j.id=? AND j.user_id=cd_artwork_checks.user_id AND j.album_id=cd_artwork_checks.album_id AND j.validation_state='held' AND j.error_code IN ('automatic_geometry_hold','automatic_quality_hold'))"
    )
      .bind(now(), origin, userId, job.album_id, id)
      .run();
  const result = await queueArtworkReprocessing(
    env,
    userId,
    [job.album_id],
    false,
    { jobId: id, allowLegacy: !!replay }
  );
  return result.items[0]?.status === 'queued';
}

/** Reconsider only established artwork records after a processor change. This
 * bounded recovery never scans or enrolls the listening library. */
export async function recoverOutdatedArtwork(env: ArtworkEnv) {
  const enabled = await env.DB.prepare(
    'SELECT enabled,automatic_enabled FROM cd_artwork_control WHERE id=1'
  ).first<{ enabled: number; automatic_enabled: number }>();
  if (!enabled?.enabled || !enabled.automatic_enabled) return;
  const rows = await env.DB.prepare(
    "SELECT DISTINCT c.album_id FROM cd_artwork_albums c LEFT JOIN cd_artwork_jobs a ON a.id=c.active_job AND a.user_id=c.user_id AND a.album_id=c.album_id WHERE c.user_id=1 AND c.pinned=0 AND c.review_hold=0 AND NOT EXISTS(SELECT 1 FROM cd_artwork_checks k WHERE k.user_id=c.user_id AND k.album_id=c.album_id AND k.completed_at IS NULL) AND NOT EXISTS(SELECT 1 FROM cd_artwork_events e WHERE e.user_id=c.user_id AND e.album_id=c.album_id AND e.action='automatic-reprocess-requested' AND json_extract(e.details,'$.processorHash')=?) AND ((a.state='accepted' AND COALESCE(json_extract(a.provenance,'$.verificationPolicy'),'') NOT IN (?,?)) OR (c.active_job IS NULL AND EXISTS(SELECT 1 FROM cd_artwork_jobs h WHERE h.user_id=c.user_id AND h.album_id=c.album_id AND h.automatic=1 AND h.validation_state='held' AND h.error_code IN ('automatic_geometry_hold','automatic_quality_hold') AND COALESCE(json_extract(h.provenance,'$.processorHash'),'')<>?) AND NOT EXISTS(SELECT 1 FROM cd_artwork_jobs n WHERE n.user_id=c.user_id AND n.album_id=c.album_id AND n.automatic=1 AND json_extract(n.provenance,'$.processorHash')=?))) ORDER BY c.album_id LIMIT 2"
  )
    .bind(
      PROCESSOR_HASH,
      VERIFICATION_POLICY,
      'source-shaped-hub-material-fidelity-v8',
      PROCESSOR_HASH,
      PROCESSOR_HASH
    )
    .all<{ album_id: number }>();
  if (rows.results.length)
    await queueArtworkReprocessing(
      env,
      1,
      rows.results.map((r) => r.album_id),
      false
    );
}
