/**
 * iTunes Search API enrichment service.
 * Searches for tracks by artist+name, validates results, and updates
 * artist/album/track records with Apple Music URLs and preview audio.
 *
 * Each batch call processes a small number of tracks sequentially
 * with no internal rate limiting. Rate pacing is handled by the caller
 * (the backfill script controls delay between batch requests).
 */

import { eq, and, isNull, or, lt, sql, desc } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  lastfmTracks,
  lastfmAlbums,
  lastfmArtists,
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

export interface ITunesSongResult {
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

export type SearchResult =
  | { status: 'found'; result: ITunesSongResult }
  | { status: 'no_match' }
  | { status: 'rate_limited' }
  | { status: 'error'; detail?: string };

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
export async function searchItunes(
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
    return { status: 'error', detail: `HTTP ${response.status}` };
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
export async function variousArtistsFor(db: Database, userId: number) {
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

/**
 * Whether a match confirms the track's own album, so it takes the catalog id.
 * A match credited to Various Artists means the album is a per-artist split of
 * a compilation; the album check files it instead (album-enrich.ts), and
 * linking here would mark it checked first.
 */
function confirmsAlbum(track: EnrichableTrack, result: ITunesSongResult) {
  return Boolean(
    track.albumId &&
    track.albumName &&
    result.collectionName &&
    result.collectionArtistName?.trim().toLowerCase() !==
      VARIOUS_ARTISTS_NAME.toLowerCase() &&
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
  if (!updated.length) return 'no_match';

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
