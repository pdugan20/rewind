/**
 * iTunes Search API enrichment service.
 * Searches for tracks by artist+name, validates results, and updates
 * artist/album/track records with Apple Music URLs and preview audio.
 */

import { eq, and, isNull, desc } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  lastfmTracks,
  lastfmAlbums,
  lastfmArtists,
} from '../../db/schema/lastfm.js';
import { artistMatches, cleanArtistName } from '../images/sources/utils.js';

const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const CONCURRENCY = 3;
const DELAY_BETWEEN_BATCHES_MS = 500;
const BACKOFF_DELAY_MS = 3000;

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

interface ITunesSearchResponse {
  resultCount: number;
  results: ITunesSongResult[];
}

export interface EnrichResult {
  trackId: number;
  status: 'enriched' | 'no_match' | 'error';
  source?: string;
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
    console.log('[WARN] iTunes rate limited, backing off');
    return { status: 'rate_limited' };
  }

  if (!response.ok) {
    return { status: 'error' };
  }

  const data = (await response.json()) as ITunesSearchResponse;

  for (const result of data.results) {
    if (!result.trackViewUrl) continue;

    // Validate artist name matches
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
): Promise<EnrichResult> {
  try {
    const searchResult = await searchItunes(track.artistName, track.name);

    if (searchResult.status === 'rate_limited') {
      return { trackId: track.id, status: 'error' };
    }

    if (searchResult.status === 'error') {
      return { trackId: track.id, status: 'error' };
    }

    if (searchResult.status === 'no_match') {
      // Mark enriched with null URLs so we don't retry
      await db
        .update(lastfmTracks)
        .set({ itunesEnrichedAt: new Date().toISOString() })
        .where(eq(lastfmTracks.id, track.id));
      return { trackId: track.id, status: 'no_match' };
    }

    const { result } = searchResult;
    const now = new Date().toISOString();

    // Update track
    await db
      .update(lastfmTracks)
      .set({
        appleMusicId: result.trackId ?? null,
        appleMusicUrl: result.trackViewUrl ?? null,
        previewUrl: result.previewUrl ?? null,
        itunesEnrichedAt: now,
      })
      .where(eq(lastfmTracks.id, track.id));

    // Update artist (only if not already enriched — first match wins)
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

    // Update album (only if not already enriched and album exists)
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

    return { trackId: track.id, status: 'enriched' };
  } catch (error) {
    console.log(
      `[ERROR] Enrichment failed for track ${track.id}: ${error instanceof Error ? error.message : String(error)}`
    );
    return { trackId: track.id, status: 'error' };
  }
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enrich a batch of tracks with Apple Music URLs.
 * Processes in groups of CONCURRENCY with delays between groups.
 */
export async function enrichBatch(
  db: Database,
  limit: number
): Promise<BatchEnrichResult> {
  // Fetch unenriched tracks ordered by playcount (via scrobble count)
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
  let useBackoff = false;

  // Process in groups of CONCURRENCY
  for (let i = 0; i < tracks.length; i += CONCURRENCY) {
    const group = tracks.slice(i, i + CONCURRENCY);

    if (useBackoff) {
      // Fall back to sequential on rate limit
      for (const track of group) {
        const result = await enrichTrack(db, track);
        if (result.status === 'enriched') succeeded++;
        else if (result.status === 'no_match') skipped++;
        else failed++;
        await sleep(BACKOFF_DELAY_MS);
      }
      useBackoff = false;
    } else {
      // Concurrent requests
      const results = await Promise.all(
        group.map((track) => enrichTrack(db, track))
      );

      for (const result of results) {
        if (result.status === 'enriched') succeeded++;
        else if (result.status === 'no_match') skipped++;
        else {
          failed++;
          useBackoff = true;
        }
      }
    }

    // Delay between groups (skip after last group)
    if (i + CONCURRENCY < tracks.length) {
      await sleep(useBackoff ? BACKOFF_DELAY_MS : DELAY_BETWEEN_BATCHES_MS);
    }
  }

  return {
    total: tracks.length,
    succeeded,
    skipped,
    failed,
  };
}
