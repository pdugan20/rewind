import { eq, and, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { watchHistory } from '../../db/schema/watching.js';
import { syncRuns } from '../../db/schema/system.js';
import { TmdbClient } from '../watching/tmdb.js';
import { resolveMovie } from '../watching/resolve-movie.js';
import { computeWatchStats } from '../plex/sync.js';
import { fetchLetterboxdFeed, type LetterboxdEntry } from './client.js';
import { afterSync } from '../../lib/after-sync.js';
import type { FeedItem, SearchItem } from '../../lib/after-sync.js';

/**
 * Resolve a movie from a Letterboxd entry using the unified resolution function.
 */
async function resolveMovieFromLetterboxd(
  db: Database,
  entry: LetterboxdEntry,
  tmdbClient: TmdbClient
): Promise<number | null> {
  const result = await resolveMovie(db, tmdbClient, {
    tmdbId: entry.tmdbMovieId ?? undefined,
    title: entry.filmTitle,
    year: entry.filmYear,
  });

  return result?.id ?? null;
}

/**
 * Find an existing watch for the same movie within 48 hours.
 * Returns the existing entry ID if found, null otherwise.
 */
async function findNearbyWatch(
  db: Database,
  movieId: number,
  watchDate: string
): Promise<{
  id: number;
  source: string;
  userRating: number | null;
  review: string | null;
} | null> {
  const existing = await db
    .select({
      id: watchHistory.id,
      source: watchHistory.source,
      userRating: watchHistory.userRating,
      review: watchHistory.review,
    })
    .from(watchHistory)
    .where(
      and(
        eq(watchHistory.movieId, movieId),
        sql`abs(julianday(${watchHistory.watchedAt}) - julianday(${watchDate})) <= 2`
      )
    )
    .limit(1);

  return existing[0] ?? null;
}

/**
 * Sync Letterboxd RSS feed entries into the watching database.
 */
export async function syncLetterboxd(
  db: Database,
  env: {
    LETTERBOXD_USERNAME: string;
    TMDB_API_KEY: string;
  }
): Promise<{ synced: number; skipped: number }> {
  const startedAt = new Date().toISOString();

  // Record sync start
  const [syncRun] = await db
    .insert(syncRuns)
    .values({
      domain: 'watching',
      syncType: 'letterboxd_rss',
      status: 'running',
      startedAt,
    })
    .returning({ id: syncRuns.id });

  try {
    const tmdbClient = new TmdbClient(env.TMDB_API_KEY);
    const entries = await fetchLetterboxdFeed(env.LETTERBOXD_USERNAME);

    let synced = 0;
    let skipped = 0;
    const newWatches: Array<{
      movieId: number;
      title: string;
      year: number | null;
      watchedAt: string;
    }> = [];

    for (const entry of entries) {
      const movieId = await resolveMovieFromLetterboxd(db, entry, tmdbClient);

      if (!movieId) {
        skipped++;
        continue;
      }

      // Determine watch date
      const watchedAt = entry.watchedDate
        ? `${entry.watchedDate}T12:00:00.000Z`
        : new Date().toISOString();

      // Dedup 1: GUID check — same diary entry already imported
      if (entry.guid) {
        const guidExists = await db
          .select({ id: watchHistory.id })
          .from(watchHistory)
          .where(eq(watchHistory.letterboxdGuid, entry.guid))
          .limit(1);
        if (guidExists.length > 0) {
          skipped++;
          continue;
        }
      }

      // Dedup 2: 48-hour window — merge Letterboxd metadata onto existing entry (e.g. from Plex)
      const nearby = await findNearbyWatch(db, movieId, watchedAt);
      if (nearby) {
        const updates: Record<string, unknown> = {};
        if (entry.memberRating && !nearby.userRating) {
          updates.userRating = entry.memberRating;
        }
        if (entry.review && !nearby.review) {
          updates.review = entry.review;
        }
        if (entry.link) {
          updates.reviewUrl = entry.link;
        }
        if (entry.guid) {
          updates.letterboxdGuid = entry.guid;
        }
        if (entry.rewatch) {
          updates.rewatch = 1;
        }
        if (Object.keys(updates).length > 0) {
          await db
            .update(watchHistory)
            .set(updates)
            .where(eq(watchHistory.id, nearby.id));
        }
        skipped++;
        continue;
      }

      // Insert new watch event
      await db.insert(watchHistory).values({
        movieId,
        watchedAt,
        source: 'letterboxd',
        userRating: entry.memberRating ?? undefined,
        rewatch: entry.rewatch ? 1 : 0,
        review: entry.review ?? undefined,
        reviewUrl: entry.link || undefined,
        letterboxdGuid: entry.guid || undefined,
      });

      newWatches.push({
        movieId,
        title: entry.filmTitle,
        year: entry.filmYear,
        watchedAt,
      });
      synced++;
    }

    // Update watch stats
    await computeWatchStats(db);

    // Record sync completion
    await db
      .update(syncRuns)
      .set({
        status: 'completed',
        completedAt: new Date().toISOString(),
        itemsSynced: synced,
        metadata: JSON.stringify({ synced, skipped }),
      })
      .where(eq(syncRuns.id, syncRun.id));

    // Post-sync: feed, search, revalidation
    const feedItems: FeedItem[] = newWatches.map((m) => ({
      domain: 'watching',
      eventType: 'movie_watched',
      occurredAt: m.watchedAt,
      title: `Watched ${m.title}${m.year ? ` (${m.year})` : ''}`,
      sourceId: `letterboxd:movie:${m.movieId}:${m.watchedAt.substring(0, 10)}`,
    }));
    const searchItems: SearchItem[] = newWatches.map((m) => ({
      domain: 'watching',
      entityType: 'movie',
      entityId: String(m.movieId),
      title: m.title,
      subtitle: m.year ? String(m.year) : undefined,
    }));
    await afterSync(db, { domain: 'watching', feedItems, searchItems });

    console.log(
      `[SYNC] Letterboxd sync complete: ${synced} synced, ${skipped} skipped`
    );
    return { synced, skipped };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    await db
      .update(syncRuns)
      .set({
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: errorMessage,
      })
      .where(eq(syncRuns.id, syncRun.id));

    console.log(`[ERROR] Letterboxd sync failed: ${errorMessage}`);
    throw error;
  }
}
