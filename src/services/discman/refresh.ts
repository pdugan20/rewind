import type { Database } from '../../db/client.js';
import type { Env } from '../../types/env.js';
import { syncAlbumTracklists } from '../apple-music/tracklist.js';
import { enrichBatch } from '../itunes/enrich.js';
import { enrichNewAlbums } from '../itunes/album-enrich.js';
import { linkShelfAlbums } from './catalog-links.js';
import { publishDiscmanSnapshot, selectRecentAlbums } from './snapshot.js';

// iTunes Search allows roughly 20 requests a minute; leave headroom for the
// daily 200-track batch and on-demand lookups.
const NEW_TRACK_ENRICH_LIMIT = 15;
// New albums with plays, checked against the catalog per sync (one iTunes
// search each); together with tracks this stays under the soft rate limit.
const NEW_ALBUM_CHECK_LIMIT = 5;

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
  // Files various-artists plays under one album before the shelf is chosen.
  try {
    const albums = await enrichNewAlbums(
      db,
      NEW_ALBUM_CHECK_LIMIT,
      userId,
      env.APPLE_MUSIC_DEVELOPER_TOKEN
    );
    if (albums.checked)
      console.log(
        `[ENRICH] albums checked ${albums.checked} (filed ${albums.filed}, linked ${albums.linked})`
      );
  } catch (err) {
    console.log(
      `[ERROR] Album check failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const albums = await selectRecentAlbums(db, userId);
  if (env.APPLE_MUSIC_DEVELOPER_TOKEN) {
    const albumIds = albums.map((album) => album.albumId);
    // Unlinked shelf albums get a catalog id first, so their tracklists are
    // fetched below in the same refresh.
    try {
      const links = await linkShelfAlbums(
        db,
        env.APPLE_MUSIC_DEVELOPER_TOKEN,
        albumIds,
        userId
      );
      if (links.checked)
        console.log(
          `[ENRICH] shelf albums linked ${links.linked}/${links.checked}`
        );
    } catch (err) {
      console.log(
        `[ERROR] Shelf album linking failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    try {
      const result = await syncAlbumTracklists(
        db,
        env.APPLE_MUSIC_DEVELOPER_TOKEN,
        albumIds,
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
