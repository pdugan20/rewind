/**
 * iTunes Search API enrichment service.
 * Searches for tracks by artist+name, validates results, and updates
 * artist/album/track records with Apple Music URLs and preview audio.
 *
 * Each batch call processes a small number of tracks sequentially
 * with no internal rate limiting. Rate pacing is handled by the caller
 * (the backfill script controls delay between batch requests).
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
