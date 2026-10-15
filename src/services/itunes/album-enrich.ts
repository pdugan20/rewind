/**
 * Album-level Apple Music matching.
 *
 * Last.fm reports only the track artist, so a play from a various-artists
 * record is filed under a per-artist album ("Reservoir Dogs" by Harry Nilsson,
 * by Stealers Wheel, …). Track enrichment cannot fix that: a song such as
 * "Coconut" already exists under the artist's own album, and only the play
 * records point at the soundtrack. So this works on albums: for an album with
 * recorded plays, search one played song on iTunes, preferring the played
 * album, and then
 *
 * - when iTunes credits that album to Various Artists, move every play
 *   recorded on it (and tracks first seen there) to the album credited to the
 *   canonical Various Artists row;
 * - when iTunes confirms the album under its own artist, store the catalog id;
 * - otherwise record that the album was checked.
 *
 * Only the Various Artists row may hold other artists' tracks; albums credited
 * to another artist keep the track artist (docs/projects/album-attribution-repair).
 */

import { and, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  lastfmAlbumAttributionAudit,
  lastfmAlbums,
  lastfmArtists,
  lastfmScrobbles,
  lastfmTracks,
} from '../../db/schema/lastfm.js';
import { albumMatches } from '../images/sources/utils.js';
import { VARIOUS_ARTISTS_NAME } from '../lastfm/constants.js';
import { findCatalogAlbum } from '../apple-music/catalog-album.js';
import {
  searchItunes,
  variousArtistsFor,
  type ITunesSongResult,
  type SearchResult,
} from './enrich.js';

/**
 * Albums created from this time on are checked automatically. Earlier albums
 * change only through the reviewed admin action.
 */
export const ALBUM_CHECKS_SINCE = '2026-10-15T00:00:00.000Z';
/** The admin action accepts at most this many albums per request. */
export const ALBUM_REVIEW_LIMIT = 20;
/** Audit action recorded when a per-artist album is filed under Various Artists. */
export const FILED_UNDER_VARIOUS_ARTISTS = 'FILE_UNDER_VARIOUS_ARTISTS';

export type AlbumAction =
  | 'file_under_various_artists'
  | 'link_album'
  | 'already_linked'
  | 'no_album_match'
  | 'no_match'
  | 'no_plays'
  | 'rate_limited'
  | 'error';

export interface AlbumReviewItem {
  album_id: number;
  album: string;
  artist: string;
  /** The played song that was searched. */
  played_track: string | null;
  match: {
    album: string | null;
    album_artist: string | null;
    catalog_id: number | null;
  } | null;
  action: AlbumAction;
  /** The existing Various Artists album, or null when it would be created. */
  target_album_id?: number | null;
  plays_moved?: number;
  tracks_moved?: number;
  /** Why a search failed. */
  detail?: string;
  /** Live runs only: whether the change was written. */
  applied?: boolean;
}

interface AlbumRow {
  id: number;
  userId: number;
  name: string;
  artistId: number;
  artistName: string;
  isFiltered: number | null;
  appleMusicId: number | null;
}

interface AlbumPlan {
  item: AlbumReviewItem;
  result?: ITunesSongResult;
  variousArtistsId: number | null;
}

const albumColumns = {
  id: lastfmAlbums.id,
  userId: lastfmAlbums.userId,
  name: lastfmAlbums.name,
  artistId: lastfmAlbums.artistId,
  artistName: lastfmArtists.name,
  isFiltered: lastfmAlbums.isFiltered,
  appleMusicId: lastfmAlbums.appleMusicId,
};

const recordedOn = (userId: number, albumId: number) =>
  and(
    eq(lastfmScrobbles.userId, userId),
    eq(lastfmScrobbles.albumId, albumId),
    eq(lastfmScrobbles.albumRecorded, 1)
  );

/** Decides what to do with one album. Reads only. */
/**
 * The release a played song came from. With a developer token the Apple Music
 * catalog is searched by album name and confirmed by its tracklist; without
 * one, iTunes song search (rate-limited on shared egress) is the fallback.
 */
async function findPlayedRelease(
  played: { artist: string; track: string },
  albumName: string,
  token: string | undefined
): Promise<SearchResult> {
  if (token) {
    const catalog = await findCatalogAlbum(token, albumName, played);
    if (catalog.status !== 'found') return catalog;
    return {
      status: 'found',
      result: {
        collectionId: catalog.album.id,
        collectionName: catalog.album.name,
        collectionArtistName: catalog.album.artistName,
        collectionViewUrl: catalog.album.url,
      },
    };
  }
  // The album in the term surfaces soundtrack releases of songs whose own
  // albums fill a plain search; fall back when it finds nothing.
  const withAlbum = await searchItunes(
    played.artist,
    played.track,
    albumName,
    true
  );
  return withAlbum.status === 'no_match'
    ? searchItunes(played.artist, played.track, albumName)
    : withAlbum;
}

async function planAlbum(
  db: Database,
  album: AlbumRow,
  token: string | undefined
): Promise<AlbumPlan> {
  const base = {
    album_id: album.id,
    album: album.name,
    artist: album.artistName,
  };
  const variousArtistsId = await variousArtistsFor(db, album.userId);
  const [played] = await db
    .select({ track: lastfmTracks.name, artist: lastfmArtists.name })
    .from(lastfmScrobbles)
    .innerJoin(
      lastfmTracks,
      and(
        eq(lastfmTracks.id, lastfmScrobbles.trackId),
        eq(lastfmTracks.userId, lastfmScrobbles.userId)
      )
    )
    .innerJoin(
      lastfmArtists,
      and(
        eq(lastfmArtists.id, lastfmTracks.artistId),
        eq(lastfmArtists.userId, lastfmTracks.userId)
      )
    )
    .where(recordedOn(album.userId, album.id))
    .orderBy(desc(lastfmScrobbles.scrobbledAt))
    .limit(1);
  if (!played)
    return {
      item: { ...base, played_track: null, match: null, action: 'no_plays' },
      variousArtistsId,
    };

  let search: SearchResult;
  try {
    search = await findPlayedRelease(played, album.name, token);
  } catch (error) {
    search = {
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (search.status !== 'found')
    return {
      item: {
        ...base,
        played_track: played.track,
        match: null,
        action: search.status,
        ...(search.status === 'error' && search.detail
          ? { detail: search.detail }
          : {}),
      },
      variousArtistsId,
    };

  const { result } = search;
  const item: AlbumReviewItem = {
    ...base,
    played_track: played.track,
    match: {
      album: result.collectionName ?? null,
      album_artist: result.collectionArtistName ?? null,
      catalog_id: result.collectionId ?? null,
    },
    action: 'no_album_match',
  };
  const playedThisAlbum =
    !!result.collectionName && albumMatches(album.name, result.collectionName);
  if (
    playedThisAlbum &&
    variousArtistsId !== null &&
    album.artistId !== variousArtistsId &&
    result.collectionArtistName?.trim().toLowerCase() ===
      VARIOUS_ARTISTS_NAME.toLowerCase()
  ) {
    const [existing] = await db
      .select({ id: lastfmAlbums.id })
      .from(lastfmAlbums)
      .where(
        and(
          eq(lastfmAlbums.userId, album.userId),
          eq(lastfmAlbums.name, album.name),
          eq(lastfmAlbums.artistId, variousArtistsId)
        )
      )
      .limit(1);
    const [plays] = await db
      .select({ n: sql<number>`count(*)` })
      .from(lastfmScrobbles)
      .where(recordedOn(album.userId, album.id));
    const [tracks] = await db
      .select({ n: sql<number>`count(*)` })
      .from(lastfmTracks)
      .where(
        and(
          eq(lastfmTracks.userId, album.userId),
          eq(lastfmTracks.albumId, album.id)
        )
      );
    item.action = 'file_under_various_artists';
    item.target_album_id = existing?.id ?? null;
    item.plays_moved = Number(plays?.n ?? 0);
    item.tracks_moved = Number(tracks?.n ?? 0);
  } else if (
    playedThisAlbum &&
    albumMatches(album.name, result.collectionName!, album.artistName) &&
    !albumMatches(album.artistName, album.name) &&
    result.collectionId &&
    result.collectionViewUrl
  ) {
    item.action = album.appleMusicId === null ? 'link_album' : 'already_linked';
  }
  return { item, result, variousArtistsId };
}

/** Writes a plan. Returns whether anything changed. */
async function applyAlbumPlan(
  db: Database,
  album: AlbumRow,
  plan: AlbumPlan
): Promise<boolean> {
  const now = new Date().toISOString();
  const stamp = db
    .update(lastfmAlbums)
    .set({ itunesEnrichedAt: now })
    .where(
      and(eq(lastfmAlbums.id, album.id), eq(lastfmAlbums.userId, album.userId))
    );
  const { item, result, variousArtistsId } = plan;
  switch (item.action) {
    case 'file_under_various_artists': {
      if (!result || variousArtistsId === null) return false;
      // Album identity is (name, artist); the filter decision depends on the
      // album name, so it carries over from the per-artist album.
      await db
        .insert(lastfmAlbums)
        .values({
          userId: album.userId,
          name: album.name,
          artistId: variousArtistsId,
          isFiltered: album.isFiltered ?? 0,
        })
        .onConflictDoNothing();
      const [compilation] = await db
        .select({ id: lastfmAlbums.id })
        .from(lastfmAlbums)
        .where(
          and(
            eq(lastfmAlbums.userId, album.userId),
            eq(lastfmAlbums.name, album.name),
            eq(lastfmAlbums.artistId, variousArtistsId)
          )
        )
        .limit(1);
      if (!compilation) return false;
      await db.batch([
        // Sync reads this to file later plays of this album the same way.
        db.insert(lastfmAlbumAttributionAudit).values({
          originalAlbumId: album.id,
          originalAlbumName: album.name,
          originalArtistId: album.artistId,
          action: FILED_UNDER_VARIOUS_ARTISTS,
          newAlbumId: compilation.id,
          newArtistId: variousArtistsId,
          tracksMoved: item.tracks_moved ?? 0,
          notes: `iTunes: ${result.collectionName ?? ''} by ${result.collectionArtistName ?? ''} (${result.collectionId ?? 'no id'})`,
        }),
        db
          .update(lastfmScrobbles)
          .set({ albumId: compilation.id })
          .where(recordedOn(album.userId, album.id)),
        db
          .update(lastfmTracks)
          .set({ albumId: compilation.id, updatedAt: now })
          .where(
            and(
              eq(lastfmTracks.userId, album.userId),
              eq(lastfmTracks.albumId, album.id)
            )
          ),
        ...(result.collectionId && result.collectionViewUrl
          ? [
              db
                .update(lastfmAlbums)
                .set({
                  appleMusicId: result.collectionId,
                  appleMusicUrl: result.collectionViewUrl,
                })
                .where(
                  and(
                    eq(lastfmAlbums.id, compilation.id),
                    eq(lastfmAlbums.userId, album.userId),
                    isNull(lastfmAlbums.appleMusicId)
                  )
                ),
            ]
          : []),
        stamp,
      ]);
      await enrollForDiscArt(db, album.userId, compilation.id);
      return true;
    }
    case 'link_album': {
      if (!result?.collectionId || !result.collectionViewUrl) return false;
      const linked = await db
        .update(lastfmAlbums)
        .set({
          appleMusicId: result.collectionId,
          appleMusicUrl: result.collectionViewUrl,
          itunesEnrichedAt: now,
        })
        .where(
          and(
            eq(lastfmAlbums.id, album.id),
            eq(lastfmAlbums.userId, album.userId),
            eq(lastfmAlbums.identityConflict, 0),
            isNull(lastfmAlbums.appleMusicId)
          )
        )
        .returning({ id: lastfmAlbums.id });
      return linked.length > 0;
    }
    case 'already_linked':
    case 'no_album_match':
    case 'no_match':
    case 'no_plays':
      // Checked; nothing to change.
      await stamp;
      return false;
    default:
      // Rate limits and errors stay unchecked for another attempt.
      return false;
  }
}

/**
 * Disc-art discovery enrolls an album when one of its songs is played
 * (migration 0046). Moved plays count as plays of the compilation, so enroll
 * it the same way: an identity hold, never a paid submission. Its next play
 * would enroll it too, so a failure is only logged.
 */
async function enrollForDiscArt(db: Database, userId: number, albumId: number) {
  try {
    await db.run(sql`INSERT OR IGNORE INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check,discovery_outcome,discovery_evidence)
      SELECT a.user_id,a.id,'',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'identity_required','{}'
      FROM lastfm_albums a JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id
      WHERE a.id=${albumId} AND a.user_id=${userId}
        AND a.is_filtered=0 AND r.is_filtered=0
        AND (SELECT enabled FROM cd_artwork_control WHERE id=1)=1
        AND EXISTS (SELECT 1 FROM lastfm_scrobbles s
          WHERE s.album_id=a.id AND s.user_id=a.user_id AND s.album_recorded=1
            AND s.scrobbled_at >= (SELECT enroll_since FROM cd_artwork_control WHERE id=1))`);
  } catch (error) {
    console.log(
      `[ERROR] Disc-art enrollment failed for album ${albumId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function albumsQuery(db: Database) {
  return db
    .select(albumColumns)
    .from(lastfmAlbums)
    .innerJoin(
      lastfmArtists,
      and(
        eq(lastfmArtists.id, lastfmAlbums.artistId),
        eq(lastfmArtists.userId, lastfmAlbums.userId)
      )
    );
}

/**
 * Checks albums created since ALBUM_CHECKS_SINCE that have recorded plays and
 * have not been checked. Runs after each scrobble sync; stops at a rate limit.
 */
export async function enrichNewAlbums(
  db: Database,
  limit: number,
  userId = 1,
  /** Apple Music developer token; iTunes search is used without it. */
  token?: string
): Promise<{ checked: number; filed: number; linked: number }> {
  const variousArtistsId = await variousArtistsFor(db, userId);
  const albums = await albumsQuery(db)
    .where(
      and(
        eq(lastfmAlbums.userId, userId),
        isNull(lastfmAlbums.itunesEnrichedAt),
        eq(lastfmAlbums.identityConflict, 0),
        eq(lastfmAlbums.isFiltered, 0),
        gte(lastfmAlbums.createdAt, ALBUM_CHECKS_SINCE),
        ...(variousArtistsId === null
          ? []
          : [ne(lastfmAlbums.artistId, variousArtistsId)]),
        sql`EXISTS (SELECT 1 FROM lastfm_scrobbles s WHERE s.user_id=${lastfmAlbums.userId} AND s.album_id=${lastfmAlbums.id} AND s.album_recorded=1)`
      )
    )
    .orderBy(desc(lastfmAlbums.createdAt))
    .limit(limit);
  const totals = { checked: 0, filed: 0, linked: 0 };
  for (const album of albums) {
    const plan = await planAlbum(db, album, token);
    if (plan.item.action === 'rate_limited') break;
    try {
      const changed = await applyAlbumPlan(db, album, plan);
      totals.checked++;
      if (changed && plan.item.action === 'file_under_various_artists')
        totals.filed++;
      if (changed && plan.item.action === 'link_album') totals.linked++;
    } catch (error) {
      console.log(
        `[ERROR] Album check failed for album ${album.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return totals;
}

/**
 * Admin review of listed albums, regardless of when they were created or
 * whether they were checked before. The default dry run writes nothing and
 * reports what a live run would do; a live run applies the same plans.
 */
export async function reviewAlbums(
  db: Database,
  userId: number,
  albumIds: number[],
  dryRun: boolean,
  options: {
    /** Apple Music developer token; iTunes search is used without it. */
    token?: string;
    /** Pause between albums when searching iTunes (~20 searches a minute). */
    paceMs?: number;
  } = {}
): Promise<{ dry_run: boolean; items: AlbumReviewItem[] }> {
  const { token } = options;
  const paceMs = options.paceMs ?? (token ? 0 : 3000);
  if (albumIds.length === 0) return { dry_run: dryRun, items: [] };
  const albums = await albumsQuery(db)
    .where(
      and(eq(lastfmAlbums.userId, userId), inArray(lastfmAlbums.id, albumIds))
    )
    .orderBy(lastfmAlbums.id);
  const items: AlbumReviewItem[] = [];
  let rateLimited = false;
  for (const [index, album] of albums.entries()) {
    if (rateLimited) {
      items.push({
        album_id: album.id,
        album: album.name,
        artist: album.artistName,
        played_track: null,
        match: null,
        action: 'rate_limited',
      });
      continue;
    }
    if (index > 0 && paceMs > 0)
      await new Promise((resolve) => setTimeout(resolve, paceMs));
    const plan = await planAlbum(db, album, token);
    rateLimited = plan.item.action === 'rate_limited';
    if (!dryRun) {
      try {
        plan.item.applied = await applyAlbumPlan(db, album, plan);
      } catch (error) {
        console.log(
          `[ERROR] Album review failed for album ${album.id}: ${error instanceof Error ? error.message : String(error)}`
        );
        plan.item.applied = false;
        plan.item.detail =
          error instanceof Error ? error.message : String(error);
      }
    }
    items.push(plan.item);
  }
  return { dry_run: dryRun, items };
}
