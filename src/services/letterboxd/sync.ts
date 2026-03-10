import { eq, and, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { movies, watchHistory } from '../../db/schema/watching.js';
import { syncRuns } from '../../db/schema/system.js';
import { TmdbClient } from '../watching/tmdb.js';
import { upsertGenres, upsertDirectors } from '../plex/webhook.js';
import { computeWatchStats } from '../plex/sync.js';
import { fetchLetterboxdFeed, type LetterboxdEntry } from './client.js';

/**
 * Upsert a movie from Letterboxd entry, enriching from TMDB.
 */
async function upsertMovieFromLetterboxd(
  db: Database,
  entry: LetterboxdEntry,
  tmdbClient: TmdbClient
): Promise<number | null> {
  // If we have a TMDB ID, check if movie already exists
  if (entry.tmdbMovieId) {
    const existing = await db
      .select({ id: movies.id })
      .from(movies)
      .where(eq(movies.tmdbId, entry.tmdbMovieId))
      .limit(1);

    if (existing.length > 0) {
      return existing[0].id;
    }

    // Enrich from TMDB
    try {
      const detail = await tmdbClient.getMovieDetail(entry.tmdbMovieId);

      const [inserted] = await db
        .insert(movies)
        .values({
          title: detail.title,
          year: detail.year,
          tmdbId: detail.id,
          imdbId: detail.imdb_id,
          tagline: detail.tagline,
          summary: detail.overview,
          contentRating: detail.content_rating,
          runtime: detail.runtime,
          posterPath: detail.poster_path,
          backdropPath: detail.backdrop_path,
          tmdbRating: detail.vote_average,
        })
        .returning({ id: movies.id });

      const movieId = inserted.id;

      // Upsert genres and directors
      await upsertGenres(db, movieId, detail.genres);
      await upsertDirectors(db, movieId, detail.directors);

      return movieId;
    } catch (error) {
      console.log(
        `[ERROR] TMDB enrichment failed for Letterboxd entry "${entry.filmTitle}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Fallback: search TMDB by title + year
  try {
    const results = await tmdbClient.searchMovie(
      entry.filmTitle,
      entry.filmYear || undefined
    );

    if (results.length > 0) {
      const tmdbId = results[0].id;

      // Check if movie already exists by TMDB ID
      const existing = await db
        .select({ id: movies.id })
        .from(movies)
        .where(eq(movies.tmdbId, tmdbId))
        .limit(1);

      if (existing.length > 0) {
        return existing[0].id;
      }

      // Fetch full details
      const detail = await tmdbClient.getMovieDetail(tmdbId);

      const [inserted] = await db
        .insert(movies)
        .values({
          title: detail.title,
          year: detail.year,
          tmdbId: detail.id,
          imdbId: detail.imdb_id,
          tagline: detail.tagline,
          summary: detail.overview,
          contentRating: detail.content_rating,
          runtime: detail.runtime,
          posterPath: detail.poster_path,
          backdropPath: detail.backdrop_path,
          tmdbRating: detail.vote_average,
        })
        .returning({ id: movies.id });

      const movieId = inserted.id;
      await upsertGenres(db, movieId, detail.genres);
      await upsertDirectors(db, movieId, detail.directors);

      return movieId;
    }
  } catch (error) {
    console.log(
      `[ERROR] TMDB search failed for "${entry.filmTitle}" (${entry.filmYear}): ${error instanceof Error ? error.message : String(error)}`
    );
  }

  console.log(
    `[INFO] Could not resolve movie for Letterboxd entry: "${entry.filmTitle}" (${entry.filmYear})`
  );
  return null;
}

/**
 * Check for duplicate watch (same movie + same calendar date).
 */
async function isDuplicateWatch(
  db: Database,
  movieId: number,
  watchDate: string
): Promise<boolean> {
  const dateStr = watchDate.substring(0, 10);
  const existing = await db
    .select({ id: watchHistory.id })
    .from(watchHistory)
    .where(
      and(
        eq(watchHistory.movieId, movieId),
        sql`substr(${watchHistory.watchedAt}, 1, 10) = ${dateStr}`
      )
    )
    .limit(1);

  return existing.length > 0;
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

    for (const entry of entries) {
      const movieId = await upsertMovieFromLetterboxd(db, entry, tmdbClient);

      if (!movieId) {
        skipped++;
        continue;
      }

      // Determine watch date
      const watchedAt = entry.watchedDate
        ? `${entry.watchedDate}T12:00:00.000Z`
        : new Date().toISOString();

      // Dedup check
      const isDuplicate = await isDuplicateWatch(db, movieId, watchedAt);
      if (isDuplicate) {
        skipped++;
        continue;
      }

      // Insert watch event
      await db.insert(watchHistory).values({
        movieId,
        watchedAt,
        source: 'letterboxd',
        userRating: entry.memberRating,
        rewatch: entry.rewatch ? 1 : 0,
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
