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

/** Empty successful syncs do not poll the artwork outbox. A failed sync may
 * already have committed a play, so its pending events still need delivery. */
export function afterListeningSync<T extends { itemsSynced: number }>(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  sync: Promise<T>
): Promise<T> {
  return sync.then(
    (result) => {
      if (result.itemsSynced > 0) notifyArtworkDiscovery(env, ctx);
      return result;
    },
    (error) => {
      notifyArtworkDiscovery(env, ctx);
      throw error;
    }
  );
}
