import { eq, sql, count } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  movies,
  watchHistory,
  watchStats,
  plexShows,
  plexEpisodesWatched,
} from '../../db/schema/watching.js';
import { syncRuns } from '../../db/schema/system.js';
import { TmdbClient, resolveTmdbId } from '../watching/tmdb.js';
import { upsertMovieFromPlex } from './webhook.js';
import { afterSync } from '../../lib/after-sync.js';
import type { FeedItem, SearchItem } from '../../lib/after-sync.js';

interface PlexLibrarySection {
  key: string;
  type: string;
  title: string;
}

interface PlexMediaItem {
  ratingKey: string;
  type: string;
  title: string;
  year?: number;
  summary?: string;
  contentRating?: string;
  duration?: number;
  rating?: number;
  audienceRating?: number;
  viewCount?: number;
  lastViewedAt?: number;
  thumb?: string;
  art?: string;
  Guid?: { id: string }[];
  Genre?: { tag: string }[];
  Director?: { tag: string }[];
  grandparentRatingKey?: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
}

interface PlexApiResponse<T> {
  MediaContainer: {
    Metadata?: T[];
    Directory?: T[];
    size?: number;
  };
}

/**
 * Plex API client for library scanning.
 */
class PlexApiClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetch(
      `${url}${separator}X-Plex-Token=${this.token}`,
      {
        headers: {
          Accept: 'application/json',
          'X-Plex-Client-Identifier': 'rewind-api',
          'X-Plex-Product': 'Rewind',
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `[ERROR] Plex API error: ${response.status} ${response.statusText} for ${path}`
      );
    }

    return response.json() as Promise<T>;
  }

  async getLibrarySections(): Promise<PlexLibrarySection[]> {
    const data =
      await this.request<PlexApiResponse<PlexLibrarySection>>(
        '/library/sections'
      );
    return data.MediaContainer.Directory || [];
  }

  async getWatchedItems(
    sectionKey: string,
    type: 'movie' | 'show'
  ): Promise<PlexMediaItem[]> {
    const typeParam = type === 'movie' ? '' : '&type=4'; // type=4 is episodes
    const path =
      type === 'movie'
        ? `/library/sections/${sectionKey}/all?sort=lastViewedAt:desc&unwatched=0`
        : `/library/sections/${sectionKey}/all?sort=lastViewedAt:desc&unwatched=0${typeParam}`;

    const data = await this.request<PlexApiResponse<PlexMediaItem>>(path);
    return data.MediaContainer.Metadata || [];
  }

  async getItemDetail(ratingKey: string): Promise<PlexMediaItem | null> {
    try {
      const data = await this.request<PlexApiResponse<PlexMediaItem>>(
        `/library/metadata/${ratingKey}`
      );
      const items = data.MediaContainer.Metadata || [];
      return items[0] || null;
    } catch {
      return null;
    }
  }

  async getShowEpisodes(showRatingKey: string): Promise<PlexMediaItem[]> {
    const data = await this.request<PlexApiResponse<PlexMediaItem>>(
      `/library/metadata/${showRatingKey}/allLeaves`
    );
    return (data.MediaContainer.Metadata || []).filter(
      (ep) => ep.viewCount && ep.viewCount > 0
    );
  }
}

/**
 * Sync watched movies from Plex library.
 */
interface SyncedMovie {
  movieId: number;
  title: string;
  year: number | null;
  watchedAt: string;
}

async function syncMovies(
  db: Database,
  plexClient: PlexApiClient,
  tmdbClient: TmdbClient,
  sectionKey: string,
  maxNewItems: number = 0
): Promise<{ count: number; items: SyncedMovie[] }> {
  const watchedItems = await plexClient.getWatchedItems(sectionKey, 'movie');
  let synced = 0;
  let newItemsProcessed = 0;
  const syncedItems: SyncedMovie[] = [];

  for (const item of watchedItems) {
    // Respect batch limit to stay within subrequest limits
    if (maxNewItems > 0 && newItemsProcessed >= maxNewItems) {
      console.log(
        `[SYNC] Movie batch limit reached (${maxNewItems}), stopping. ${synced} synced this run.`
      );
      break;
    }

    // Check if already tracked by plex_rating_key
    const existing = await db
      .select({ id: movies.id })
      .from(movies)
      .where(eq(movies.plexRatingKey, item.ratingKey))
      .limit(1);

    if (existing.length > 0) {
      // Count existing watch history entries for this movie
      const [watchCount] = await db
        .select({ count: count() })
        .from(watchHistory)
        .where(eq(watchHistory.movieId, existing[0].id));

      // Only insert a new watch if Plex viewCount exceeds recorded watches
      const plexViewCount = item.viewCount ?? 1;
      if (watchCount.count >= plexViewCount) {
        continue; // All watches already recorded
      }
    }

    newItemsProcessed++;

    // Get detailed metadata with Guids
    const detail = await plexClient.getItemDetail(item.ratingKey);
    if (!detail) continue;

    const metadata = {
      ratingKey: detail.ratingKey,
      type: 'movie' as const,
      librarySectionType: 'movie',
      title: detail.title,
      year: detail.year,
      summary: detail.summary,
      contentRating: detail.contentRating,
      duration: detail.duration,
      thumb: detail.thumb,
      art: detail.art,
      Guid: detail.Guid || [],
      Genre: detail.Genre?.map((g) => ({ tag: g.tag })) || [],
      Director: detail.Director?.map((d) => ({ tag: d.tag })) || [],
    };

    const movieId = await upsertMovieFromPlex(db, metadata, tmdbClient);

    // Determine watched date from Plex lastViewedAt
    const watchedAt = detail.lastViewedAt
      ? new Date(detail.lastViewedAt * 1000).toISOString()
      : new Date().toISOString();

    // Count existing watches for the resolved movie (may differ from
    // plex_rating_key lookup above if the movie was matched via TMDB)
    const [existingWatchCount] = await db
      .select({ count: count() })
      .from(watchHistory)
      .where(eq(watchHistory.movieId, movieId));

    const plexViewCount = item.viewCount ?? 1;
    if (existingWatchCount.count >= plexViewCount) {
      continue; // All watches already recorded
    }

    await db.insert(watchHistory).values({
      movieId,
      watchedAt,
      source: 'plex',
      percentComplete: 100,
    });
    syncedItems.push({
      movieId,
      title: detail.title,
      year: detail.year ?? null,
      watchedAt,
    });
    synced++;
  }

  return { count: synced, items: syncedItems };
}

/**
 * Sync watched TV shows from Plex library.
 */
async function syncShows(
  db: Database,
  plexClient: PlexApiClient,
  tmdbClient: TmdbClient,
  sectionKey: string,
  maxNewItems: number = 0
): Promise<number> {
  const sections = await plexClient.getWatchedItems(sectionKey, 'show');
  let synced = 0;
  let newItemsProcessed = 0;
  let episodesProcessed = 0;

  // Cap total episode iterations to avoid exhausting D1 query budget.
  // Paid plan allows many more queries per request.
  const maxEpisodes = 1600;

  // Cache show lookups to reduce DB queries
  const showCache = new Map<string, number>();

  // For TV shows, we need to get the show-level items and then episodes
  // The watched items endpoint with type=4 returns episodes directly
  for (const episode of sections) {
    if (!episode.grandparentRatingKey) continue;

    // Respect episode processing limit for D1 query budget
    if (episodesProcessed >= maxEpisodes) {
      console.log(
        `[SYNC] Episode processing limit reached (${maxEpisodes}), stopping. ${synced} synced this run.`
      );
      break;
    }

    // Respect batch limit to stay within subrequest limits
    if (maxNewItems > 0 && newItemsProcessed >= maxNewItems) {
      console.log(
        `[SYNC] Show batch limit reached (${maxNewItems}), stopping. ${synced} synced this run.`
      );
      break;
    }

    episodesProcessed++;

    // Upsert show (with in-memory cache to avoid repeated DB lookups)
    let showId: number;
    const cachedShowId = showCache.get(episode.grandparentRatingKey);

    if (cachedShowId !== undefined) {
      showId = cachedShowId;
    } else {
      const existingShow = await db
        .select({ id: plexShows.id })
        .from(plexShows)
        .where(eq(plexShows.plexRatingKey, episode.grandparentRatingKey))
        .limit(1);

      if (existingShow.length > 0) {
        showId = existingShow[0].id;
        showCache.set(episode.grandparentRatingKey, showId);
      } else {
        newItemsProcessed++;
        // Get show details
        const showDetail = await plexClient.getItemDetail(
          episode.grandparentRatingKey
        );

        let tmdbId: number | null = null;
        let summary: string | null = null;
        let posterPath: string | null = null;
        let backdropPath: string | null = null;
        let contentRating: string | null = showDetail?.contentRating || null;
        let tmdbRating: number | null = null;
        let year: number | null = showDetail?.year || null;
        let totalSeasons: number | null = null;
        let totalEpisodes: number | null = null;

        if (showDetail?.Guid) {
          const rawTmdbId = resolveTmdbId(showDetail.Guid, tmdbClient);
          tmdbId = await rawTmdbId;
        }

        if (tmdbId) {
          try {
            const tvDetail = await tmdbClient.getTvShowDetail(tmdbId);
            summary = tvDetail.summary;
            posterPath = tvDetail.posterPath;
            backdropPath = tvDetail.backdropPath;
            contentRating = tvDetail.contentRating || contentRating;
            tmdbRating = tvDetail.tmdbRating;
            year = tvDetail.year || year;
            totalSeasons = tvDetail.totalSeasons;
            totalEpisodes = tvDetail.totalEpisodes;
          } catch (error) {
            console.log(
              `[ERROR] TMDB TV enrichment failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }

        const [inserted] = await db
          .insert(plexShows)
          .values({
            plexRatingKey: episode.grandparentRatingKey,
            title: episode.grandparentTitle || episode.title,
            year,
            tmdbId,
            summary,
            posterPath,
            backdropPath,
            contentRating,
            tmdbRating,
            totalSeasons,
            totalEpisodes,
          })
          .returning({ id: plexShows.id });

        showId = inserted.id;
        showCache.set(episode.grandparentRatingKey, showId);
      }
    }

    // Insert episode watch
    const watchedAt = episode.lastViewedAt
      ? new Date(episode.lastViewedAt * 1000).toISOString()
      : new Date().toISOString();

    await db
      .insert(plexEpisodesWatched)
      .values({
        showId,
        seasonNumber: episode.parentIndex || 0,
        episodeNumber: episode.index || 0,
        title: episode.title,
        watchedAt,
      })
      .onConflictDoNothing();

    synced++;
  }

  return synced;
}

/**
 * Compute and update watch stats.
 */
export async function computeWatchStats(db: Database): Promise<void> {
  const currentYear = new Date().getFullYear();

  // Total unique movies watched
  const [totalResult] = await db.select({ total: count() }).from(watchHistory);

  // Total watch time (sum of movie runtimes for all watch events)
  const [watchTimeResult] = await db
    .select({
      totalTime: sql<number>`coalesce(sum(${movies.runtime} * 60), 0)`,
    })
    .from(watchHistory)
    .innerJoin(movies, eq(watchHistory.movieId, movies.id));

  // Movies this year
  const [thisYearResult] = await db
    .select({ total: count() })
    .from(watchHistory)
    .where(
      sql`substr(${watchHistory.watchedAt}, 1, 4) = ${String(currentYear)}`
    );

  // TV stats
  const [totalShowsResult] = await db
    .select({ total: count() })
    .from(plexShows);

  const [totalEpisodesResult] = await db
    .select({ total: count() })
    .from(plexEpisodesWatched);

  const [episodesThisYearResult] = await db
    .select({ total: count() })
    .from(plexEpisodesWatched)
    .where(
      sql`substr(${plexEpisodesWatched.watchedAt}, 1, 4) = ${String(currentYear)}`
    );

  // Upsert stats
  const existing = await db
    .select({ id: watchStats.id })
    .from(watchStats)
    .where(eq(watchStats.userId, 1))
    .limit(1);

  const statsValues = {
    totalMovies: totalResult?.total || 0,
    totalWatchTimeS: watchTimeResult?.totalTime || 0,
    moviesThisYear: thisYearResult?.total || 0,
    totalShows: totalShowsResult?.total || 0,
    totalEpisodesWatched: totalEpisodesResult?.total || 0,
    episodesThisYear: episodesThisYearResult?.total || 0,
    updatedAt: new Date().toISOString(),
  };

  if (existing.length > 0) {
    await db
      .update(watchStats)
      .set(statsValues)
      .where(eq(watchStats.id, existing[0].id));
  } else {
    await db.insert(watchStats).values({ userId: 1, ...statsValues });
  }
}

/**
 * Main sync orchestrator for Plex watching domain.
 */
export async function syncWatching(
  db: Database,
  env: {
    PLEX_URL: string;
    PLEX_TOKEN: string;
    TMDB_API_KEY: string;
  },
  options: { maxNewItems?: number } = {}
): Promise<{ moviesSynced: number; showsSynced: number }> {
  const startedAt = new Date().toISOString();

  // Record sync start
  const [syncRun] = await db
    .insert(syncRuns)
    .values({
      domain: 'watching',
      syncType: 'plex_library',
      status: 'running',
      startedAt,
    })
    .returning({ id: syncRuns.id });

  try {
    const plexClient = new PlexApiClient(env.PLEX_URL, env.PLEX_TOKEN);
    const tmdbClient = new TmdbClient(env.TMDB_API_KEY);

    // Get library sections
    const sections = await plexClient.getLibrarySections();
    let moviesSynced = 0;
    let showsSynced = 0;

    // Batch limit per domain to stay within Workers subrequest limits.
    // Paid plan: 1000 subrequests total. ~3 used for section/list calls.
    // Each new item needs ~3 subrequests (Plex detail + TMDB resolve + TMDB detail).
    // Default 150 per domain = ~900 subrequests + ~3 base, safely under 1000.
    const maxNew = options.maxNewItems ?? 150;

    const newMovies: SyncedMovie[] = [];

    for (const section of sections) {
      if (section.type === 'movie') {
        const result = await syncMovies(
          db,
          plexClient,
          tmdbClient,
          section.key,
          maxNew
        );
        moviesSynced += result.count;
        newMovies.push(...result.items);
      } else if (section.type === 'show') {
        const count = await syncShows(
          db,
          plexClient,
          tmdbClient,
          section.key,
          maxNew
        );
        showsSynced += count;
      }
    }

    // Update watch stats
    await computeWatchStats(db);

    // Record sync completion
    await db
      .update(syncRuns)
      .set({
        status: 'completed',
        completedAt: new Date().toISOString(),
        itemsSynced: moviesSynced + showsSynced,
        metadata: JSON.stringify({ moviesSynced, showsSynced }),
      })
      .where(eq(syncRuns.id, syncRun.id));

    // Post-sync: feed, search, revalidation
    const feedItems: FeedItem[] = newMovies.map((m) => ({
      domain: 'watching',
      eventType: 'movie_watched',
      occurredAt: m.watchedAt,
      title: `Watched ${m.title}${m.year ? ` (${m.year})` : ''}`,
      sourceId: `plex:movie:${m.movieId}:${m.watchedAt.substring(0, 10)}`,
    }));
    const searchItems: SearchItem[] = newMovies.map((m) => ({
      domain: 'watching',
      entityType: 'movie',
      entityId: String(m.movieId),
      title: m.title,
      subtitle: m.year ? String(m.year) : undefined,
    }));
    await afterSync(db, { domain: 'watching', feedItems, searchItems });

    console.log(
      `[SYNC] Plex library sync complete: ${moviesSynced} movies, ${showsSynced} episodes synced`
    );
    return { moviesSynced, showsSynced };
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

    console.log(`[ERROR] Plex library sync failed: ${errorMessage}`);
    throw error;
  }
}
