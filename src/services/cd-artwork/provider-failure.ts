import { boundedBytes } from './sources.js';
import type { ArtworkEnv } from './types.js';

export const GENERATION_ATTEMPTS = 3;
export interface ProviderFailure {
  status: number;
  code: string | null;
  type: string | null;
  param: string | null;
  request_id: string | null;
  attempt: number;
  retry_at: string | null;
}

/** Private operator detail; never included in the admin job projection. */
export function providerDiagnosticMessage(
  value: unknown,
  secret: string,
  prompt: string
): string | null {
  if (typeof value !== 'string') return null;
  let message = value;
  for (const privateValue of [secret, prompt])
    if (privateValue) message = message.split(privateValue).join('[redacted]');
  return message
    .replace(/(?:sk-|rw_)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/[^\s"']+/gi, '[url]')
    .slice(0, 500);
}

/** Retain diagnostic symbols, never echoed prompts, images, messages or keys. */
export async function readProviderFailure(
  response: Response,
  attempt: number,
  stamp = Date.now(),
  privateInputs = { secret: '', prompt: '' }
): Promise<ProviderFailure & { private_message: string | null }> {
  let error: Record<string, unknown> = {};
  try {
    const body = JSON.parse(
      new TextDecoder().decode(await boundedBytes(response, 16 * 1024))
    );
    if (body?.error && typeof body.error === 'object') error = body.error;
  } catch {
    // Malformed/oversized error bodies must not change the known HTTP outcome.
  }
  const symbol = (value: unknown, pattern: RegExp) =>
    typeof value === 'string' && pattern.test(value) ? value : null;
  const code = symbol(error.code, /^[a-z_]{1,80}$/);
  const retry = response.headers.get('retry-after');
  const seconds = retry === null ? NaN : Number(retry);
  const retryMs = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000)
    : retry
      ? Math.max(0, Date.parse(retry) - stamp)
      : 0;
  // Only an explicit rate-limit rejection proves a safe transient retry.
  // Quota failures, server errors and transport uncertainty stay held.
  const retryable =
    response.status === 429 &&
    code === 'rate_limit_exceeded' &&
    attempt < GENERATION_ATTEMPTS &&
    (!Number.isFinite(retryMs) || retryMs <= 86400000);
  return {
    status: response.status,
    code,
    type: symbol(error.type, /^[a-z_]{1,80}$/),
    param: symbol(error.param, /^[a-z][a-z0-9_.[\]]{0,79}$/),
    request_id: symbol(
      response.headers.get('x-request-id'),
      /^req_[a-zA-Z0-9_-]{1,100}$/
    ),
    attempt,
    private_message: providerDiagnosticMessage(
      error.message,
      privateInputs.secret,
      privateInputs.prompt
    ),
    retry_at: retryable
      ? new Date(
          stamp + Math.max(60000 * 2 ** (attempt - 1), retryMs || 0)
        ).toISOString()
      : null,
  };
}

/** Project the latest generation's real state without changing active artwork. */
export async function syncAcceptedArtworkStatus(
  env: ArtworkEnv,
  albumId: number,
  userId: number
): Promise<boolean> {
  const active = await env.DB.prepare(
    "SELECT j.id FROM cd_artwork_albums c JOIN cd_artwork_jobs j ON j.id=c.active_job AND j.user_id=c.user_id AND j.album_id=c.album_id WHERE c.user_id=? AND c.album_id=? AND j.state='accepted' AND j.candidate_hash IS NOT NULL AND c.hidden_job IS NOT c.active_job AND c.review_hold=0"
  )
    .bind(userId, albumId)
    .first<{ id: string }>();
  if (!active) return false;
  const result = await env.DB.prepare(
    `UPDATE cd_artwork_albums SET discovery_outcome='artwork_ready',discovery_evidence=json_set(json_remove(discovery_evidence,'$.generation_error_code'),'$.generation_job_id',?),
    next_check=CASE WHEN pinned=0 AND EXISTS(SELECT 1 FROM cd_artwork_jobs failed WHERE failed.user_id=cd_artwork_albums.user_id AND failed.album_id=cd_artwork_albums.album_id AND failed.automatic=1 AND failed.expected_active_job=cd_artwork_albums.active_job AND failed.state IN ('provider_failed','provider_unknown') AND NOT EXISTS(SELECT 1 FROM cd_artwork_jobs newer WHERE newer.user_id=failed.user_id AND newer.album_id=failed.album_id AND newer.automatic=1 AND newer.rowid>failed.rowid)) THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') ELSE next_check END
    WHERE user_id=? AND album_id=? AND active_job=? AND hidden_job IS NOT active_job AND review_hold=0 AND EXISTS(SELECT 1 FROM cd_artwork_jobs j WHERE j.id=active_job AND j.user_id=cd_artwork_albums.user_id AND j.album_id=cd_artwork_albums.album_id AND j.state='accepted' AND j.candidate_hash IS NOT NULL)`
  )
    .bind(active.id, userId, albumId, active.id)
    .run();
  return result.meta.changes === 1;
}

export async function syncGenerationStatus(
  env: ArtworkEnv,
  id: string,
  userId: number
) {
  const job = await env.DB.prepare(
    'SELECT album_id FROM cd_artwork_jobs WHERE id=? AND user_id=?'
  )
    .bind(id, userId)
    .first<{ album_id: number }>();
  if (!job || (await syncAcceptedArtworkStatus(env, job.album_id, userId)))
    return;
  await env.DB.prepare(
    `UPDATE cd_artwork_albums AS c SET
    discovery_outcome=CASE j.state
      WHEN 'provider_failed' THEN 'generation_failed'
      WHEN 'provider_unknown' THEN 'generation_unknown'
      WHEN 'queued' THEN CASE WHEN json_extract(j.provenance,'$.providerFailure.retry_at') IS NOT NULL THEN 'generation_retry_pending' ELSE 'generation_queued' END
      WHEN 'submitted' THEN 'generation_pending'
      WHEN 'pending' THEN 'generation_pending'
      WHEN 'needs_registration' THEN 'generation_needs_review'
      WHEN 'accepted' THEN 'artwork_ready'
      ELSE c.discovery_outcome END,
    discovery_evidence=json_set(c.discovery_evidence,'$.generation_job_id',j.id,'$.generation_error_code',j.error_code),
    next_check=CASE WHEN j.state IN ('provider_failed','provider_unknown')
      THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour')
      ELSE c.next_check END
    FROM cd_artwork_jobs j WHERE j.id=? AND j.user_id=? AND j.automatic=1
      AND c.user_id=j.user_id AND c.album_id=j.album_id
      AND (c.active_job IS j.expected_active_job OR c.active_job=j.id)
      AND c.pinned=0 AND c.review_hold=0
      AND NOT EXISTS (SELECT 1 FROM cd_artwork_jobs n WHERE n.user_id=j.user_id AND n.album_id=j.album_id AND n.automatic=1 AND n.rowid>j.rowid)`
  )
    .bind(id, userId)
    .run();
}

/** Repair only status on already-admitted failures; never enqueue or pay. */
export async function reconcileGenerationStatuses(env: ArtworkEnv) {
  const accepted = await env.DB.prepare(
    "SELECT c.album_id,c.user_id FROM cd_artwork_albums c JOIN cd_artwork_jobs j ON j.id=c.active_job AND j.user_id=c.user_id AND j.album_id=c.album_id WHERE j.state='accepted' AND j.candidate_hash IS NOT NULL AND c.hidden_job IS NOT c.active_job AND c.review_hold=0 AND c.discovery_outcome IS NOT 'artwork_ready' ORDER BY j.updated_at DESC LIMIT 20"
  ).all<{ album_id: number; user_id: number }>();
  for (const row of accepted.results)
    await syncAcceptedArtworkStatus(env, row.album_id, row.user_id);
  const rows = await env.DB.prepare(
    `SELECT j.id,j.user_id FROM cd_artwork_jobs j
    JOIN cd_artwork_albums c ON c.album_id=j.album_id AND c.user_id=j.user_id
    WHERE j.automatic=1 AND j.state IN ('provider_failed','provider_unknown')
      AND c.discovery_outcome IN ('generation_queued','generation_pending','generation_retry_pending')
      AND c.pinned=0 AND c.review_hold=0
      AND (c.active_job IS j.expected_active_job OR c.active_job=j.id)
      AND NOT EXISTS (SELECT 1 FROM cd_artwork_jobs n WHERE n.user_id=j.user_id AND n.album_id=j.album_id AND n.automatic=1 AND n.rowid>j.rowid)
    ORDER BY j.created_at DESC LIMIT 20`
  ).all<{ id: string; user_id: number }>();
  for (const row of rows.results)
    await syncGenerationStatus(env, row.id, row.user_id);
}
