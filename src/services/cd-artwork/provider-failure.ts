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

/** Retain diagnostic symbols, never echoed prompts, images, messages or keys. */
export async function readProviderFailure(
  response: Response,
  attempt: number,
  stamp = Date.now()
): Promise<ProviderFailure> {
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
    retry_at: retryable
      ? new Date(
          stamp + Math.max(60000 * 2 ** (attempt - 1), retryMs || 0)
        ).toISOString()
      : null,
  };
}

/** Project the latest generation's real state without changing active artwork. */
export async function syncGenerationStatus(
  env: ArtworkEnv,
  id: string,
  userId: number
) {
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
