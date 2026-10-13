import type { ArtworkEnv, Job } from './types.js';
import { dispatch } from './store.js';
import { recoverListeningChecks } from './discovery.js';
import { recoverOutdatedArtwork } from './reprocessing.js';

/** Recovery only: admitted work and established artwork from older policies.
 * No listening-library enrollment or unsolicited historical backfill. */
export async function scheduledArtwork(env: ArtworkEnv) {
  if (
    !(
      await env.DB.prepare(
        'SELECT enabled FROM cd_artwork_control WHERE id=1'
      ).first<{ enabled: number }>()
    )?.enabled
  )
    return;
  const queued = await env.DB.prepare(
    "SELECT * FROM cd_artwork_jobs WHERE (state='queued' AND (automatic=0 OR (SELECT automatic_enabled FROM cd_artwork_control WHERE id=1)=1)) OR (automatic=1 AND (SELECT automatic_enabled FROM cd_artwork_control WHERE id=1)=1 AND state IN ('submitted','provider_unknown','needs_registration','pending') AND (validation_state='passed' OR (validation_state='claimed' AND validation_lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND validation_attempts<2))) ORDER BY created_at LIMIT 2"
  ).all<Job>();
  for (const job of queued.results) {
    try {
      await dispatch(env, job, true);
    } catch {
      console.log('[ERROR] CD artwork dispatch unavailable');
    }
  }
  await recoverOutdatedArtwork(env);
  await recoverListeningChecks(env);
}
