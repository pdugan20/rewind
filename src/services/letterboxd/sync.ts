import { eq, and, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { movies, watchHistory } from '../../db/schema/watching.js';
import { syncRuns, images } from '../../db/schema/system.js';
import { TmdbClient } from '../watching/tmdb.js';
import { resolveMovie } from '../watching/resolve-movie.js';
import { computeWatchStats } from '../plex/sync.js';
import { fetchLetterboxdFeed, type LetterboxdEntry } from './client.js';
import { runPipeline, type PipelineEnv } from '../images/pipeline.js';
import { afterSync } from '../../lib/after-sync.js';
import type { FeedItem, SearchItem } from '../../lib/after-sync.js';

/**
 * Resolve a movie from a Letterboxd entry using the unified resolution
 * function. Letterboxd RSS uses tmdb:tvId for series-shaped entries
 * (e.g. multi-part docs); we treat those as movie-equivalent because the
 * RSS only carries series-level watches without episode info. TV-shaped
 * rows go into `movies` with tmdb_id = NULL — SQLite UNIQUE allows
 * multiple NULLs, and dedupe is handled by (title, year, tmdb_id IS NULL)
 * so subsequent watches of the same TV show reuse the same row.
 */
async function resolveMovieFromLetterboxd(
  db: Database,
  entry: LetterboxdEntry,
  tmdbClient: TmdbClient,
  pipelineEnv: PipelineEnv | null
): Promise<number | null> {
  if (entry.tmdbMovieId !== null || !entry.tmdbTvId) {
    const result = await resolveMovie(db, tmdbClient, {
      tmdbId: entry.tmdbMovieId ?? undefined,
      title: entry.filmTitle,
      year: entry.filmYear,
    });
    return result?.id ?? null;
  }

  return await resolveTvAsMovie(db, entry, tmdbClient, pipelineEnv);
}

/**
 * Insert (or find) a movies row representing a Letterboxd TV-series watch.
 * tmdb_id is NULL to avoid colliding with movie TMDB IDs in the unique
 * constraint; dedupe is by (title, year, tmdb_id IS NULL).
 */
async function resolveTvAsMovie(
  db: Database,
  entry: LetterboxdEntry,
  tmdbClient: TmdbClient,
  pipelineEnv: PipelineEnv | null
): Promise<number | null> {
  // Dedupe: another Letterboxd TV watch may have already created this row.
  const existing = await db
    .select({ id: movies.id })
    .from(movies)
    .where(
      and(
        eq(movies.title, entry.filmTitle),
        entry.filmYear === null
          ? isNull(movies.year)
          : eq(movies.year, entry.filmYear),
        isNull(movies.tmdbId)
      )
    )
    .limit(1);
  if (existing[0]) {
    // Self-heal: if the existing row has no images table entry yet but we
    // now have a poster URL, run the pipeline. Lets backfill catch up
    // without needing a manual one-shot per row.
    if (entry.posterUrl && pipelineEnv) {
      await maybeRunPosterPipeline(
        db,
        pipelineEnv,
        existing[0].id,
        entry.posterUrl
      );
    }
    return existing[0].id;
  }

  // Fetch TV-show metadata from TMDB (different endpoint from movies).
  let title = entry.filmTitle;
  let year = entry.filmYear;
  let summary: string | null = null;
  let posterPath: string | null = null;
  let backdropPath: string | null = null;
  let contentRating: string | null = null;
  let tmdbRating: number | null = null;
  if (entry.tmdbTvId) {
    try {
      const detail = await tmdbClient.getTvShowDetail(entry.tmdbTvId);
      title = detail.title;
      year = detail.year;
      summary = detail.summary;
      posterPath = detail.posterPath;
      backdropPath = detail.backdropPath;
      contentRating = detail.contentRating;
      tmdbRating = detail.tmdbRating;
    } catch (error) {
      console.log(
        `[ERROR] TMDB TV fetch failed for ${entry.tmdbTvId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const [inserted] = await db
    .insert(movies)
    .values({
      title,
      year,
      tmdbId: null,
      summary,
      posterPath,
      backdropPath,
      contentRating,
      tmdbRating,
    })
    .returning({ id: movies.id });

  console.log(
    `[INFO] Created movie row from Letterboxd TV entry: ${title} (${year}) [tmdb-tv:${entry.tmdbTvId}]`
  );

  if (entry.posterUrl && pipelineEnv) {
    await maybeRunPosterPipeline(db, pipelineEnv, inserted.id, entry.posterUrl);
  }

  return inserted.id;
}

/**
 * Pull the Letterboxd-supplied poster URL through the image pipeline so
 * the TV-as-movie row gets the same R2/thumbhash/colors treatment as a
 * normal movie. Idempotent: bails if an images row already exists.
 */
async function maybeRunPosterPipeline(
  db: Database,
  env: PipelineEnv,
  movieId: number,
  posterUrl: string
): Promise<void> {
  const existing = await db
    .select({ id: images.id })
    .from(images)
    .where(
      and(
        eq(images.domain, 'watching'),
        eq(images.entityType, 'movies'),
        eq(images.entityId, String(movieId))
      )
    )
    .limit(1);
  if (existing[0]) return;

  try {
    await runPipeline(db, env, {
      domain: 'watching',
      entityType: 'movies',
      entityId: String(movieId),
      directImageUrl: posterUrl,
    });
  } catch (error) {
    console.log(
      `[ERROR] Letterboxd poster pipeline failed for movie ${movieId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
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
  } & Partial<PipelineEnv>
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

    // Pipeline env is only set when the caller (cron / admin endpoint)
    // bound the IMAGES + IMAGE_TRANSFORMS bindings — guards local tests
    // that mock a partial env.
    const pipelineEnv: PipelineEnv | null =
      env.IMAGES && env.IMAGE_TRANSFORMS ? (env as PipelineEnv) : null;

    let synced = 0;
    let skipped = 0;
    const newWatches: Array<{
      movieId: number;
      title: string;
      year: number | null;
      watchedAt: string;
    }> = [];

    for (const entry of entries) {
      const movieId = await resolveMovieFromLetterboxd(
        db,
        entry,
        tmdbClient,
        pipelineEnv
      );

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
        const [existing] = await db
          .select({
            id: watchHistory.id,
            userRating: watchHistory.userRating,
            review: watchHistory.review,
            watchedAt: watchHistory.watchedAt,
          })
          .from(watchHistory)
          .where(eq(watchHistory.letterboxdGuid, entry.guid))
          .limit(1);
        if (existing) {
          // Update review/rating on recent entries (last 30 days) if changed
          const watchAge = Date.now() - new Date(existing.watchedAt).getTime();
          const thirtyDays = 30 * 24 * 60 * 60 * 1000;
          if (watchAge <= thirtyDays) {
            const updates: Record<string, unknown> = {};
            if (
              entry.memberRating !== undefined &&
              entry.memberRating !== existing.userRating
            ) {
              updates.userRating = entry.memberRating;
            }
            if (
              entry.review !== undefined &&
              entry.review !== existing.review
            ) {
              updates.review = entry.review ?? null;
            }
            if (Object.keys(updates).length > 0) {
              await db
                .update(watchHistory)
                .set(updates)
                .where(eq(watchHistory.id, existing.id));
              console.log(
                `[SYNC] Updated Letterboxd entry ${entry.guid}: ${Object.keys(updates).join(', ')}`
              );
            }
          }
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
