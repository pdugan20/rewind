import type { Env } from '../types/env.js';

/** Dispatch only; provider calls run durably in the artwork Worker. */
export function notifyArtworkDiscovery(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void }
) {
  if (!env.CD_ARTWORK) return;
  ctx.waitUntil(
    env.CD_ARTWORK.dispatchPending().catch(() => {
      console.log('[ERROR] CD artwork discovery notification unavailable');
    })
  );
}
