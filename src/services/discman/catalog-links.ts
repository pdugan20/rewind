/**
 * Catalog links for shelf and recently played albums.
 *
 * An album with no Apple Music id has no catalog tracklist, so the player can
 * only list the songs played from it, without previews. Track enrichment
 * (iTunes, rate-limited on shared egress) and the album check (new albums with
 * recorded plays) miss some albums, so every shelf refresh links the shelf's
 * unlinked albums through the catalog matcher (resolve-album.ts). An album the
 * matcher cannot place is retried after LINK_RETRY_DAYS; an admin can pin the
 * right id by hand, and automatic matching never replaces a pin.
 */

import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  lastfmAlbumTracks,
  lastfmAlbums,
  lastfmArtists,
  lastfmScrobbles,
  lastfmTracks,
} from '../../db/schema/lastfm.js';
import { scrobbleAlbumId } from '../../lib/scrobble-album.js';
import { catalogGet } from '../apple-music/catalog-album.js';
import { playedSongs } from '../apple-music/played-song.js';
import { resolveCatalogAlbum } from '../apple-music/resolve-album.js';
import { artistIdentityMatches } from '../images/sources/utils.js';
import { variousArtistsFor } from '../itunes/enrich.js';
import { VARIOUS_ARTISTS_NAME } from '../lastfm/constants.js';

const LINK_RETRY_DAYS = 7;
// Recent links serve ordinary album rails too, independently of disc art.
const RECENT_LINK_LIMIT = 5;
const RECENT_LINK_RETRY_DAYS = 1;
const RECENT_PLAY_DAYS = 30;

const eligibleAlbum = (userId: number) =>
  and(
    eq(lastfmAlbums.userId, userId),
    isNull(lastfmAlbums.appleMusicId),
    // A URL-only record already has a selected catalog release. Automatic
    // missing-link repair must not overwrite that metadata or a concurrent edit.
    or(isNull(lastfmAlbums.appleMusicUrl), eq(lastfmAlbums.appleMusicUrl, '')),
    eq(lastfmAlbums.appleMusicPinned, 0),
    eq(lastfmAlbums.identityConflict, 0),
    eq(lastfmAlbums.isFiltered, 0),
    sql`EXISTS (SELECT 1 FROM ${lastfmArtists} a
      WHERE a.id = ${lastfmAlbums.artistId} AND a.user_id = ${lastfmAlbums.userId}
        AND a.identity_conflict = 0 AND a.is_filtered = 0)`
  );

const retryDue = (days: number) =>
  or(
    isNull(lastfmAlbums.catalogLinkCheckedAt),
    lt(
      lastfmAlbums.catalogLinkCheckedAt,
      sql.raw(`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${days} days')`)
    )
  );

/** At most five recent, eligible albums per refresh, newest play first. */
export async function linkRecentAlbums(
  db: Database,
  token: string,
  userId = 1
): Promise<{ checked: number; linked: number }> {
  const albums = await db
    .select({ id: lastfmAlbums.id })
    .from(lastfmScrobbles)
    .innerJoin(
      lastfmTracks,
      and(
        eq(lastfmTracks.id, lastfmScrobbles.trackId),
        eq(lastfmTracks.userId, lastfmScrobbles.userId)
      )
    )
    .innerJoin(
      lastfmAlbums,
      and(
        eq(lastfmAlbums.id, scrobbleAlbumId),
        eq(lastfmAlbums.userId, lastfmScrobbles.userId)
      )
    )
    .innerJoin(
      lastfmArtists,
      and(
        eq(lastfmArtists.id, lastfmTracks.artistId),
        eq(lastfmArtists.userId, lastfmTracks.userId)
      )
    )
    .where(
      and(
        eq(lastfmScrobbles.userId, userId),
        eq(lastfmTracks.isFiltered, 0),
        eq(lastfmArtists.isFiltered, 0),
        eq(lastfmArtists.identityConflict, 0),
        eligibleAlbum(userId),
        retryDue(RECENT_LINK_RETRY_DAYS),
        sql`${lastfmScrobbles.scrobbledAt} >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${sql.raw(String(RECENT_PLAY_DAYS))} days')`
      )
    )
    .groupBy(lastfmAlbums.id)
    .orderBy(
      desc(sql`MAX(${lastfmScrobbles.scrobbledAt})`),
      desc(lastfmAlbums.id)
    )
    .limit(RECENT_LINK_LIMIT);
  return linkAlbums(
    db,
    token,
    albums.map((album) => album.id),
    userId,
    RECENT_LINK_RETRY_DAYS
  );
}
/** Played songs tried per album; a bonus track can be missing from Apple's edition. */
const LINK_SONGS = 3;

/**
 * Link the listed albums that have no catalog id. The matched release must be
 * credited to the album's artist (or to Various Artists for the Various
 * Artists row); a soundtrack found for a per-artist album is left to the
 * album check, which files its plays first. Stops at a rate limit.
 */
export async function linkShelfAlbums(
  db: Database,
  token: string,
  albumIds: number[],
  userId = 1
): Promise<{ checked: number; linked: number }> {
  return linkAlbums(db, token, albumIds, userId, LINK_RETRY_DAYS);
}

async function linkAlbums(
  db: Database,
  token: string,
  albumIds: number[],
  userId: number,
  retryDays: number
): Promise<{ checked: number; linked: number }> {
  const totals = { checked: 0, linked: 0 };
  if (albumIds.length === 0) return totals;
  const albums = await db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      artistId: lastfmAlbums.artistId,
      artistName: lastfmArtists.name,
    })
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
        eligibleAlbum(userId),
        inArray(lastfmAlbums.id, albumIds),
        retryDue(retryDays)
      )
    );
  if (albums.length === 0) return totals;
  const variousArtistsId = await variousArtistsFor(db, userId);

  const order = new Map(albumIds.map((id, index) => [id, index]));
  albums.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  for (const album of albums) {
    const now = new Date().toISOString();
    const unlinked = and(eq(lastfmAlbums.id, album.id), eligibleAlbum(userId));
    let found: Awaited<ReturnType<typeof resolveCatalogAlbum>> = {
      status: 'no_match',
    };
    let credited = false;
    // The latest play may be a song the catalog edition lacks; another
    // played song can still identify the album.
    for (const song of await playedSongs(db, userId, album.id, LINK_SONGS)) {
      found = await resolveCatalogAlbum(token, {
        album: album.name,
        track: song.track,
        artist: song.artist,
      });
      if (found.status === 'rate_limited' || found.status === 'error') break;
      credited =
        found.status === 'found' &&
        (album.artistId === variousArtistsId
          ? found.album.artistName.trim().toLowerCase() ===
            VARIOUS_ARTISTS_NAME.toLowerCase()
          : artistIdentityMatches(album.artistName, found.album.artistName));
      if (credited) break;
    }
    if (found.status === 'rate_limited') break;
    if (found.status === 'error') {
      console.log(
        `[WARN] Catalog link for album ${album.id} failed: ${found.detail}`
      );
      continue;
    }
    totals.checked++;
    if (found.status === 'found' && credited) {
      const linked = await db
        .update(lastfmAlbums)
        .set({
          appleMusicId: found.album.id,
          appleMusicUrl: found.album.url,
          catalogLinkCheckedAt: now,
          // Fetch its tracklist in this refresh.
          tracklistSyncedAt: null,
          // Marks the album checked, so track enrichment keeps this id.
          itunesEnrichedAt: sql`COALESCE(${lastfmAlbums.itunesEnrichedAt}, ${now})`,
          updatedAt: now,
        })
        .where(unlinked)
        .returning({ id: lastfmAlbums.id });
      if (linked.length) {
        totals.linked++;
        console.log(
          `[ENRICH] album ${album.id} linked to catalog ${found.album.id}`
        );
      }
      continue;
    }
    await db
      .update(lastfmAlbums)
      .set({ catalogLinkCheckedAt: now })
      .where(unlinked);
  }
  return totals;
}

interface UnresolvedAlbum {
  album_id: number;
  album: string;
  artist: string;
  apple_music_id: number | null;
  apple_music_pinned: boolean;
  catalog_link_checked_at: string | null;
  tracklist_synced_at: string | null;
}

/** Listed albums without a stored catalog tracklist, in the given order. */
export async function unresolvedAlbums(
  db: Database,
  albumIds: number[],
  userId = 1
): Promise<UnresolvedAlbum[]> {
  if (albumIds.length === 0) return [];
  const rows = await db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      artistName: lastfmArtists.name,
      appleMusicId: lastfmAlbums.appleMusicId,
      pinned: lastfmAlbums.appleMusicPinned,
      linkCheckedAt: lastfmAlbums.catalogLinkCheckedAt,
      tracklistSyncedAt: lastfmAlbums.tracklistSyncedAt,
    })
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
        inArray(lastfmAlbums.id, albumIds),
        sql`NOT EXISTS (SELECT 1 FROM ${lastfmAlbumTracks} t WHERE t.album_id = ${lastfmAlbums.id} AND t.user_id = ${lastfmAlbums.userId})`
      )
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return albumIds.flatMap((id) => {
    const row = byId.get(id);
    return row
      ? [
          {
            album_id: row.id,
            album: row.name,
            artist: row.artistName,
            apple_music_id: row.appleMusicId,
            apple_music_pinned: row.pinned === 1,
            catalog_link_checked_at: row.linkCheckedAt,
            tracklist_synced_at: row.tracklistSyncedAt,
          },
        ]
      : [];
  });
}

type PinResult =
  | {
      status: 'pinned' | 'unpinned';
      album_id: number;
      apple_music_id: number | null;
      apple_music_url: string | null;
      catalog_name?: string;
      catalog_artist?: string;
    }
  | { status: 'album_not_found' | 'catalog_not_found' }
  | { status: 'error'; detail: string };

/**
 * Pin an album's catalog id by hand, or release the pin (appleMusicId null),
 * which keeps the id and lets tracklist sync check it again. A pin is
 * verified against the catalog and queues a fresh tracklist.
 */
export async function pinCatalogAlbum(
  db: Database,
  token: string | undefined,
  userId: number,
  albumId: number,
  appleMusicId: number | null
): Promise<PinResult> {
  const [album] = await db
    .select({
      id: lastfmAlbums.id,
      appleMusicId: lastfmAlbums.appleMusicId,
      appleMusicUrl: lastfmAlbums.appleMusicUrl,
    })
    .from(lastfmAlbums)
    .where(and(eq(lastfmAlbums.id, albumId), eq(lastfmAlbums.userId, userId)))
    .limit(1);
  if (!album) return { status: 'album_not_found' };
  const now = new Date().toISOString();
  const own = and(
    eq(lastfmAlbums.id, albumId),
    eq(lastfmAlbums.userId, userId)
  );
  if (appleMusicId === null) {
    await db
      .update(lastfmAlbums)
      .set({ appleMusicPinned: 0, tracklistSyncedAt: null, updatedAt: now })
      .where(own);
    return {
      status: 'unpinned',
      album_id: albumId,
      apple_music_id: album.appleMusicId,
      apple_music_url: album.appleMusicUrl,
    };
  }
  if (!token) return { status: 'error', detail: 'No Apple Music token' };
  const read = await catalogGet<{
    data?: Array<{
      id?: string;
      type?: string;
      attributes?: { name?: string; artistName?: string; url?: string };
    }>;
  }>(`/albums/${appleMusicId}`, token);
  if (!read.ok)
    return read.status === 404
      ? { status: 'catalog_not_found' }
      : { status: 'error', detail: `Apple Music HTTP ${read.status}` };
  const attrs = read.body.data?.find(
    (item) => item.id === String(appleMusicId) && item.type === 'albums'
  )?.attributes;
  if (!attrs?.url?.startsWith('https://music.apple.com/'))
    return { status: 'catalog_not_found' };
  await db
    .update(lastfmAlbums)
    .set({
      appleMusicId,
      appleMusicUrl: attrs.url,
      appleMusicPinned: 1,
      tracklistSyncedAt: null,
      catalogLinkCheckedAt: now,
      itunesEnrichedAt: sql`COALESCE(${lastfmAlbums.itunesEnrichedAt}, ${now})`,
      updatedAt: now,
    })
    .where(own);
  return {
    status: 'pinned',
    album_id: albumId,
    apple_music_id: appleMusicId,
    apple_music_url: attrs.url,
    catalog_name: attrs.name,
    catalog_artist: attrs.artistName,
  };
}
