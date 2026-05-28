import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { lastfmArtists } from '../../db/schema/lastfm.js';

/**
 * MusicBrainz canonical "Various Artists" entity. Last.fm uses the same
 * id. Seeded by migration 0038. The album-attribution-repair project
 * (see docs/projects/album-attribution-repair/) routes real compilation
 * albums at this artist row instead of merging them under whichever
 * artist happened to be scrobbled first.
 */
export const VARIOUS_ARTISTS_MBID = '89ad4ac3-39f7-470e-963a-56509c546377';
export const VARIOUS_ARTISTS_NAME = 'Various Artists';

/**
 * Returns the row id of the canonical Various Artists artist. Resolved
 * by MBID (stable) with a name fallback for tests that don't carry the
 * MBID column. Returns null if the seed migration hasn't been applied
 * yet — callers should treat that as "no compilation grouping available
 * in this environment" and fall back to per-track-artist attribution.
 */
export async function getVariousArtistsId(
  db: Database
): Promise<number | null> {
  const [byMbid] = await db
    .select({ id: lastfmArtists.id })
    .from(lastfmArtists)
    .where(eq(lastfmArtists.mbid, VARIOUS_ARTISTS_MBID))
    .limit(1);
  if (byMbid) return byMbid.id;

  const [byName] = await db
    .select({ id: lastfmArtists.id })
    .from(lastfmArtists)
    .where(eq(lastfmArtists.name, VARIOUS_ARTISTS_NAME))
    .limit(1);
  return byName?.id ?? null;
}
