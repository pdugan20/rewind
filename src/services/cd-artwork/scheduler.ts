import type { ArtworkEnv, Job } from './types.js';
import { dispatch } from './store.js';
import { recoverListeningChecks } from './discovery.js';

/** Recovery only: no library enrollment, due-album scan or unsolicited check. */
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
    "SELECT * FROM cd_artwork_jobs WHERE state='queued' ORDER BY created_at LIMIT 2"
  ).all<Job>();
  for (const job of queued.results) {
    try {
      await dispatch(env, job);
    } catch {
      console.log('[ERROR] CD artwork dispatch unavailable');
    }
  }
  await recoverListeningChecks(env);
}
