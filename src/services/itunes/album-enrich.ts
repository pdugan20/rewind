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
 * - when the catalog verifies a different album credit, file the recorded
 *   plays under that album artist through a guarded, audited mapping;
 * - when iTunes confirms the album under its own artist, store the catalog id;
 * - otherwise record that the album was checked.
 *
 * Recording artists remain intact. Cross-credit albums require played-track
 * proof; see docs/projects/album-attribution-repair for the filing contract.
 */

import { and, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  lastfmAlbumTracks,
  lastfmAlbums,
  lastfmArtists,
  lastfmScrobbles,
  lastfmTracks,
} from '../../db/schema/lastfm.js';
import {
  albumMatches,
  artistIdentityMatches,
} from '../images/sources/utils.js';
import { fileUnderCatalogArtist } from '../apple-music/album-attribution.js';
import { releaseTitleMatches } from '../apple-music/match.js';
import { VARIOUS_ARTISTS_NAME } from '../lastfm/constants.js';
import { resolveOwnedCatalogAlbum } from '../apple-music/resolve-owned-album.js';
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
  | 'file_under_album_artist'
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
  pinned: number;
  albumConflict: number;
  artistConflict: number;
  artistFiltered: number | null;
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
  pinned: lastfmAlbums.appleMusicPinned,
  albumConflict: lastfmAlbums.identityConflict,
  artistConflict: lastfmArtists.identityConflict,
  artistFiltered: lastfmArtists.isFiltered,
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
 * catalog is searched from the played song (resolve-album.ts); without
 * one, iTunes song search (rate-limited on shared egress) is the fallback.
 */
async function findPlayedRelease(
  played: { artist: string; track: string },
  albumName: string,
  token: string | undefined,
  db: Database,
  userId: number,
  albumId: number
): Promise<SearchResult> {
  if (token) {
    const catalog = await resolveOwnedCatalogAlbum(db, token, userId, albumId, {
      album: albumName,
      track: played.track,
      artist: played.artist,
    });
    if (catalog.status !== 'found') return catalog;
    return {
      status: 'found',
      result: {
        collectionId: catalog.album.id,
        collectionName: catalog.album.name,
        collectionArtistName: catalog.album.artistName,
        collectionViewUrl: catalog.album.url,
        catalogTrackArtistVerified: catalog.trackArtistVerified,
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
  if (
    album.isFiltered ||
    album.artistFiltered ||
    album.albumConflict ||
    album.artistConflict
  )
    return {
      item: {
        ...base,
        played_track: null,
        match: null,
        action: 'no_album_match',
        detail: 'Protected identity or exclusion',
      },
      variousArtistsId,
    };
  // A pinned catalog id was set by hand; leave the album as it is.
  if (album.pinned === 1)
    return {
      item: {
        ...base,
        played_track: null,
        match: null,
        action: 'already_linked',
      },
      variousArtistsId,
    };
  let [played] = await db
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
  if (!played) {
    [played] = await db
      .select({ track: lastfmTracks.name, artist: lastfmArtists.name })
      .from(lastfmTracks)
      .innerJoin(
        lastfmArtists,
        and(
          eq(lastfmArtists.id, lastfmTracks.artistId),
          eq(lastfmArtists.userId, lastfmTracks.userId)
        )
      )
      .innerJoin(
        lastfmScrobbles,
        and(
          eq(lastfmScrobbles.trackId, lastfmTracks.id),
          eq(lastfmScrobbles.userId, lastfmTracks.userId)
        )
      )
      .where(
        and(
          eq(lastfmTracks.userId, album.userId),
          eq(lastfmTracks.albumId, album.id),
          eq(lastfmScrobbles.albumRecorded, 0)
        )
      )
      .orderBy(desc(lastfmScrobbles.scrobbledAt))
      .limit(1);
  }
  if (!played)
    return {
      item: { ...base, played_track: null, match: null, action: 'no_plays' },
      variousArtistsId,
    };

  let search: SearchResult;
  try {
    search = await findPlayedRelease(
      played,
      album.name,
      token,
      db,
      album.userId,
      album.id
    );
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
    !!result.collectionName &&
    releaseTitleMatches(album.name, result.collectionName, album.artistName);
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
    result.collectionId &&
    result.collectionName &&
    result.collectionArtistName &&
    result.collectionViewUrl
  ) {
    const attribution = await fileUnderCatalogArtist(
      db,
      album.userId,
      album.id,
      {
        id: result.collectionId,
        name: result.collectionName,
        artistName: result.collectionArtistName,
        url: result.collectionViewUrl,
      },
      !!result.catalogTrackArtistVerified,
      true
    );
    if (attribution?.changed) {
      item.action = 'file_under_album_artist';
      item.target_album_id = attribution.albumId;
    } else if (
      attribution &&
      artistIdentityMatches(album.artistName, result.collectionArtistName)
    ) {
      item.action =
        album.appleMusicId === result.collectionId
          ? 'already_linked'
          : 'link_album';
    }
  } else if (
    playedThisAlbum &&
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
  const { item, result } = plan;
  switch (item.action) {
    case 'file_under_various_artists':
    case 'file_under_album_artist': {
      if (
        !result?.collectionId ||
        !result.collectionName ||
        !result.collectionArtistName ||
        !result.collectionViewUrl
      )
        return false;
      const filed = await fileUnderCatalogArtist(
        db,
        album.userId,
        album.id,
        {
          id: result.collectionId,
          name: result.collectionName,
          artistName: result.collectionArtistName,
          url: result.collectionViewUrl,
        },
        !!result.catalogTrackArtistVerified,
        false,
        item.action === 'file_under_various_artists'
          ? 'FILE_UNDER_VARIOUS_ARTISTS'
          : 'FILE_UNDER_ALBUM_ARTIST'
      );
      if (!filed?.changed || !filed.albumId) return false;
      await stamp;
      await enrollForDiscArt(db, album.userId, filed.albumId);
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
          catalogLinkCheckedAt: now,
          tracklistSyncedAt: null,
        })
        .where(
          and(
            eq(lastfmAlbums.id, album.id),
            eq(lastfmAlbums.userId, album.userId),
            eq(lastfmAlbums.identityConflict, 0),
            eq(lastfmAlbums.appleMusicPinned, 0),
            eq(lastfmAlbums.isFiltered, 0),
            sql`${lastfmAlbums.appleMusicId} IS ${album.appleMusicId}`
          )
        )
        .returning({ id: lastfmAlbums.id });
      if (linked.length && album.appleMusicId !== result.collectionId)
        await db
          .delete(lastfmAlbumTracks)
          .where(
            and(
              eq(lastfmAlbumTracks.userId, album.userId),
              eq(lastfmAlbumTracks.albumId, album.id),
              sql`EXISTS(SELECT 1 FROM lastfm_albums a WHERE a.id=${album.id} AND a.user_id=${album.userId} AND a.apple_music_id=${result.collectionId} AND a.tracklist_synced_at IS NULL)`
            )
          );
      if (linked.length) await enrollForDiscArt(db, album.userId, album.id);
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
 * Disc-art discovery enrolls an album and queues its check when one of its
 * songs is played (the listen trigger, migration 0051). Moved plays count as
 * plays of the compilation, so do both here; otherwise the compilation would
 * wait for another play. The same conditions apply: automatic processing on,
 * not pinned or held for review, not checked recently, and no accepted retail
 * art. Its next play would do this too, so a failure is only logged.
 */
export async function enrollForDiscArt(
  db: Database,
  userId: number,
  albumId: number
) {
  // A play the listen trigger would act on: recorded on this album, of an
  // unfiltered track, since enrollment began.
  const eligiblePlay = sql`SELECT 1 FROM lastfm_scrobbles s
      JOIN lastfm_tracks t ON t.id=s.track_id AND t.user_id=s.user_id
      WHERE s.album_id=${albumId} AND s.user_id=${userId} AND s.album_recorded=1
        AND t.is_filtered=0
        AND s.scrobbled_at >= (SELECT enroll_since FROM cd_artwork_control WHERE id=1)`;
  try {
    await db.run(sql`INSERT OR IGNORE INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check,discovery_outcome,discovery_evidence)
      SELECT a.user_id,a.id,'',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'identity_required','{}'
      FROM lastfm_albums a JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id
      WHERE a.id=${albumId} AND a.user_id=${userId}
        AND a.is_filtered=0 AND r.is_filtered=0
        AND (SELECT enabled FROM cd_artwork_control WHERE id=1)=1
        AND EXISTS (${eligiblePlay})`);
    await db.run(sql`INSERT OR IGNORE INTO cd_artwork_checks(user_id,album_id,release_id,medium_position)
      SELECT c.user_id,c.album_id,c.release_id,c.medium_position
      FROM cd_artwork_albums c
      JOIN lastfm_albums a ON a.id=c.album_id AND a.user_id=c.user_id
      JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id
      LEFT JOIN cd_artwork_jobs j ON j.id=c.active_job AND j.user_id=c.user_id AND j.album_id=c.album_id
      WHERE c.user_id=${userId} AND c.album_id=${albumId}
        AND a.is_filtered=0 AND a.identity_conflict=0 AND r.is_filtered=0 AND r.identity_conflict=0
        AND c.pinned=0 AND c.review_hold=0
        AND (SELECT enabled FROM cd_artwork_control WHERE id=1)=1
        AND (c.release_id<>'' OR (c.user_id=1 AND (SELECT automatic_enabled FROM cd_artwork_control WHERE id=1)=1))
        AND (c.last_checked_at IS NULL OR c.next_check<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        AND NOT (COALESCE(j.state,'')='accepted' AND COALESCE(json_extract(j.input,'$.source_kind'),'')='retail')
        AND EXISTS (${eligiblePlay})`);
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
        eq(lastfmAlbums.appleMusicPinned, 0),
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
      if (
        changed &&
        ['file_under_various_artists', 'file_under_album_artist'].includes(
          plan.item.action
        )
      )
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
