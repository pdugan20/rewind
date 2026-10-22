import type { ArtworkEnv, Job } from './types.js';
import { now, sha256 } from './types.js';
import { ArtworkError } from './sources.js';
import { getJob } from './store.js';
import { refreshReviewHold } from './feedback.js';
import { artworkMetadata } from './metadata.js';
import { validateCandidate } from './registration.js';
import { syncAcceptedArtworkStatus } from './provider-failure.js';
export async function reviewJob(
  env: ArtworkEnv,
  id: string,
  userId: number,
  decision: 'accepted' | 'rejected',
  activate: boolean,
  reviewer: string,
  expectedActiveJob?: string | null
) {
  const job = await getJob(env, id, userId);
  if (!job) throw new ArtworkError('job_not_found', 404);
  if (
    !job.candidate_key ||
    !job.candidate_hash ||
    !['pending', 'accepted', 'rejected'].includes(job.state)
  )
    throw new ArtworkError('candidate_not_reviewable', 409);
  const album = await env.DB.prepare(
    'SELECT active_job,pinned FROM cd_artwork_albums WHERE user_id=? AND album_id=?'
  )
    .bind(userId, job.album_id)
    .first<{ active_job: string | null; pinned: number }>();
  if (!album) throw new ArtworkError('album_not_found', 404);
  if (
    activate &&
    expectedActiveJob !== undefined &&
    album.active_job !== expectedActiveJob
  )
    throw new ArtworkError('activation_conflict', 409);
  if (activate && (decision !== 'accepted' || album.pinned))
    throw new ArtworkError('activation_not_allowed', 409);
  if (decision === 'rejected' && album.active_job === id)
    throw new ArtworkError('active_asset_requires_replacement', 409);
  if (decision === 'accepted') {
    const object = await env.ARTWORK.get(job.candidate_key);
    if (!object) throw new ArtworkError('candidate_missing', 409);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (
      (await sha256(bytes)) !== job.candidate_hash ||
      !validateCandidate(bytes).pass
    )
      throw new ArtworkError('candidate_integrity_failed', 409);
    await env.IMAGES.put(
      `listening/cd-artwork/${job.candidate_hash}.png`,
      bytes,
      {
        httpMetadata: {
          contentType: 'image/png',
          cacheControl: 'public, max-age=31536000, immutable',
        },
        onlyIf: { etagDoesNotMatch: '*' },
      }
    );
  }
  // Conditional changes protect the active asset even when review/activation
  // requests arrive concurrently. D1 batch is transactional.
  const timestamp = now(),
    reviewClaim = crypto.randomUUID();
  if (decision === 'rejected') {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE cd_artwork_jobs SET state='rejected',updated_at=? WHERE id=? AND user_id=? AND NOT EXISTS(SELECT 1 FROM cd_artwork_albums WHERE user_id=? AND album_id=? AND active_job=?)"
      ).bind(timestamp, id, userId, userId, job.album_id, id),
      env.DB.prepare(
        "INSERT INTO cd_artwork_events(user_id,album_id,job_id,action,reviewer,created_at) SELECT ?,?,?, 'rejected',?,? WHERE EXISTS(SELECT 1 FROM cd_artwork_jobs WHERE id=? AND user_id=? AND state='rejected')"
      ).bind(userId, job.album_id, id, reviewer, timestamp, id, userId),
    ]);
  } else {
    const acceptSql =
      "UPDATE cd_artwork_jobs SET state='accepted',updated_at=?,review_claim=? WHERE id=? AND user_id=? AND state=?";
    const statements = [
      activate
        ? env.DB.prepare(
            acceptSql +
              ' AND EXISTS(SELECT 1 FROM cd_artwork_albums WHERE user_id=? AND album_id=? AND pinned=0 AND active_job IS ?)'
          ).bind(
            timestamp,
            reviewClaim,
            id,
            userId,
            job.state,
            userId,
            job.album_id,
            album.active_job
          )
        : env.DB.prepare(acceptSql).bind(
            timestamp,
            reviewClaim,
            id,
            userId,
            job.state
          ),
    ];
    const claimed =
      "EXISTS(SELECT 1 FROM cd_artwork_jobs WHERE id=? AND user_id=? AND state='accepted' AND review_claim=?)";
    if (activate) {
      statements.push(
        env.DB.prepare(
          `UPDATE cd_artwork_albums SET active_job=?,release_id=COALESCE((SELECT json_extract(input,'$.release_id') FROM cd_artwork_jobs WHERE id=?),release_id),medium_position=COALESCE((SELECT json_extract(input,'$.medium_position') FROM cd_artwork_jobs WHERE id=?),medium_position) WHERE user_id=? AND album_id=? AND pinned=0 AND active_job IS ? AND ${claimed}`
        ).bind(
          id,
          id,
          id,
          userId,
          job.album_id,
          album.active_job,
          id,
          userId,
          reviewClaim
        ),
        env.DB.prepare(
          `INSERT INTO cd_artwork_events(user_id,album_id,job_id,action,reviewer,created_at) SELECT user_id,album_id,id,'revision-resolved',?,? FROM cd_artwork_jobs WHERE user_id=? AND album_id=? AND feedback_status='needs_revision' AND ${claimed}`
        ).bind(
          reviewer,
          timestamp,
          userId,
          job.album_id,
          id,
          userId,
          reviewClaim
        ),
        env.DB.prepare(
          `UPDATE cd_artwork_jobs SET feedback_status='resolved',feedback_updated_at=? WHERE user_id=? AND album_id=? AND feedback_status='needs_revision' AND ${claimed}`
        ).bind(timestamp, userId, job.album_id, id, userId, reviewClaim),
        env.DB.prepare(
          `UPDATE cd_artwork_albums SET hidden_job=NULL WHERE user_id=? AND album_id=? AND active_job=? AND ${claimed}`
        ).bind(userId, job.album_id, id, id, userId, reviewClaim),
        refreshReviewHold(env, userId, job.album_id)
      );
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO cd_artwork_events(user_id,album_id,job_id,action,reviewer,created_at) SELECT ?,?,?,?,?,? WHERE ${claimed}`
      ).bind(
        userId,
        job.album_id,
        id,
        activate ? 'accepted-and-activated' : 'accepted',
        reviewer,
        timestamp,
        id,
        userId,
        reviewClaim
      )
    );
    await env.DB.batch(statements);
  }
  const result = await getJob(env, id, userId);
  if (decision === 'accepted' && result?.review_claim !== reviewClaim)
    throw new ArtworkError(
      activate ? 'activation_conflict' : 'review_conflict',
      409
    );
  if (result?.state !== decision)
    throw new ArtworkError('review_conflict', 409);
  if (activate) {
    const active = await env.DB.prepare(
      'SELECT active_job FROM cd_artwork_albums WHERE user_id=? AND album_id=?'
    )
      .bind(userId, job.album_id)
      .first<{ active_job: string | null }>();
    if (active?.active_job !== id)
      throw new ArtworkError('activation_conflict', 409);
    await syncAcceptedArtworkStatus(env, job.album_id, userId);
  }
  return result;
}
export async function importCandidate(
  env: ArtworkEnv,
  job: Job,
  bytes: Uint8Array,
  provenance: Record<string, unknown>
) {
  if (
    !['queued', 'needs_material_review', 'needs_registration'].includes(
      job.state
    )
  )
    throw new ArtworkError('import_state_conflict', 409);
  if (!validateCandidate(bytes).pass)
    throw new ArtworkError('candidate_geometry_invalid');
  const h = await sha256(bytes),
    key = `candidates/${job.user_id}/${h}.png`;
  await env.ARTWORK.put(key, bytes, {
    httpMetadata: { contentType: 'image/png' },
    onlyIf: { etagDoesNotMatch: '*' },
  });
  const changed = await env.DB.prepare(
    "UPDATE cd_artwork_jobs SET state='pending',candidate_hash=?,candidate_key=?,provenance=?,updated_at=? WHERE id=? AND user_id=? AND state IN ('queued','needs_material_review','needs_registration') AND candidate_hash IS NULL"
  )
    .bind(
      h,
      key,
      JSON.stringify({
        ...JSON.parse(job.provenance),
        imported: true,
        metadata: artworkMetadata(bytes),
        importEvidence: provenance,
      }),
      now(),
      job.id,
      job.user_id
    )
    .run();
  if (changed.meta.changes !== 1)
    throw new ArtworkError('import_state_conflict', 409);
  return getJob(env, job.id, job.user_id);
}
