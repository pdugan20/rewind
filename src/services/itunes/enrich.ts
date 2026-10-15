/**
 * iTunes Search API enrichment service.
 * Searches for tracks by artist+name, validates results, and updates
 * artist/album/track records with Apple Music URLs and preview audio.
 *
 * Each batch call processes a small number of tracks sequentially
 * with no internal rate limiting. Rate pacing is handled by the caller
 * (the backfill script controls delay between batch requests).
 */

import { eq, and, isNull, or, lt, sql, desc, inArray, asc } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  lastfmTracks,
  lastfmAlbums,
  lastfmArtists,
  lastfmScrobbles,
} from '../../db/schema/lastfm.js';
import {
  artistIdentityMatches,
  albumMatches,
  trackMatches,
  cleanArtistName,
} from '../images/sources/utils.js';
import {
  VARIOUS_ARTISTS_MBID,
  VARIOUS_ARTISTS_NAME,
} from '../lastfm/constants.js';

const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';

// Retry cadence: artists whose iTunes lookup returned no_match re-enter the
// queue after this interval so catalog additions get picked up. Uses
// `strftime` so the threshold matches the stored `new Date().toISOString()`
// format exactly (YYYY-MM-DDTHH:MM:SS.sssZ) — avoids a ~1-day drift at the
// boundary from SQLite's default datetime() format (space-separated, no Z).
const ITUNES_RETRY_INTERVAL =
  "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')";

interface ITunesSongResult {
  trackId?: number;
  trackName?: string;
  trackViewUrl?: string;
  artistId?: number;
  artistName?: string;
  artistViewUrl?: string;
  collectionId?: number;
  collectionName?: string;
  /** Present when the album artist differs from the track artist. */
  collectionArtistName?: string;
  collectionViewUrl?: string;
  previewUrl?: string;
}

interface ITunesArtistResult {
  wrapperType?: string;
  artistType?: string;
  artistId?: number;
  artistName?: string;
  // `artistLinkUrl` is the canonical field for entity=musicArtist results;
  // older payloads also surface `artistViewUrl`. Accept either.
  artistLinkUrl?: string;
  artistViewUrl?: string;
}

interface ITunesSearchResponse {
  resultCount: number;
  results: ITunesSongResult[];
}

interface ITunesArtistSearchResponse {
  resultCount: number;
  results: ITunesArtistResult[];
}

export interface BatchEnrichResult {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
}

type SearchResult =
  | { status: 'found'; result: ITunesSongResult }
  | { status: 'no_match' }
  | { status: 'rate_limited' }
  | { status: 'error' };

type ArtistSearchResult =
  | { status: 'found'; result: ITunesArtistResult }
  | { status: 'no_match' }
  | { status: 'rate_limited' }
  | { status: 'error' };

/**
 * Search iTunes for a song. Among validated matches, prefer the release on
 * the album that was actually played: the first match is often the artist's
 * own album even when the play came from a soundtrack or compilation.
 */
async function searchItunes(
  artistName: string,
  trackName: string,
  albumName?: string | null
): Promise<SearchResult> {
  const artist = cleanArtistName(artistName);
  const term = `${artist} ${trackName}`;
  const url = new URL(ITUNES_SEARCH_URL);
  url.searchParams.set('term', term);
  url.searchParams.set('entity', 'song');
  url.searchParams.set('media', 'music');
  url.searchParams.set('limit', '5');

  const response = await fetch(url.toString());

  if (response.status === 403) {
    return { status: 'rate_limited' };
  }

  if (!response.ok) {
    return { status: 'error' };
  }

  const data = (await response.json()) as ITunesSearchResponse;

  let first: ITunesSongResult | undefined;
  for (const result of data.results) {
    if (!result.trackViewUrl) continue;

    if (
      !result.artistName ||
      !artistIdentityMatches(artistName, result.artistName) ||
      !result.trackName ||
      !trackMatches(trackName, result.trackName)
    ) {
      continue;
    }

    first ??= result;
    if (
      !albumName ||
      (result.collectionName &&
        albumMatches(albumName, result.collectionName, artistName))
    )
      return { status: 'found', result };
  }

  return first ? { status: 'found', result: first } : { status: 'no_match' };
}

/** The user's canonical "Various Artists" row, by MBID, then by name. */
async function variousArtistsFor(db: Database, userId: number) {
  const [row] = await db
    .select({ id: lastfmArtists.id })
    .from(lastfmArtists)
    .where(
      and(
        eq(lastfmArtists.userId, userId),
        or(
          eq(lastfmArtists.mbid, VARIOUS_ARTISTS_MBID),
          eq(lastfmArtists.name, VARIOUS_ARTISTS_NAME)
        )
      )
    )
    .orderBy(sql`${lastfmArtists.mbid} IS NOT ${VARIOUS_ARTISTS_MBID}`)
    .limit(1);
  return row?.id ?? null;
}

/**
 * Files a track played from a various-artists record under that record's
 * single "Various Artists" album. Last.fm reports only the track artist, so
 * sync creates one album per artist ("Reservoir Dogs" by Harry Nilsson, by
 * Stealers Wheel, …). The iTunes match confirms the played album and its
 * album artist; only then are this track and its scrobbles of that album
 * moved. Other album artists are left alone: album identity stays
 * (name, artist), and only the canonical Various Artists row may hold other
 * artists' tracks (see docs/projects/album-attribution-repair).
 *
 * Runs before the track is marked enriched, and the move is one batch, so a
 * failure leaves the track queued for another attempt.
 */
async function fileUnderCompilation(
  db: Database,
  track: { id: number; userId: number; albumId: number; albumName: string },
  result: ITunesSongResult
): Promise<boolean> {
  const target = await compilationTarget(db, track, result);
  if (!target) return false;
  const { variousArtistsId, isFiltered } = target;

  // Album identity is (name, artist). The filter decision depends on the
  // album name, so it carries over from the per-artist album.
  await db
    .insert(lastfmAlbums)
    .values({
      userId: track.userId,
      name: track.albumName,
      artistId: variousArtistsId,
      isFiltered,
    })
    .onConflictDoNothing();
  return moveToCompilation(db, track, result, variousArtistsId);
}

/**
 * The Various Artists row this track's album should move to, when the match
 * shows it was played from a various-artists record. Reads only.
 */
async function compilationTarget(
  db: Database,
  track: { userId: number; albumId: number; albumName: string },
  result: ITunesSongResult
): Promise<{ variousArtistsId: number; isFiltered: number } | null> {
  if (
    result.collectionArtistName?.trim().toLowerCase() !==
      VARIOUS_ARTISTS_NAME.toLowerCase() ||
    !result.collectionName ||
    !albumMatches(track.albumName, result.collectionName)
  )
    return null;
  const variousArtistsId = await variousArtistsFor(db, track.userId);
  if (variousArtistsId === null) return null;
  const [current] = await db
    .select({
      artistId: lastfmAlbums.artistId,
      isFiltered: lastfmAlbums.isFiltered,
    })
    .from(lastfmAlbums)
    .where(
      and(
        eq(lastfmAlbums.id, track.albumId),
        eq(lastfmAlbums.userId, track.userId)
      )
    )
    .limit(1);
  if (!current || current.artistId === variousArtistsId) return null;
  return { variousArtistsId, isFiltered: current.isFiltered ?? 0 };
}

/** Moves the track and its plays of its per-artist album to the compilation. */
async function moveToCompilation(
  db: Database,
  track: { id: number; userId: number; albumId: number; albumName: string },
  result: ITunesSongResult,
  variousArtistsId: number
): Promise<boolean> {
  const [compilation] = await db
    .select({ id: lastfmAlbums.id })
    .from(lastfmAlbums)
    .where(
      and(
        eq(lastfmAlbums.userId, track.userId),
        eq(lastfmAlbums.name, track.albumName),
        eq(lastfmAlbums.artistId, variousArtistsId)
      )
    )
    .limit(1);
  if (!compilation) return false;

  await db.batch([
    db
      .update(lastfmTracks)
      .set({ albumId: compilation.id, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(lastfmTracks.id, track.id),
          eq(lastfmTracks.userId, track.userId),
          eq(lastfmTracks.albumId, track.albumId)
        )
      ),
    // Only plays recorded on the per-artist album move; plays of the same
    // song from another album keep theirs.
    db
      .update(lastfmScrobbles)
      .set({ albumId: compilation.id })
      .where(
        and(
          eq(lastfmScrobbles.trackId, track.id),
          eq(lastfmScrobbles.userId, track.userId),
          eq(lastfmScrobbles.albumRecorded, 1),
          eq(lastfmScrobbles.albumId, track.albumId)
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
                eq(lastfmAlbums.userId, track.userId),
                isNull(lastfmAlbums.appleMusicId)
              )
            ),
        ]
      : []),
  ]);
  // Disc-art discovery enrolls an album when one of its songs is played
  // (migration 0046). The moved plays count as plays of the compilation, so
  // enroll it the same way: an identity hold, never a paid submission. Its
  // next play would enroll it too, so a failure here is only logged.
  try {
    await db.run(sql`INSERT OR IGNORE INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check,discovery_outcome,discovery_evidence)
      SELECT a.user_id,a.id,'',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'identity_required','{}'
      FROM lastfm_albums a JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id
      WHERE a.id=${compilation.id} AND a.user_id=${track.userId}
        AND a.is_filtered=0 AND r.is_filtered=0
        AND (SELECT enabled FROM cd_artwork_control WHERE id=1)=1
        AND EXISTS (SELECT 1 FROM lastfm_scrobbles s
          WHERE s.album_id=a.id AND s.user_id=a.user_id AND s.album_recorded=1
            AND s.scrobbled_at >= (SELECT enroll_since FROM cd_artwork_control WHERE id=1))`);
  } catch (error) {
    console.log(
      `[ERROR] Disc-art enrollment failed for album ${compilation.id}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return true;
}

interface EnrichableTrack {
  id: number;
  userId: number;
  name: string;
  artistId: number;
  artistName: string;
  albumId: number | null;
  albumName: string | null;
}
type EnrichOutcome = 'enriched' | 'no_match' | 'rate_limited' | 'error';

/** Whether a match confirms the track's own album, so it takes the catalog id. */
function confirmsAlbum(track: EnrichableTrack, result: ITunesSongResult) {
  return Boolean(
    track.albumId &&
    track.albumName &&
    result.collectionName &&
    !albumMatches(track.artistName, track.albumName) &&
    albumMatches(track.albumName, result.collectionName, track.artistName) &&
    result.collectionId &&
    result.collectionViewUrl
  );
}

/**
 * Enrich a single track and its associated artist/album.
 */
async function enrichTrack(
  db: Database,
  track: EnrichableTrack
): Promise<EnrichOutcome> {
  try {
    return await applyEnrichment(
      db,
      track,
      await searchItunes(track.artistName, track.name, track.albumName)
    );
  } catch (error) {
    console.log(
      `[ERROR] Enrichment failed for track ${track.id}: ${error instanceof Error ? error.message : String(error)}`
    );
    return 'error';
  }
}

/** Writes one search result. Throws on storage errors; callers log them. */
async function applyEnrichment(
  db: Database,
  track: EnrichableTrack,
  searchResult: SearchResult
): Promise<EnrichOutcome> {
  if (searchResult.status === 'rate_limited') {
    return 'rate_limited';
  }

  if (searchResult.status === 'error') {
    return 'error';
  }

  if (searchResult.status === 'no_match') {
    await db
      .update(lastfmTracks)
      .set({ itunesEnrichedAt: new Date().toISOString() })
      .where(
        and(
          eq(lastfmTracks.id, track.id),
          eq(lastfmTracks.userId, track.userId),
          eq(lastfmTracks.name, track.name),
          eq(lastfmTracks.artistId, track.artistId),
          isNull(lastfmTracks.itunesEnrichedAt)
        )
      );
    return 'no_match';
  }

  const { result } = searchResult;
  const now = new Date().toISOString();
  // Before the track is marked enriched: a failed move throws to the catch
  // below and leaves the track queued for another attempt.
  const filedUnderCompilation =
    track.albumId !== null && track.albumName !== null
      ? await fileUnderCompilation(
          db,
          { ...track, albumId: track.albumId, albumName: track.albumName },
          result
        )
      : false;

  const updated = await db
    .update(lastfmTracks)
    .set({
      appleMusicId: result.trackId ?? null,
      appleMusicUrl: result.trackViewUrl ?? null,
      previewUrl: result.previewUrl ?? null,
      itunesEnrichedAt: now,
    })
    .where(
      and(
        eq(lastfmTracks.id, track.id),
        eq(lastfmTracks.userId, track.userId),
        eq(lastfmTracks.name, track.name),
        eq(lastfmTracks.artistId, track.artistId),
        isNull(lastfmTracks.itunesEnrichedAt)
      )
    )
    .returning({ id: lastfmTracks.id });
  // The stamp guard can miss when another run enriched the track meanwhile;
  // a move that already happened still counts as enrichment.
  if (!updated.length) return filedUnderCompilation ? 'enriched' : 'no_match';

  if (result.artistId && result.artistViewUrl) {
    await db
      .update(lastfmArtists)
      .set({
        appleMusicId: result.artistId,
        appleMusicUrl: result.artistViewUrl,
        itunesEnrichedAt: now,
      })
      .where(
        and(
          eq(lastfmArtists.id, track.artistId),
          eq(lastfmArtists.userId, track.userId),
          eq(lastfmArtists.name, track.artistName),
          eq(lastfmArtists.identityConflict, 0),
          isNull(lastfmArtists.itunesEnrichedAt)
        )
      );
  }

  if (
    !filedUnderCompilation &&
    confirmsAlbum(track, result) &&
    track.albumId &&
    track.albumName &&
    result.collectionId &&
    result.collectionViewUrl
  ) {
    await db
      .update(lastfmAlbums)
      .set({
        appleMusicId: result.collectionId,
        appleMusicUrl: result.collectionViewUrl,
        itunesEnrichedAt: now,
      })
      .where(
        and(
          eq(lastfmAlbums.id, track.albumId),
          eq(lastfmAlbums.userId, track.userId),
          eq(lastfmAlbums.name, track.albumName),
          eq(lastfmAlbums.artistId, track.artistId),
          eq(lastfmAlbums.identityConflict, 0),
          isNull(lastfmAlbums.itunesEnrichedAt)
        )
      );
  }

  return 'enriched';
}

export interface ReenrichItem {
  track_id: number;
  track: string;
  artist: string;
  album_id: number;
  album: string;
  match: {
    album: string | null;
    album_artist: string | null;
    catalog_id: number | null;
  } | null;
  /** What a live run does with this match. */
  action:
    | 'file_under_various_artists'
    | 'link_album'
    | 'track_only'
    | 'no_match'
    | 'rate_limited'
    | 'error';
  /** The existing Various Artists album, or null when a live run creates it. */
  target_album_id?: number | null;
  plays_moved?: number;
  /** Live runs only. */
  outcome?: EnrichOutcome;
}

/** Re-enrichment accepts at most this many albums and tracks per request. */
export const REENRICH_ALBUM_LIMIT = 20;
const REENRICH_TRACK_LIMIT = 50;

/**
 * Re-runs enrichment for the tracks on the given albums: plays looked up
 * before matching preferred the played album never had their album checked
 * again. The default preview searches iTunes and reports what would change
 * without writing. A live run resets each matched track's enrichment stamp and
 * applies the same search result the preview reported; unmatched tracks keep
 * their existing links.
 */
export async function reenrichAlbums(
  db: Database,
  userId: number,
  albumIds: number[],
  dryRun: boolean
): Promise<{ dry_run: boolean; truncated: boolean; items: ReenrichItem[] }> {
  if (albumIds.length === 0)
    return { dry_run: dryRun, truncated: false, items: [] };
  const found = await db
    .select({
      id: lastfmTracks.id,
      userId: lastfmTracks.userId,
      name: lastfmTracks.name,
      artistId: lastfmTracks.artistId,
      artistName: lastfmArtists.name,
      albumId: lastfmAlbums.id,
      albumName: lastfmAlbums.name,
      albumEnrichedAt: lastfmAlbums.itunesEnrichedAt,
      albumConflict: lastfmAlbums.identityConflict,
    })
    .from(lastfmTracks)
    .innerJoin(
      lastfmArtists,
      and(
        eq(lastfmTracks.artistId, lastfmArtists.id),
        eq(lastfmTracks.userId, lastfmArtists.userId)
      )
    )
    .innerJoin(
      lastfmAlbums,
      and(
        eq(lastfmTracks.albumId, lastfmAlbums.id),
        eq(lastfmTracks.userId, lastfmAlbums.userId)
      )
    )
    .where(
      and(
        eq(lastfmTracks.userId, userId),
        inArray(lastfmTracks.albumId, albumIds),
        eq(lastfmTracks.isFiltered, 0),
        eq(lastfmArtists.identityConflict, 0)
      )
    )
    .orderBy(asc(lastfmTracks.albumId), asc(lastfmTracks.id))
    .limit(REENRICH_TRACK_LIMIT + 1);
  // Report a cut-off instead of leaving the rest out silently.
  const truncated = found.length > REENRICH_TRACK_LIMIT;
  const tracks = found.slice(0, REENRICH_TRACK_LIMIT);

  const items: ReenrichItem[] = [];
  let rateLimited = false;
  for (const track of tracks) {
    const base = {
      track_id: track.id,
      track: track.name,
      artist: track.artistName,
      album_id: track.albumId,
      album: track.albumName,
    };
    if (rateLimited) {
      items.push({ ...base, match: null, action: 'rate_limited' });
      continue;
    }
    let search: SearchResult;
    try {
      search = await searchItunes(
        track.artistName,
        track.name,
        track.albumName
      );
    } catch {
      search = { status: 'error' };
    }
    if (search.status !== 'found') {
      rateLimited = search.status === 'rate_limited';
      items.push({ ...base, match: null, action: search.status });
      continue;
    }
    const { result } = search;
    const target = await compilationTarget(db, track, result);
    const item: ReenrichItem = {
      ...base,
      match: {
        album: result.collectionName ?? null,
        album_artist: result.collectionArtistName ?? null,
        catalog_id: result.collectionId ?? null,
      },
      action: target
        ? 'file_under_various_artists'
        : confirmsAlbum(track, result) &&
            track.albumEnrichedAt === null &&
            track.albumConflict === 0
          ? 'link_album'
          : 'track_only',
    };
    if (target) {
      const [existing] = await db
        .select({ id: lastfmAlbums.id })
        .from(lastfmAlbums)
        .where(
          and(
            eq(lastfmAlbums.userId, userId),
            eq(lastfmAlbums.name, track.albumName),
            eq(lastfmAlbums.artistId, target.variousArtistsId)
          )
        )
        .limit(1);
      const [plays] = await db
        .select({ n: sql<number>`count(*)` })
        .from(lastfmScrobbles)
        .where(
          and(
            eq(lastfmScrobbles.trackId, track.id),
            eq(lastfmScrobbles.userId, userId),
            eq(lastfmScrobbles.albumRecorded, 1),
            eq(lastfmScrobbles.albumId, track.albumId)
          )
        );
      item.target_album_id = existing?.id ?? null;
      item.plays_moved = Number(plays?.n ?? 0);
    }
    if (!dryRun) {
      try {
        await db
          .update(lastfmTracks)
          .set({ itunesEnrichedAt: null })
          .where(
            and(eq(lastfmTracks.id, track.id), eq(lastfmTracks.userId, userId))
          );
        item.outcome = await applyEnrichment(db, track, search);
      } catch (error) {
        console.log(
          `[ERROR] Re-enrichment failed for track ${track.id}: ${error instanceof Error ? error.message : String(error)}`
        );
        item.outcome = 'error';
      }
    }
    items.push(item);
  }
  return { dry_run: dryRun, truncated, items };
}

/**
 * Enrich a batch of tracks with Apple Music URLs.
 * Processes sequentially with no internal delays — caller handles pacing.
 * Stops early and returns if rate limited so caller can wait and retry.
 */
export async function enrichBatch(
  db: Database,
  limit: number
): Promise<BatchEnrichResult> {
  const tracks = await db
    .select({
      id: lastfmTracks.id,
      userId: lastfmTracks.userId,
      name: lastfmTracks.name,
      artistId: lastfmTracks.artistId,
      artistName: lastfmArtists.name,
      albumId: lastfmTracks.albumId,
      albumName: lastfmAlbums.name,
    })
    .from(lastfmTracks)
    .innerJoin(
      lastfmArtists,
      and(
        eq(lastfmTracks.artistId, lastfmArtists.id),
        eq(lastfmTracks.userId, lastfmArtists.userId)
      )
    )
    .leftJoin(
      lastfmAlbums,
      and(
        eq(lastfmTracks.albumId, lastfmAlbums.id),
        eq(lastfmTracks.userId, lastfmAlbums.userId)
      )
    )
    .where(
      and(
        isNull(lastfmTracks.itunesEnrichedAt),
        eq(lastfmTracks.isFiltered, 0),
        eq(lastfmArtists.identityConflict, 0)
      )
    )
    .orderBy(desc(lastfmTracks.id))
    .limit(limit);

  if (tracks.length === 0) {
    return { total: 0, succeeded: 0, skipped: 0, failed: 0 };
  }

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const track of tracks) {
    const result = await enrichTrack(db, track);

    switch (result) {
      case 'enriched':
        succeeded++;
        break;
      case 'no_match':
        skipped++;
        break;
      case 'rate_limited':
        // Stop batch early — let caller handle the wait
        failed++;
        return {
          total: succeeded + skipped + failed,
          succeeded,
          skipped,
          failed,
        };
      case 'error':
        failed++;
        break;
    }
  }

  return { total: tracks.length, succeeded, skipped, failed };
}

/**
 * Search iTunes for an artist directly (entity=musicArtist).
 * Used as a fallback for artists that the track-driven enrichBatch path
 * cannot reach — either because none of their tracks landed a matchable
 * iTunes song result, or because they have no tracks in the DB at all
 * (e.g. imported via the Last.fm top-artists list with no scrobbled tracks).
 */
async function searchItunesArtist(
  artistName: string
): Promise<ArtistSearchResult> {
  const term = cleanArtistName(artistName);
  const url = new URL(ITUNES_SEARCH_URL);
  url.searchParams.set('term', term);
  url.searchParams.set('entity', 'musicArtist');
  url.searchParams.set('media', 'music');
  url.searchParams.set('limit', '5');

  const response = await fetch(url.toString());

  if (response.status === 403) {
    return { status: 'rate_limited' };
  }

  if (!response.ok) {
    return { status: 'error' };
  }

  const data = (await response.json()) as ITunesArtistSearchResponse;

  for (const result of data.results) {
    if (!result.artistId) continue;
    const link = result.artistLinkUrl ?? result.artistViewUrl;
    if (!link) continue;
    if (
      !result.artistName ||
      !artistIdentityMatches(artistName, result.artistName)
    ) {
      continue;
    }
    return { status: 'found', result };
  }

  return { status: 'no_match' };
}

/**
 * Enrich artists that have no Apple Music URL by searching iTunes directly
 * for the artist entity. Complements `enrichBatch`, which can only reach
 * artists via a successful track match.
 *
 * Selection tiers (via ORDER BY): never-tried first, then rows whose last
 * attempt was >30 days ago. Within each tier, higher-playcount artists go
 * first so user-visible gaps (the top-artists card) clear fastest.
 *
 * On 403 the function stops early and returns, mirroring `enrichBatch`.
 */
export async function enrichArtistsByName(
  db: Database,
  limit: number
): Promise<BatchEnrichResult> {
  const artists = await db
    .select({
      id: lastfmArtists.id,
      name: lastfmArtists.name,
      userId: lastfmArtists.userId,
      enrichedAt: lastfmArtists.itunesEnrichedAt,
    })
    .from(lastfmArtists)
    .where(
      and(
        eq(lastfmArtists.userId, 1),
        eq(lastfmArtists.identityConflict, 0),
        isNull(lastfmArtists.appleMusicUrl),
        eq(lastfmArtists.isFiltered, 0),
        or(
          isNull(lastfmArtists.itunesEnrichedAt),
          lt(lastfmArtists.itunesEnrichedAt, sql.raw(ITUNES_RETRY_INTERVAL))
        )
      )
    )
    .orderBy(
      // Never-tried rows ahead of retried rows (SQLite: 1 sorts before 0 asc,
      // so `IS NULL DESC` puts NULLs first).
      sql`${lastfmArtists.itunesEnrichedAt} IS NULL DESC`,
      desc(lastfmArtists.playcount)
    )
    .limit(limit);

  if (artists.length === 0) {
    return { total: 0, succeeded: 0, skipped: 0, failed: 0 };
  }

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const artist of artists) {
    const searchResult = await searchItunesArtist(artist.name);

    if (searchResult.status === 'rate_limited') {
      failed++;
      return {
        total: succeeded + skipped + failed,
        succeeded,
        skipped,
        failed,
      };
    }

    if (searchResult.status === 'error') {
      failed++;
      continue;
    }

    const now = new Date().toISOString();

    if (searchResult.status === 'no_match') {
      // Stamp itunes_enriched_at so this artist drops into the 30-day retry
      // tier instead of being re-attempted on every pass.
      await db
        .update(lastfmArtists)
        .set({ itunesEnrichedAt: now })
        .where(
          and(
            eq(lastfmArtists.id, artist.id),
            eq(lastfmArtists.userId, artist.userId),
            eq(lastfmArtists.name, artist.name),
            eq(lastfmArtists.identityConflict, 0),
            isNull(lastfmArtists.appleMusicUrl),
            artist.enrichedAt
              ? eq(lastfmArtists.itunesEnrichedAt, artist.enrichedAt)
              : isNull(lastfmArtists.itunesEnrichedAt)
          )
        );
      skipped++;
      continue;
    }

    const { result } = searchResult;
    const link = result.artistLinkUrl ?? result.artistViewUrl;
    await db
      .update(lastfmArtists)
      .set({
        appleMusicId: result.artistId,
        appleMusicUrl: link,
        itunesEnrichedAt: now,
      })
      .where(
        and(
          eq(lastfmArtists.id, artist.id),
          eq(lastfmArtists.userId, artist.userId),
          eq(lastfmArtists.name, artist.name),
          eq(lastfmArtists.identityConflict, 0),
          isNull(lastfmArtists.appleMusicUrl),
          artist.enrichedAt
            ? eq(lastfmArtists.itunesEnrichedAt, artist.enrichedAt)
            : isNull(lastfmArtists.itunesEnrichedAt)
        )
      );
    succeeded++;
  }

  return { total: artists.length, succeeded, skipped, failed };
}
