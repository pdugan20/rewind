import type { Database } from '../../db/client.js';
import type { Env } from '../../types/env.js';
import { syncAlbumTracklists } from '../apple-music/tracklist.js';
import { enrichBatch } from '../itunes/enrich.js';
import { publishDiscmanSnapshot, selectRecentAlbums } from './snapshot.js';

// iTunes Search allows roughly 20 requests a minute; leave headroom for the
// daily 200-track batch and on-demand lookups.
const NEW_TRACK_ENRICH_LIMIT = 15;

/**
 * Runs after each scrobble sync. Each step is independent: a provider outage
 * still publishes a shelf from whatever is already stored.
 */
export async function refreshDiscman(
  db: Database,
  env: Pick<Env, 'APPLE_MUSIC_DEVELOPER_TOKEN'>,
  userId = 1
): Promise<void> {
  // Newest unenriched tracks first, so a just-played song gets its preview
  // and its album's Apple Music id within one sync instead of the next day.
  try {
    await enrichBatch(db, NEW_TRACK_ENRICH_LIMIT);
  } catch (err) {
    console.log(
      `[ERROR] Discman track enrichment failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const albums = await selectRecentAlbums(db, userId);
  if (env.APPLE_MUSIC_DEVELOPER_TOKEN) {
    try {
      const result = await syncAlbumTracklists(
        db,
        env.APPLE_MUSIC_DEVELOPER_TOKEN,
        albums.map((album) => album.albumId),
        userId
      );
      if (result.stored || result.skipped)
        console.log(
          `[ENRICH] tracklists ${result.stored}/${result.skipped} (stored/skipped)`
        );
    } catch (err) {
      console.log(
        `[ERROR] Discman tracklist sync failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  await publishDiscmanSnapshot(db, userId, albums);
}
