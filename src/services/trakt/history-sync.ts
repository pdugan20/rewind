import { eq, and, sql, count, lt, inArray } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import { syncRuns } from '../../db/schema/system.js';
import {
  movies,
  watchHistory,
  shows,
  episodesWatched,
} from '../../db/schema/watching.js';
import { TraktClient, type TraktRatingItem } from './client.js';
import { getAccessToken } from './auth.js';
import { TmdbClient } from '../watching/tmdb.js';
import { resolveMovie } from '../watching/resolve-movie.js';
import { computeWatchStats } from '../plex/sync.js';
import { afterSync } from '../../lib/after-sync.js';
import type { FeedItem, SearchItem } from '../../lib/after-sync.js';
import type { Env } from '../../types/env.js';

// The per-page inArray dedup binds PAGE_LIMIT parameters in one select, and
// D1 caps queries at 100 bound parameters — PAGE_LIMIT must not exceed 100.
const PAGE_LIMIT = 100;

export interface SyncedWatch {
  movieId: number;
  title: string;
  year: number | null;
  watchedAt: string;
}

export function buildMovieFeedItem(watch: SyncedWatch): FeedItem {
  return {
    domain: 'watching',
    eventType: 'movie_watched',
    occurredAt: watch.watchedAt,
    title: `Watched ${watch.title}${watch.year ? ` (${watch.year})` : ''}`,
    sourceId: `trakt:movie:${watch.movieId}:${watch.watchedAt.substring(0, 10)}`,
  };
}

export interface SyncedEpisode {
  showId: number;
  showTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  watchedAt: string;
}

export function buildEpisodeFeedItem(ep: SyncedEpisode): FeedItem {
  const code = `S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`;
  return {
    domain: 'watching',
    eventType: 'episode_watched',
    occurredAt: ep.watchedAt,
    title: `Watched ${ep.showTitle} ${code}`,
    sourceId: `trakt:episode:${ep.showId}:${ep.seasonNumber}:${ep.episodeNumber}:${ep.watchedAt.substring(0, 10)}`,
  };
}

export function shouldMarkRewatch(earlierWatchCount: number): boolean {
  return earlierWatchCount > 0;
}

/**
 * Most recent Trakt-sourced movie watch, used as the incremental cursor.
 * Returns undefined on first run (full history walk).
 *
 * Because the walk inserts chronologically and pins its window with end_at
 * at the sync start, this max only ever reflects completed work — an
 * interrupted walk resumes from here without gaps, and watches landing
 * mid-walk stay outside the window until the next run.
 *
 * Known limitation: a watch back-dated in Trakt to before this cursor after
 * the cursor has already advanced will never fall inside an incremental
 * window and is silently missed. The escape hatch is a cursor-less full
 * re-walk, which is idempotent thanks to traktHistoryId dedup — an admin
 * full-resync option (`full=true`) arrives in Task 7.
 */
async function movieCursor(
  db: Database,
  userId: number
): Promise<string | undefined> {
  const [row] = await db
    .select({ max: sql<string | null>`max(${watchHistory.watchedAt})` })
    .from(watchHistory)
    .where(
      and(eq(watchHistory.userId, userId), eq(watchHistory.source, 'trakt'))
    );
  return row?.max ?? undefined;
}

export async function syncMovieHistory(
  db: Database,
  client: TraktClient,
  tmdbClient: TmdbClient,
  userId: number
): Promise<{ synced: number; skipped: number; newWatches: SyncedWatch[] }> {
  const startAt = await movieCursor(db, userId);
  // Pin the walk window to the sync start: without end_at, watches landing
  // mid-walk would shift page contents under the reverse walk.
  const endAt = new Date().toISOString();
  console.log(
    `[SYNC] Trakt movie history ${startAt ? `since ${startAt}` : 'full walk'}`
  );

  let synced = 0;
  let skipped = 0;
  const newWatches: SyncedWatch[] = [];

  // Trakt returns history newest-first. Walk pages from last to first, and
  // items within each page in reverse, so inserts happen chronologically:
  // the earlier-watch count for the rewatch flag is correct at insert time,
  // and the cursor (max watchedAt of trakt rows) only ever covers completed
  // work, so an interrupted backfill resumes without gaps. The page-1 fetch
  // below discovers pageCount; single-page histories reuse it directly,
  // while multi-page walks refetch page 1 when they get there — the endAt
  // pin keeps its contents stable and traktHistoryId dedup keeps any
  // reprocessing idempotent.
  const first = await client.getMovieHistory({
    startAt,
    endAt,
    page: 1,
    limit: PAGE_LIMIT,
  });

  for (let page = first.pageCount; page >= 1; page--) {
    const result =
      first.pageCount <= 1
        ? first
        : await client.getMovieHistory({
            startAt,
            endAt,
            page,
            limit: PAGE_LIMIT,
          });

    // Oldest first within the page
    const items = [...result.items].reverse();

    // Batched dedup on Trakt's per-event history ID
    const pageIds = items.map((item) => item.id);
    const existingIds = new Set<number>();
    if (pageIds.length > 0) {
      const existingRows = await db
        .select({ traktHistoryId: watchHistory.traktHistoryId })
        .from(watchHistory)
        .where(
          and(
            eq(watchHistory.userId, userId),
            inArray(watchHistory.traktHistoryId, pageIds)
          )
        );
      for (const row of existingRows) {
        if (row.traktHistoryId !== null) existingIds.add(row.traktHistoryId);
      }
    }

    for (const item of items) {
      if (existingIds.has(item.id)) {
        skipped++;
        continue;
      }

      const tmdbId = item.movie.ids.tmdb;
      if (!tmdbId) {
        console.log(`[INFO] Skipping ${item.movie.title} - no TMDb ID`);
        skipped++;
        continue;
      }

      const resolved = await resolveMovie(db, tmdbClient, {
        tmdbId,
        title: item.movie.title,
        year: item.movie.year,
      });
      if (!resolved) {
        skipped++;
        continue;
      }

      const [earlier] = await db
        .select({ count: count() })
        .from(watchHistory)
        .where(
          and(
            eq(watchHistory.userId, userId),
            eq(watchHistory.movieId, resolved.id),
            lt(watchHistory.watchedAt, item.watched_at)
          )
        );

      await db.insert(watchHistory).values({
        userId,
        movieId: resolved.id,
        watchedAt: item.watched_at,
        source: 'trakt',
        traktHistoryId: item.id,
        rewatch: shouldMarkRewatch(earlier?.count ?? 0) ? 1 : 0,
      });

      newWatches.push({
        movieId: resolved.id,
        title: item.movie.title,
        year: item.movie.year ?? null,
        watchedAt: item.watched_at,
      });
      synced++;
    }
  }

  return { synced, skipped, newWatches };
}

/**
 * Look up a show by TMDB ID, creating a TMDB-enriched row if new.
 */
async function ensureShow(
  db: Database,
  tmdbClient: TmdbClient,
  userId: number,
  show: { title: string; year: number | null; traktId: number; tmdbId: number },
  cache: Map<number, number>
): Promise<number> {
  const cached = cache.get(show.tmdbId);
  if (cached !== undefined) return cached;

  const [existing] = await db
    .select({ id: shows.id })
    .from(shows)
    .where(eq(shows.tmdbId, show.tmdbId))
    .limit(1);
  if (existing) {
    cache.set(show.tmdbId, existing.id);
    return existing.id;
  }

  // Fall back to Trakt identity: a prior run may have stored this show
  // under a different TMDB id (Trakt TMDB-mapping churn). Reuse that row
  // rather than tripping shows_trakt_id_unique on insert; keep its stored
  // tmdbId as-is.
  const [byTraktId] = await db
    .select({ id: shows.id })
    .from(shows)
    .where(eq(shows.traktId, show.traktId))
    .limit(1);
  if (byTraktId) {
    console.log(
      `[INFO] Show ${show.title} (trakt ${show.traktId}) exists under a different TMDB id; ignoring incoming tmdb ${show.tmdbId}`
    );
    cache.set(show.tmdbId, byTraktId.id);
    return byTraktId.id;
  }

  let detail = null;
  try {
    detail = await tmdbClient.getTvShowDetail(show.tmdbId);
  } catch (error) {
    console.log(
      `[ERROR] TMDB TV enrichment failed for ${show.title}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const [inserted] = await db
    .insert(shows)
    .values({
      userId,
      traktId: show.traktId,
      tmdbId: show.tmdbId,
      title: detail?.title ?? show.title,
      year: detail?.year ?? show.year,
      summary: detail?.summary ?? null,
      posterPath: detail?.posterPath ?? null,
      backdropPath: detail?.backdropPath ?? null,
      contentRating: detail?.contentRating ?? null,
      tmdbRating: detail?.tmdbRating ?? null,
      totalSeasons: detail?.totalSeasons ?? null,
      totalEpisodes: detail?.totalEpisodes ?? null,
    })
    .returning({ id: shows.id });

  cache.set(show.tmdbId, inserted.id);
  return inserted.id;
}

/**
 * Most recent Trakt-sourced episode watch, used as the incremental cursor.
 * Returns undefined on first run (full history walk).
 *
 * Because the walk inserts chronologically and pins its window with end_at
 * at the sync start, this max only ever reflects completed work — an
 * interrupted walk resumes from here without gaps, and watches landing
 * mid-walk stay outside the window until the next run.
 *
 * Known limitation: a watch back-dated in Trakt to before this cursor after
 * the cursor has already advanced will never fall inside an incremental
 * window and is silently missed. The escape hatch is a cursor-less full
 * re-walk, which is idempotent thanks to traktHistoryId dedup — an admin
 * full-resync option (`full=true`) arrives in Task 7.
 */
async function episodeCursor(
  db: Database,
  userId: number
): Promise<string | undefined> {
  const [row] = await db
    .select({ max: sql<string | null>`max(${episodesWatched.watchedAt})` })
    .from(episodesWatched)
    .where(
      and(
        eq(episodesWatched.userId, userId),
        eq(episodesWatched.source, 'trakt')
      )
    );
  return row?.max ?? undefined;
}

export async function syncEpisodeHistory(
  db: Database,
  client: TraktClient,
  tmdbClient: TmdbClient,
  userId: number
): Promise<{ synced: number; skipped: number; newEpisodes: SyncedEpisode[] }> {
  const startAt = await episodeCursor(db, userId);
  // Pin the walk window to the sync start: without end_at, watches landing
  // mid-walk would shift page contents under the reverse walk.
  const endAt = new Date().toISOString();
  console.log(
    `[SYNC] Trakt episode history ${startAt ? `since ${startAt}` : 'full walk'}`
  );

  let synced = 0;
  let skipped = 0;
  const newEpisodes: SyncedEpisode[] = [];
  const showCache = new Map<number, number>();

  // Same chronological reverse-page walk as syncMovieHistory: newest-first
  // pages processed last-to-first, items oldest-first within each page, so
  // the cursor only ever covers completed work. Single-page histories reuse
  // the discovery fetch; multi-page walks refetch page 1 when they get
  // there — the endAt pin keeps its contents stable and traktHistoryId
  // dedup keeps any reprocessing idempotent.
  const first = await client.getEpisodeHistory({
    startAt,
    endAt,
    page: 1,
    limit: PAGE_LIMIT,
  });

  for (let page = first.pageCount; page >= 1; page--) {
    const result =
      first.pageCount <= 1
        ? first
        : await client.getEpisodeHistory({
            startAt,
            endAt,
            page,
            limit: PAGE_LIMIT,
          });

    // Oldest first within the page
    const items = [...result.items].reverse();

    // Batched dedup on Trakt's per-event history ID
    const pageIds = items.map((item) => item.id);
    const existingIds = new Set<number>();
    if (pageIds.length > 0) {
      const existingRows = await db
        .select({ traktHistoryId: episodesWatched.traktHistoryId })
        .from(episodesWatched)
        .where(
          and(
            eq(episodesWatched.userId, userId),
            inArray(episodesWatched.traktHistoryId, pageIds)
          )
        );
      for (const row of existingRows) {
        if (row.traktHistoryId !== null) existingIds.add(row.traktHistoryId);
      }
    }

    for (const item of items) {
      if (existingIds.has(item.id)) {
        skipped++;
        continue;
      }

      const showTmdbId = item.show.ids.tmdb;
      if (!showTmdbId) {
        console.log(`[INFO] Skipping ${item.show.title} - no TMDb ID`);
        skipped++;
        continue;
      }

      const showId = await ensureShow(
        db,
        tmdbClient,
        userId,
        {
          title: item.show.title,
          year: item.show.year,
          traktId: item.show.ids.trakt,
          tmdbId: showTmdbId,
        },
        showCache
      );

      const insertResult = await db
        .insert(episodesWatched)
        .values({
          userId,
          showId,
          seasonNumber: item.episode.season,
          episodeNumber: item.episode.number,
          title: item.episode.title,
          watchedAt: item.watched_at,
          source: 'trakt',
          traktHistoryId: item.id,
        })
        .onConflictDoNothing();

      // Conflict on idx_episodes_unique: an existing row with the same
      // show/season/episode/timestamp — typically a Plex-sourced
      // duplicate — keeps ownership. Count the event as skipped and emit
      // no feed item. Its traktHistoryId is never recorded, so the window
      // may be re-scanned; the per-page dedup tolerates that.
      if (insertResult.meta.changes === 0) {
        skipped++;
        continue;
      }

      newEpisodes.push({
        showId,
        showTitle: item.show.title,
        seasonNumber: item.episode.season,
        episodeNumber: item.episode.number,
        episodeTitle: item.episode.title,
        watchedAt: item.watched_at,
      });
      synced++;
    }
  }

  return { synced, skipped, newEpisodes };
}

/**
 * Map Trakt movie ratings to tmdbId -> rating, skipping unmapped movies.
 */
export function buildRatingsMap(
  ratings: TraktRatingItem[]
): Map<number, number> {
  const map = new Map<number, number>();
  for (const item of ratings) {
    if (item.movie.ids.tmdb) {
      map.set(item.movie.ids.tmdb, item.rating);
    }
  }
  return map;
}

/**
 * Apply Trakt movie ratings to trakt-sourced watch history rows.
 * Returns the number of movies whose rows actually changed. The
 * `IS NOT` predicate is SQLite's null-safe inequality, so rows whose
 * rating is NULL or stale get updated and already-correct rows are
 * left alone — repeat runs apply nothing.
 */
export async function applyMovieRatings(
  db: Database,
  client: TraktClient,
  userId: number
): Promise<number> {
  const ratings = buildRatingsMap(await client.getMovieRatings());
  if (ratings.size === 0) return 0;

  let applied = 0;
  for (const [tmdbId, rating] of ratings) {
    const [movie] = await db
      .select({ id: movies.id })
      .from(movies)
      .where(eq(movies.tmdbId, tmdbId))
      .limit(1);
    if (!movie) continue;

    const result = await db
      .update(watchHistory)
      .set({ userRating: rating })
      .where(
        and(
          eq(watchHistory.userId, userId),
          eq(watchHistory.movieId, movie.id),
          eq(watchHistory.source, 'trakt'),
          sql`${watchHistory.userRating} IS NOT ${rating}`
        )
      );
    if (result.meta.changes > 0) applied++;
  }

  console.log(`[SYNC] Applied ${applied} Trakt movie ratings`);
  return applied;
}

/**
 * Full Trakt watch-history sync: movies, episodes, ratings, stats, feed.
 */
export async function syncTraktHistory(
  env: Env,
  userId: number = 1
): Promise<{ moviesSynced: number; episodesSynced: number }> {
  const db = createDb(env.DB);
  const startedAt = new Date().toISOString();

  const [run] = await db
    .insert(syncRuns)
    .values({
      userId,
      domain: 'watching',
      syncType: 'trakt_history',
      status: 'running',
      startedAt,
      itemsSynced: 0,
    })
    .returning({ id: syncRuns.id });

  try {
    const accessToken = await getAccessToken(env, db);
    const client = new TraktClient(accessToken, env.TRAKT_CLIENT_ID);
    const tmdbClient = new TmdbClient(env.TMDB_API_KEY);

    const movieSync = await syncMovieHistory(db, client, tmdbClient, userId);
    const episodes = await syncEpisodeHistory(db, client, tmdbClient, userId);
    const ratingsApplied = await applyMovieRatings(db, client, userId);

    await computeWatchStats(db);

    await db
      .update(syncRuns)
      .set({
        status: 'completed',
        completedAt: new Date().toISOString(),
        itemsSynced: movieSync.synced + episodes.synced,
        metadata: JSON.stringify({
          moviesSynced: movieSync.synced,
          moviesSkipped: movieSync.skipped,
          episodesSynced: episodes.synced,
          episodesSkipped: episodes.skipped,
          ratingsApplied,
        }),
      })
      .where(eq(syncRuns.id, run.id));

    const feedItems: FeedItem[] = [
      ...movieSync.newWatches.map(buildMovieFeedItem),
      ...episodes.newEpisodes.map(buildEpisodeFeedItem),
    ];
    const searchItems: SearchItem[] = movieSync.newWatches.map((m) => ({
      domain: 'watching',
      entityType: 'movie',
      entityId: String(m.movieId),
      title: m.title,
      subtitle: m.year ? String(m.year) : undefined,
    }));
    await afterSync(db, { domain: 'watching', feedItems, searchItems });

    console.log(
      `[SYNC] Trakt history sync complete: ${movieSync.synced} movies, ${episodes.synced} episodes, ${movieSync.skipped + episodes.skipped} skipped`
    );
    return { moviesSynced: movieSync.synced, episodesSynced: episodes.synced };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] Trakt history sync failed: ${errorMsg}`);
    await db
      .update(syncRuns)
      .set({
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: errorMsg,
      })
      .where(eq(syncRuns.id, run.id));
    throw err;
  }
}
