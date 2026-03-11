import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  discogsCollection,
  discogsReleases,
  discogsArtists,
  discogsReleaseArtists,
  collectionListeningXref,
} from '../../db/schema/discogs.js';

export interface LastfmAlbumRow {
  name: string;
  artistName: string;
  playcount: number;
  lastPlayed: string | null;
}

/**
 * Normalize a name for matching: lowercase, trim, remove leading "The ",
 * remove parenthetical suffixes like "(Reissue)", "(Deluxe Edition)"
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/^the\s+/i, '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute Levenshtein distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

export interface MatchResult {
  lastfmAlbumName: string | null;
  lastfmArtistName: string | null;
  playCount: number;
  lastPlayed: string | null;
  matchType: 'exact' | 'fuzzy' | 'artist_only' | 'none';
  matchConfidence: number;
}

/**
 * Find the best match for a Discogs release against Last.fm album data.
 */
export function findMatch(
  releaseTitle: string,
  releaseArtists: string[],
  lastfmAlbums: LastfmAlbumRow[]
): MatchResult {
  const normalizedTitle = normalizeName(releaseTitle);
  const normalizedArtists = releaseArtists.map(normalizeName);

  // Try exact match: both artist and album name match after normalization
  for (const album of lastfmAlbums) {
    const normalizedAlbumName = normalizeName(album.name);
    const normalizedAlbumArtist = normalizeName(album.artistName);

    if (
      normalizedAlbumName === normalizedTitle &&
      normalizedArtists.some((a) => a === normalizedAlbumArtist)
    ) {
      return {
        lastfmAlbumName: album.name,
        lastfmArtistName: album.artistName,
        playCount: album.playcount,
        lastPlayed: album.lastPlayed,
        matchType: 'exact',
        matchConfidence: 1.0,
      };
    }
  }

  // Try fuzzy match: Levenshtein distance < 3 on album name, artist matches
  let bestFuzzy: MatchResult | null = null;
  let bestDistance = 3;

  for (const album of lastfmAlbums) {
    const normalizedAlbumName = normalizeName(album.name);
    const normalizedAlbumArtist = normalizeName(album.artistName);

    if (!normalizedArtists.some((a) => a === normalizedAlbumArtist)) {
      continue;
    }

    const distance = levenshteinDistance(normalizedAlbumName, normalizedTitle);
    if (distance < bestDistance) {
      bestDistance = distance;
      const confidence = distance === 1 ? 0.9 : 0.7;
      bestFuzzy = {
        lastfmAlbumName: album.name,
        lastfmArtistName: album.artistName,
        playCount: album.playcount,
        lastPlayed: album.lastPlayed,
        matchType: 'fuzzy',
        matchConfidence: confidence,
      };
    }
  }

  if (bestFuzzy) {
    return bestFuzzy;
  }

  // Artist-only fallback: same artist, aggregate play count across all albums
  let artistMatch: MatchResult | null = null;
  let totalPlays = 0;
  let latestPlayed: string | null = null;

  for (const album of lastfmAlbums) {
    const normalizedAlbumArtist = normalizeName(album.artistName);

    if (normalizedArtists.some((a) => a === normalizedAlbumArtist)) {
      if (!artistMatch) {
        artistMatch = {
          lastfmAlbumName: null,
          lastfmArtistName: album.artistName,
          playCount: 0,
          lastPlayed: null,
          matchType: 'artist_only',
          matchConfidence: 0.5,
        };
      }
      totalPlays += album.playcount;
      if (
        album.lastPlayed &&
        (!latestPlayed || album.lastPlayed > latestPlayed)
      ) {
        latestPlayed = album.lastPlayed;
      }
    }
  }

  if (artistMatch) {
    artistMatch.playCount = totalPlays;
    artistMatch.lastPlayed = latestPlayed;
    return artistMatch;
  }

  return {
    lastfmAlbumName: null,
    lastfmArtistName: null,
    playCount: 0,
    lastPlayed: null,
    matchType: 'none',
    matchConfidence: 0,
  };
}

/**
 * Run cross-reference for all collection items against Last.fm data.
 * Since the lastfm schema may not exist yet, we query the raw D1 database.
 */
export async function runCrossReference(
  db: Database,
  d1: D1Database,
  userId: number = 1
): Promise<{ matched: number; unmatched: number }> {
  // Try to get Last.fm album data from raw SQL (schema may not exist)
  let lastfmAlbums: LastfmAlbumRow[];
  try {
    const result = await d1
      .prepare(
        `SELECT name, artist_name as artistName, playcount, last_played as lastPlayed
       FROM lastfm_albums WHERE user_id = ?`
      )
      .bind(userId)
      .all();
    lastfmAlbums = (result.results as LastfmAlbumRow[]) || [];
  } catch {
    console.log(
      '[INFO] Last.fm albums table not found, skipping cross-reference'
    );
    return { matched: 0, unmatched: 0 };
  }

  if (lastfmAlbums.length === 0) {
    console.log('[INFO] No Last.fm album data found for cross-reference');
    return { matched: 0, unmatched: 0 };
  }

  // Get all collection items with their releases and artists
  const collectionItems = await db
    .select({
      collectionId: discogsCollection.id,
      releaseId: discogsCollection.releaseId,
      releaseTitle: discogsReleases.title,
    })
    .from(discogsCollection)
    .innerJoin(
      discogsReleases,
      eq(discogsCollection.releaseId, discogsReleases.id)
    )
    .where(eq(discogsCollection.userId, userId));

  let matched = 0;
  let unmatched = 0;

  for (const item of collectionItems) {
    // Get artists for this release
    const artistRows = await db
      .select({ name: discogsArtists.name })
      .from(discogsReleaseArtists)
      .innerJoin(
        discogsArtists,
        eq(discogsReleaseArtists.artistId, discogsArtists.id)
      )
      .where(eq(discogsReleaseArtists.releaseId, item.releaseId));

    const artistNames = artistRows.map((a) => a.name);
    const match = findMatch(item.releaseTitle, artistNames, lastfmAlbums);

    // Upsert into collection_listening_xref
    await db
      .insert(collectionListeningXref)
      .values({
        userId,
        collectionId: item.collectionId,
        releaseId: item.releaseId,
        lastfmAlbumName: match.lastfmAlbumName,
        lastfmArtistName: match.lastfmArtistName,
        playCount: match.playCount,
        lastPlayed: match.lastPlayed,
        matchType: match.matchType,
        matchConfidence: match.matchConfidence,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [
          collectionListeningXref.userId,
          collectionListeningXref.collectionId,
        ],
        set: {
          lastfmAlbumName: sql`excluded.lastfm_album_name`,
          lastfmArtistName: sql`excluded.lastfm_artist_name`,
          playCount: sql`excluded.play_count`,
          lastPlayed: sql`excluded.last_played`,
          matchType: sql`excluded.match_type`,
          matchConfidence: sql`excluded.match_confidence`,
          updatedAt: sql`excluded.updated_at`,
        },
      });

    if (match.matchType !== 'none') {
      matched++;
    } else {
      unmatched++;
    }
  }

  console.log(
    `[SYNC] Cross-reference complete: ${matched} matched, ${unmatched} unmatched`
  );
  return { matched, unmatched };
}
