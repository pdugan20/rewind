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
import { artistMatches, cleanArtistName } from '../images/sources/utils.js';

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
 * Search iTunes for a song and return the first validated match.
 */
async function searchItunes(
  artistName: string,
  trackName: string
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

  for (const result of data.results) {
    if (!result.trackViewUrl) continue;

    if (result.artistName && !artistMatches(artistName, result.artistName)) {
      continue;
    }

    return { status: 'found', result };
  }

  return { status: 'no_match' };
}

/**
 * Enrich a single track and its associated artist/album.
 */
async function enrichTrack(
  db: Database,
  track: {
    id: number;
    name: string;
    artistId: number;
    artistName: string;
    albumId: number | null;
  }
): Promise<'enriched' | 'no_match' | 'rate_limited' | 'error'> {
  try {
    const searchResult = await searchItunes(track.artistName, track.name);

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
        .where(eq(lastfmTracks.id, track.id));
      return 'no_match';
    }

    const { result } = searchResult;
    const now = new Date().toISOString();

    await db
      .update(lastfmTracks)
      .set({
        appleMusicId: result.trackId ?? null,
        appleMusicUrl: result.trackViewUrl ?? null,
        previewUrl: result.previewUrl ?? null,
        itunesEnrichedAt: now,
      })
      .where(eq(lastfmTracks.id, track.id));

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
            isNull(lastfmArtists.itunesEnrichedAt)
          )
        );
    }

    if (track.albumId && result.collectionId && result.collectionViewUrl) {
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
            isNull(lastfmAlbums.itunesEnrichedAt)
          )
        );
    }

    return 'enriched';
  } catch (error) {
    console.log(
      `[ERROR] Enrichment failed for track ${track.id}: ${error instanceof Error ? error.message : String(error)}`
    );
    return 'error';
  }
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
      name: lastfmTracks.name,
      artistId: lastfmTracks.artistId,
      artistName: lastfmArtists.name,
      albumId: lastfmTracks.albumId,
    })
    .from(lastfmTracks)
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .where(
      and(isNull(lastfmTracks.itunesEnrichedAt), eq(lastfmTracks.isFiltered, 0))
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
    if (result.artistName && !artistMatches(artistName, result.artistName)) {
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
      enrichedAt: lastfmArtists.itunesEnrichedAt,
    })
    .from(lastfmArtists)
    .where(
      and(
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
        .where(eq(lastfmArtists.id, artist.id));
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
      .where(eq(lastfmArtists.id, artist.id));
    succeeded++;
  }

  return { total: artists.length, succeeded, skipped, failed };
}
