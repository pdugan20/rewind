import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { lastfmAlbums, lastfmArtists } from '../../db/schema/lastfm.js';
import { confirmCatalogAlbum } from './catalog-album.js';
import { releaseTitleMatches } from './match.js';
import { resolveCatalogAlbum } from './resolve-album.js';

/** Existing owner bindings beat search ranking only with fresh song evidence.
 * This preserves a confirmed edition across spelling/recording-credit aliases.
 */
export async function resolveOwnedCatalogAlbum(
  db: Database,
  token: string,
  userId: number,
  albumId: number,
  played: { album: string; track: string; artist: string }
) {
  const [source] = await db
    .select()
    .from(lastfmAlbums)
    .where(and(eq(lastfmAlbums.userId, userId), eq(lastfmAlbums.id, albumId)));
  if (!source) return { status: 'no_match' as const };
  const rows = await db
    .select({ album: lastfmAlbums })
    .from(lastfmAlbums)
    .innerJoin(
      lastfmArtists,
      and(
        eq(lastfmArtists.id, lastfmAlbums.artistId),
        eq(lastfmArtists.userId, lastfmAlbums.userId)
      )
    )
    .where(
      and(
        eq(lastfmAlbums.userId, userId),
        eq(lastfmAlbums.isFiltered, 0),
        eq(lastfmAlbums.identityConflict, 0),
        eq(lastfmArtists.isFiltered, 0),
        eq(lastfmArtists.identityConflict, 0),
        sql`${lastfmAlbums.appleMusicId} IS NOT NULL`
      )
    );
  const candidates = rows
    .filter(
      (r) =>
        releaseTitleMatches(played.album, r.album.name, played.artist) &&
        (!source.mbid || !r.album.mbid || source.mbid === r.album.mbid)
    )
    .sort(
      (a, b) =>
        Number(b.album.id === source.id) - Number(a.album.id === source.id) ||
        a.album.id - b.album.id
    );
  for (const id of [
    ...new Set(candidates.map((r) => r.album.appleMusicId!)),
  ].slice(0, 3)) {
    const found = await confirmCatalogAlbum(token, id, played);
    if (found.status !== 'no_match') return found;
  }
  return resolveCatalogAlbum(token, played);
}
