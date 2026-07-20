import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { asc, eq, sql } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import {
  movies,
  directors,
  movieDirectors,
  watchHistory,
  shows,
  episodesWatched,
} from '../../db/schema/watching.js';
import { setupTestDb } from '../../test-helpers.js';
import {
  syncTraktHistory,
  syncMovieHistory,
  syncEpisodeHistory,
  buildMovieFeedItem,
  buildEpisodeFeedItem,
  buildRatingsMap,
  applyMovieRatings,
  shouldMarkRewatch,
} from './history-sync.js';
import type {
  TraktClient,
  TraktHistoryMovieItem,
  TraktHistoryEpisodeItem,
  TraktHistoryOptions,
  TraktRatingItem,
} from './client.js';
import type { TmdbClient } from '../watching/tmdb.js';

describe('syncTraktHistory', () => {
  it('exports the sync entrypoint', () => {
    expect(typeof syncTraktHistory).toBe('function');
  });
});

describe('syncMovieHistory', () => {
  // TMDB must never be reached: movies are pre-seeded by tmdbId with full
  // metadata and directors, so resolveMovie short-circuits in the DB.
  const tmdbStub = {
    searchMovie: async () => {
      throw new Error('TMDB searchMovie should not be called');
    },
    getMovieDetail: async () => {
      throw new Error('TMDB getMovieDetail should not be called');
    },
  } as unknown as TmdbClient;

  function movieEvent(
    id: number,
    watchedAt: string,
    tmdbId: number,
    title: string,
    year: number
  ): TraktHistoryMovieItem {
    return {
      id,
      watched_at: watchedAt,
      action: 'watch',
      type: 'movie',
      movie: {
        title,
        year,
        ids: { trakt: id, slug: 'slug', imdb: 'tt0000000', tmdb: tmdbId },
      },
    };
  }

  // Trakt returns history newest-first: page 1 holds the newest events.
  // Fight Club (tmdb 550) is watched twice, split across the two pages.
  const pages: TraktHistoryMovieItem[][] = [
    [movieEvent(1003, '2026-05-01T21:00:00.000Z', 550, 'Fight Club', 1999)],
    [
      movieEvent(1002, '2025-03-10T19:00:00.000Z', 603, 'The Matrix', 1999),
      movieEvent(1001, '2024-01-05T20:00:00.000Z', 550, 'Fight Club', 1999),
    ],
  ];

  function makeClient(fixture: TraktHistoryMovieItem[][]): TraktClient {
    return {
      getMovieHistory: async (options: { page?: number } = {}) => {
        const page = options.page ?? 1;
        return {
          items: fixture[page - 1] ?? [],
          page,
          pageCount: fixture.length,
        };
      },
    } as unknown as TraktClient;
  }

  beforeAll(async () => {
    await setupTestDb();
    const db = createDb(env.DB);

    // Pre-seed the movies referenced by the fake history so resolveMovie
    // finds them by tmdbId without any TMDB fetch. Full metadata plus a
    // director row also keeps the TMDB backfill path dormant.
    const [fightClub] = await db
      .insert(movies)
      .values({
        title: 'Fight Club',
        year: 1999,
        tmdbId: 550,
        contentRating: 'R',
        tmdbRating: 8.4,
      })
      .returning({ id: movies.id });
    const [matrix] = await db
      .insert(movies)
      .values({
        title: 'The Matrix',
        year: 1999,
        tmdbId: 603,
        contentRating: 'R',
        tmdbRating: 8.2,
      })
      .returning({ id: movies.id });

    const [fincher] = await db
      .insert(directors)
      .values({ name: 'David Fincher' })
      .returning({ id: directors.id });
    const [wachowski] = await db
      .insert(directors)
      .values({ name: 'Lana Wachowski' })
      .returning({ id: directors.id });
    await db.insert(movieDirectors).values([
      { movieId: fightClub.id, directorId: fincher.id },
      { movieId: matrix.id, directorId: wachowski.id },
    ]);
  });

  it('backfills a two-page newest-first history chronologically with correct rewatch flags', async () => {
    const db = createDb(env.DB);
    const result = await syncMovieHistory(db, makeClient(pages), tmdbStub, 1);

    expect(result.synced).toBe(3);

    const rows = await db
      .select({
        traktHistoryId: watchHistory.traktHistoryId,
        watchedAt: watchHistory.watchedAt,
        rewatch: watchHistory.rewatch,
      })
      .from(watchHistory)
      .orderBy(asc(watchHistory.id));

    // Insert order is chronological despite newest-first pages
    expect(rows.map((r) => r.traktHistoryId)).toEqual([1001, 1002, 1003]);
    expect(rows.map((r) => r.watchedAt)).toEqual([
      '2024-01-05T20:00:00.000Z',
      '2025-03-10T19:00:00.000Z',
      '2026-05-01T21:00:00.000Z',
    ]);

    // First Fight Club watch is not a rewatch; the later one is
    expect(rows[0].rewatch).toBe(0);
    expect(rows[1].rewatch).toBe(0);
    expect(rows[2].rewatch).toBe(1);
  });

  it('is idempotent: re-running the same sync inserts nothing new', async () => {
    const db = createDb(env.DB);
    const client = makeClient(pages);

    const firstRun = await syncMovieHistory(db, client, tmdbStub, 1);
    expect(firstRun.synced).toBe(3);

    const secondRun = await syncMovieHistory(db, client, tmdbStub, 1);
    expect(secondRun.synced).toBe(0);
    expect(secondRun.newWatches).toEqual([]);

    const [row] = await db
      .select({ total: sql<number>`count(*)` })
      .from(watchHistory)
      .where(eq(watchHistory.source, 'trakt'));
    expect(row.total).toBe(3);
  });

  it('advances the cursor to the newest event after a completed run', async () => {
    const db = createDb(env.DB);
    await syncMovieHistory(db, makeClient(pages), tmdbStub, 1);

    const [row] = await db
      .select({ max: sql<string | null>`max(${watchHistory.watchedAt})` })
      .from(watchHistory)
      .where(eq(watchHistory.source, 'trakt'));
    expect(row.max).toBe('2026-05-01T21:00:00.000Z');
  });

  it('pins the walk with endAt and fetches a single-page history exactly once', async () => {
    const db = createDb(env.DB);
    const seen: TraktHistoryOptions[] = [];
    const client = {
      getMovieHistory: async (options: TraktHistoryOptions = {}) => {
        seen.push(options);
        return { items: [], page: options.page ?? 1, pageCount: 1 };
      },
    } as unknown as TraktClient;

    await syncMovieHistory(db, client, tmdbStub, 1);

    // Single-page (incremental cron) path costs one Trakt call, not two
    expect(seen).toHaveLength(1);
    // The walk window is pinned to the sync start on every request
    expect(typeof seen[0].endAt).toBe('string');
  });

  it('full=true skips the cursor while a normal run passes it', async () => {
    const db = createDb(env.DB);

    // Seed trakt-sourced history so an incremental cursor exists
    await syncMovieHistory(db, makeClient(pages), tmdbStub, 1);

    const seen: TraktHistoryOptions[] = [];
    const recording = {
      getMovieHistory: async (options: TraktHistoryOptions = {}) => {
        seen.push(options);
        return { items: [], page: options.page ?? 1, pageCount: 1 };
      },
    } as unknown as TraktClient;

    // Normal run: the walk starts from the cursor (newest trakt watchedAt)
    await syncMovieHistory(db, recording, tmdbStub, 1);
    expect(seen[0].startAt).toBe('2026-05-01T21:00:00.000Z');

    // full=true: cursor-less full re-walk, endAt pinning stays
    seen.length = 0;
    await syncMovieHistory(db, recording, tmdbStub, 1, { full: true });
    expect(seen[0].startAt).toBeUndefined();
    expect(typeof seen[0].endAt).toBe('string');
  });

  it('resumes an interrupted backfill from the cursor without gaps', async () => {
    const db = createDb(env.DB);

    // Newest-first flat history: Fight Club is watched first and last
    const all: TraktHistoryMovieItem[] = [
      movieEvent(2003, '2026-06-01T21:00:00.000Z', 550, 'Fight Club', 1999),
      movieEvent(2002, '2025-06-01T19:00:00.000Z', 603, 'The Matrix', 1999),
      movieEvent(2001, '2024-06-01T20:00:00.000Z', 550, 'Fight Club', 1999),
    ];

    // One event per page; the walk goes 3 -> 2 -> 1 and dies fetching page 2
    const failing = {
      getMovieHistory: async (options: TraktHistoryOptions = {}) => {
        const page = options.page ?? 1;
        if (page === 2) throw new Error('Trakt 502 mid-walk');
        return { items: [all[page - 1]], page, pageCount: 3 };
      },
    } as unknown as TraktClient;

    await expect(syncMovieHistory(db, failing, tmdbStub, 1)).rejects.toThrow(
      'mid-walk'
    );

    // Only the oldest (page 3) event landed before the failure
    const partial = await db
      .select({ traktHistoryId: watchHistory.traktHistoryId })
      .from(watchHistory)
      .where(eq(watchHistory.source, 'trakt'));
    expect(partial.map((r) => r.traktHistoryId)).toEqual([2001]);

    // Cursor covers only completed work: the newest inserted timestamp
    const [cursor] = await db
      .select({ max: sql<string | null>`max(${watchHistory.watchedAt})` })
      .from(watchHistory)
      .where(eq(watchHistory.source, 'trakt'));
    expect(cursor.max).toBe('2024-06-01T20:00:00.000Z');

    // Resumed run: fake Trakt filters by start_at (inclusive) like the API
    const resumed = {
      getMovieHistory: async (options: TraktHistoryOptions = {}) => {
        const filtered = options.startAt
          ? all.filter((item) => item.watched_at >= options.startAt!)
          : all;
        return { items: filtered, page: options.page ?? 1, pageCount: 1 };
      },
    } as unknown as TraktClient;

    const result = await syncMovieHistory(db, resumed, tmdbStub, 1);
    expect(result.synced).toBe(2);
    expect(result.skipped).toBe(1); // cursor-boundary event deduped

    const rows = await db
      .select({
        traktHistoryId: watchHistory.traktHistoryId,
        rewatch: watchHistory.rewatch,
      })
      .from(watchHistory)
      .orderBy(asc(watchHistory.id));
    expect(rows.map((r) => r.traktHistoryId)).toEqual([2001, 2002, 2003]);
    expect(rows.map((r) => r.rewatch)).toEqual([0, 0, 1]);
  });
});

describe('syncEpisodeHistory', () => {
  // Shows are pre-seeded by tmdbId, so ensureShow short-circuits in the DB
  // and TMDB must never be reached.
  const tmdbStub = {
    getTvShowDetail: async () => {
      throw new Error('TMDB getTvShowDetail should not be called');
    },
  } as unknown as TmdbClient;

  function episodeEvent(
    id: number,
    watchedAt: string,
    season: number,
    number: number,
    title: string
  ): TraktHistoryEpisodeItem {
    return {
      id,
      watched_at: watchedAt,
      action: 'watch',
      type: 'episode',
      episode: { season, number, title, ids: { trakt: id, tmdb: null } },
      show: {
        title: 'Severance',
        year: 2022,
        ids: { trakt: 333, slug: 'severance', imdb: 'tt11280740', tmdb: 95396 },
      },
    };
  }

  // Trakt returns history newest-first: page 1 holds the newest events.
  // The same show repeats across both pages.
  const pages: TraktHistoryEpisodeItem[][] = [
    [episodeEvent(3003, '2026-06-03T21:00:00.000Z', 2, 1, 'Hello, Ms. Cobel')],
    [
      episodeEvent(3002, '2026-06-02T21:00:00.000Z', 1, 2, 'Half Loop'),
      episodeEvent(3001, '2026-06-01T21:00:00.000Z', 1, 1, 'Good News'),
    ],
  ];

  function makeClient(fixture: TraktHistoryEpisodeItem[][]): TraktClient {
    return {
      getEpisodeHistory: async (options: TraktHistoryOptions = {}) => {
        const page = options.page ?? 1;
        return {
          items: fixture[page - 1] ?? [],
          page,
          pageCount: fixture.length,
        };
      },
    } as unknown as TraktClient;
  }

  beforeAll(async () => {
    await setupTestDb();
    const db = createDb(env.DB);
    await db.insert(shows).values({
      title: 'Severance',
      year: 2022,
      tmdbId: 95396,
      traktId: 333,
      contentRating: 'TV-MA',
      tmdbRating: 8.7,
      totalSeasons: 2,
      totalEpisodes: 19,
    });
  });

  it('backfills a two-page newest-first history chronologically', async () => {
    const db = createDb(env.DB);
    const result = await syncEpisodeHistory(db, makeClient(pages), tmdbStub, 1);

    expect(result.synced).toBe(3);
    expect(result.skipped).toBe(0);

    const [show] = await db
      .select({ id: shows.id })
      .from(shows)
      .where(eq(shows.tmdbId, 95396));

    const rows = await db
      .select({
        traktHistoryId: episodesWatched.traktHistoryId,
        watchedAt: episodesWatched.watchedAt,
        showId: episodesWatched.showId,
        seasonNumber: episodesWatched.seasonNumber,
        episodeNumber: episodesWatched.episodeNumber,
        source: episodesWatched.source,
      })
      .from(episodesWatched)
      .orderBy(asc(episodesWatched.id));

    // Insert order is chronological despite newest-first pages
    expect(rows.map((r) => r.traktHistoryId)).toEqual([3001, 3002, 3003]);
    expect(rows.map((r) => r.watchedAt)).toEqual([
      '2026-06-01T21:00:00.000Z',
      '2026-06-02T21:00:00.000Z',
      '2026-06-03T21:00:00.000Z',
    ]);
    expect(rows.every((r) => r.showId === show.id)).toBe(true);
    expect(rows.every((r) => r.source === 'trakt')).toBe(true);
    expect(rows[2].seasonNumber).toBe(2);
    expect(rows[2].episodeNumber).toBe(1);
  });

  it('is idempotent: re-running the same sync inserts nothing new', async () => {
    const db = createDb(env.DB);
    const client = makeClient(pages);

    const firstRun = await syncEpisodeHistory(db, client, tmdbStub, 1);
    expect(firstRun.synced).toBe(3);

    const secondRun = await syncEpisodeHistory(db, client, tmdbStub, 1);
    expect(secondRun.synced).toBe(0);
    expect(secondRun.newEpisodes).toEqual([]);

    const [row] = await db
      .select({ total: sql<number>`count(*)` })
      .from(episodesWatched)
      .where(eq(episodesWatched.source, 'trakt'));
    expect(row.total).toBe(3);
  });

  it('advances the cursor to the newest event after a completed run', async () => {
    const db = createDb(env.DB);
    await syncEpisodeHistory(db, makeClient(pages), tmdbStub, 1);

    const [row] = await db
      .select({ max: sql<string | null>`max(${episodesWatched.watchedAt})` })
      .from(episodesWatched)
      .where(eq(episodesWatched.source, 'trakt'));
    expect(row.max).toBe('2026-06-03T21:00:00.000Z');
  });

  it('skips events whose show has no TMDb id', async () => {
    const db = createDb(env.DB);
    const noTmdb = episodeEvent(3100, '2026-06-04T21:00:00.000Z', 1, 1, 'Lost');
    noTmdb.show = {
      title: 'Obscure Show',
      year: null,
      ids: { trakt: 999, slug: 'obscure', imdb: '', tmdb: 0 },
    };

    const result = await syncEpisodeHistory(
      db,
      makeClient([[noTmdb]]),
      tmdbStub,
      1
    );

    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('creates a TMDB-enriched show row once for unseen shows', async () => {
    const db = createDb(env.DB);
    let tmdbCalls = 0;
    const tmdbFake = {
      getTvShowDetail: async (tmdbId: number) => {
        tmdbCalls++;
        return {
          id: tmdbId,
          title: 'The Rehearsal',
          year: 2022,
          summary: 'Nathan Fielder helps people rehearse.',
          posterPath: '/poster.jpg',
          backdropPath: '/backdrop.jpg',
          contentRating: 'TV-MA',
          tmdbRating: 8.1,
          totalSeasons: 2,
          totalEpisodes: 14,
        };
      },
    } as unknown as TmdbClient;

    const showIds = {
      trakt: 444,
      slug: 'the-rehearsal',
      imdb: 'tt10788510',
      tmdb: 999,
    };
    const first = episodeEvent(3201, '2026-06-05T21:00:00.000Z', 1, 1, 'Or');
    first.show = { title: 'Rehearsal (Trakt name)', year: 2021, ids: showIds };
    const second = episodeEvent(3202, '2026-06-06T21:00:00.000Z', 1, 2, 'Sca');
    second.show = { title: 'Rehearsal (Trakt name)', year: 2021, ids: showIds };

    const result = await syncEpisodeHistory(
      db,
      makeClient([[second, first]]),
      tmdbFake,
      1
    );

    expect(result.synced).toBe(2);
    // Per-run cache: one TMDB lookup, one show row
    expect(tmdbCalls).toBe(1);

    const created = await db
      .select({
        title: shows.title,
        year: shows.year,
        traktId: shows.traktId,
        tmdbRating: shows.tmdbRating,
        totalEpisodes: shows.totalEpisodes,
      })
      .from(shows)
      .where(eq(shows.tmdbId, 999));
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('The Rehearsal');
    expect(created[0].year).toBe(2022);
    expect(created[0].traktId).toBe(444);
    expect(created[0].tmdbRating).toBe(8.1);
    expect(created[0].totalEpisodes).toBe(14);

    const episodes = await db
      .select({ traktHistoryId: episodesWatched.traktHistoryId })
      .from(episodesWatched)
      .orderBy(asc(episodesWatched.id));
    expect(episodes.map((e) => e.traktHistoryId)).toEqual([3201, 3202]);
  });

  it('pins the walk with endAt and fetches a single-page history exactly once', async () => {
    const db = createDb(env.DB);
    const seen: TraktHistoryOptions[] = [];
    const client = {
      getEpisodeHistory: async (options: TraktHistoryOptions = {}) => {
        seen.push(options);
        return { items: [], page: options.page ?? 1, pageCount: 1 };
      },
    } as unknown as TraktClient;

    await syncEpisodeHistory(db, client, tmdbStub, 1);

    expect(seen).toHaveLength(1);
    expect(typeof seen[0].endAt).toBe('string');
  });

  it('full=true skips the cursor while a normal run passes it', async () => {
    const db = createDb(env.DB);

    // Seed trakt-sourced history so an incremental cursor exists
    await syncEpisodeHistory(db, makeClient(pages), tmdbStub, 1);

    const seen: TraktHistoryOptions[] = [];
    const recording = {
      getEpisodeHistory: async (options: TraktHistoryOptions = {}) => {
        seen.push(options);
        return { items: [], page: options.page ?? 1, pageCount: 1 };
      },
    } as unknown as TraktClient;

    // Normal run: the walk starts from the cursor (newest trakt watchedAt)
    await syncEpisodeHistory(db, recording, tmdbStub, 1);
    expect(seen[0].startAt).toBe('2026-06-03T21:00:00.000Z');

    // full=true: cursor-less full re-walk, endAt pinning stays
    seen.length = 0;
    await syncEpisodeHistory(db, recording, tmdbStub, 1, { full: true });
    expect(seen[0].startAt).toBeUndefined();
    expect(typeof seen[0].endAt).toBe('string');
  });

  it('counts a Plex-owned duplicate timestamp as skipped without a feed item', async () => {
    const db = createDb(env.DB);
    const [show] = await db
      .select({ id: shows.id })
      .from(shows)
      .where(eq(shows.tmdbId, 95396));

    // Plex-sourced row identical on show/season/episode/timestamp to the
    // oldest incoming Trakt event (3001, S01E01 at 2026-06-01)
    await db.insert(episodesWatched).values({
      showId: show.id,
      seasonNumber: 1,
      episodeNumber: 1,
      watchedAt: '2026-06-01T21:00:00.000Z',
      source: 'plex',
    });

    const result = await syncEpisodeHistory(db, makeClient(pages), tmdbStub, 1);

    // The colliding event no-ops: counted as skipped, not synced
    expect(result.synced).toBe(2);
    expect(result.skipped).toBe(1);

    // No feed item for the row that was never written
    expect(result.newEpisodes).toHaveLength(2);
    expect(
      result.newEpisodes.some((e) => e.watchedAt === '2026-06-01T21:00:00.000Z')
    ).toBe(false);

    // No duplicate row: the Plex row keeps ownership of the timestamp
    const dupes = await db
      .select({
        source: episodesWatched.source,
        traktHistoryId: episodesWatched.traktHistoryId,
      })
      .from(episodesWatched)
      .where(eq(episodesWatched.watchedAt, '2026-06-01T21:00:00.000Z'));
    expect(dupes).toHaveLength(1);
    expect(dupes[0].source).toBe('plex');
    expect(dupes[0].traktHistoryId).toBeNull();
  });

  it('attaches to an existing show found by traktId when the TMDB mapping changed', async () => {
    const db = createDb(env.DB);

    // Prior run stored this show under a different tmdbId (mapping churn)
    const [existing] = await db
      .insert(shows)
      .values({
        title: 'Severance (old mapping)',
        year: 2022,
        tmdbId: 111111,
        traktId: 555,
      })
      .returning({ id: shows.id });

    const ev = episodeEvent(3300, '2026-06-07T21:00:00.000Z', 1, 3, 'In P.');
    ev.show = {
      title: 'Severance',
      year: 2022,
      ids: { trakt: 555, slug: 'severance', imdb: 'tt11280740', tmdb: 222222 },
    };

    // tmdbStub throws on getTvShowDetail, so reaching the insert path here
    // would also fail the test before the unique violation could
    const result = await syncEpisodeHistory(
      db,
      makeClient([[ev]]),
      tmdbStub,
      1
    );
    expect(result.synced).toBe(1);

    // No new shows row was created for the new tmdbId
    const byNewTmdb = await db
      .select({ id: shows.id })
      .from(shows)
      .where(eq(shows.tmdbId, 222222));
    expect(byNewTmdb).toHaveLength(0);

    // The episode attached to the existing show, whose tmdbId is untouched
    const [episode] = await db
      .select({ showId: episodesWatched.showId })
      .from(episodesWatched)
      .where(eq(episodesWatched.traktHistoryId, 3300));
    expect(episode.showId).toBe(existing.id);

    const [kept] = await db
      .select({ tmdbId: shows.tmdbId })
      .from(shows)
      .where(eq(shows.id, existing.id));
    expect(kept.tmdbId).toBe(111111);
  });
});

describe('buildEpisodeFeedItem', () => {
  it('builds an episode_watched feed item with SxxExx code', () => {
    const item = buildEpisodeFeedItem({
      showId: 5,
      showTitle: 'Severance',
      seasonNumber: 2,
      episodeNumber: 3,
      episodeTitle: 'Who Is Alive?',
      watchedAt: '2026-06-03T21:00:00.000Z',
    });
    expect(item.eventType).toBe('episode_watched');
    expect(item.title).toBe('Watched Severance S02E03');
    expect(item.sourceId).toBe('trakt:episode:5:2:3:2026-06-03');
  });
});

describe('buildMovieFeedItem', () => {
  it('builds a movie_watched feed item with trakt source id', () => {
    const item = buildMovieFeedItem({
      movieId: 42,
      title: 'Heat',
      year: 1995,
      watchedAt: '2026-06-01T20:00:00.000Z',
    });
    expect(item.domain).toBe('watching');
    expect(item.eventType).toBe('movie_watched');
    expect(item.title).toBe('Watched Heat (1995)');
    expect(item.sourceId).toBe('trakt:movie:42:2026-06-01');
    expect(item.occurredAt).toBe('2026-06-01T20:00:00.000Z');
  });

  it('omits year when null', () => {
    const item = buildMovieFeedItem({
      movieId: 7,
      title: 'Unknown Film',
      year: null,
      watchedAt: '2026-06-02T10:00:00.000Z',
    });
    expect(item.title).toBe('Watched Unknown Film');
  });
});

describe('buildRatingsMap', () => {
  it('maps tmdb id to rating, skipping items without tmdb ids', () => {
    const map = buildRatingsMap([
      {
        rated_at: '2026-01-01T00:00:00.000Z',
        rating: 9,
        type: 'movie',
        movie: {
          title: 'Heat',
          year: 1995,
          ids: { trakt: 1, slug: 'heat', imdb: 'tt0113277', tmdb: 949 },
        },
      },
      {
        rated_at: '2026-01-02T00:00:00.000Z',
        rating: 7,
        type: 'movie',
        movie: {
          title: 'No Id',
          year: 2000,
          ids: { trakt: 2, slug: 'no-id', imdb: '', tmdb: 0 },
        },
      },
    ]);
    expect(map.get(949)).toBe(9);
    expect(map.size).toBe(1);
  });
});

describe('applyMovieRatings', () => {
  let heatId: number;
  let collateralId: number;

  function ratingItem(tmdbId: number, rating: number): TraktRatingItem {
    return {
      rated_at: '2026-06-01T00:00:00.000Z',
      rating,
      type: 'movie',
      movie: {
        title: 'Rated Movie',
        year: 1995,
        ids: { trakt: tmdbId, slug: 'slug', imdb: 'tt0000000', tmdb: tmdbId },
      },
    };
  }

  function makeClient(ratings: TraktRatingItem[]): TraktClient {
    return {
      getMovieRatings: async () => ratings,
    } as unknown as TraktClient;
  }

  beforeAll(async () => {
    await setupTestDb();
    const db = createDb(env.DB);
    const [heat] = await db
      .insert(movies)
      .values({ title: 'Heat', year: 1995, tmdbId: 949 })
      .returning({ id: movies.id });
    const [collateral] = await db
      .insert(movies)
      .values({ title: 'Collateral', year: 2004, tmdbId: 1538 })
      .returning({ id: movies.id });
    heatId = heat.id;
    collateralId = collateral.id;
  });

  it('applies ratings to trakt rows only, leaving unrated movies untouched', async () => {
    const db = createDb(env.DB);
    await db.insert(watchHistory).values([
      {
        movieId: heatId,
        watchedAt: '2024-01-05T20:00:00.000Z',
        source: 'trakt',
        traktHistoryId: 5001,
      },
      {
        movieId: heatId,
        watchedAt: '2026-05-01T21:00:00.000Z',
        source: 'trakt',
        traktHistoryId: 5002,
        rewatch: 1,
      },
      // Letterboxd row for the same movie keeps its own rating untouched
      {
        movieId: heatId,
        watchedAt: '2025-02-01T20:00:00.000Z',
        source: 'letterboxd',
        userRating: 4.5,
      },
      // Trakt row for a movie with no Trakt rating stays null
      {
        movieId: collateralId,
        watchedAt: '2026-03-01T20:00:00.000Z',
        source: 'trakt',
        traktHistoryId: 5003,
      },
    ]);

    const applied = await applyMovieRatings(
      db,
      makeClient([ratingItem(949, 9)]),
      1
    );
    expect(applied).toBe(1);

    const rows = await db
      .select({
        source: watchHistory.source,
        movieId: watchHistory.movieId,
        userRating: watchHistory.userRating,
      })
      .from(watchHistory)
      .orderBy(asc(watchHistory.id));

    const traktHeatRows = rows.filter(
      (r) => r.source === 'trakt' && r.movieId === heatId
    );
    expect(traktHeatRows).toHaveLength(2);
    expect(traktHeatRows.every((r) => r.userRating === 9)).toBe(true);

    const letterboxdRow = rows.find((r) => r.source === 'letterboxd');
    expect(letterboxdRow?.userRating).toBe(4.5);

    const unratedRow = rows.find((r) => r.movieId === collateralId);
    expect(unratedRow?.userRating).toBeNull();
  });

  it('is idempotent: a second run applies nothing new', async () => {
    const db = createDb(env.DB);
    await db.insert(watchHistory).values({
      movieId: heatId,
      watchedAt: '2024-01-05T20:00:00.000Z',
      source: 'trakt',
      traktHistoryId: 5101,
    });
    const client = makeClient([ratingItem(949, 9)]);

    const firstRun = await applyMovieRatings(db, client, 1);
    expect(firstRun).toBe(1);

    const secondRun = await applyMovieRatings(db, client, 1);
    expect(secondRun).toBe(0);

    const [row] = await db
      .select({ userRating: watchHistory.userRating })
      .from(watchHistory)
      .where(eq(watchHistory.traktHistoryId, 5101));
    expect(row.userRating).toBe(9);
  });
});

describe('shouldMarkRewatch', () => {
  it('is a rewatch when an earlier watch exists', () => {
    expect(shouldMarkRewatch(1)).toBe(true);
    expect(shouldMarkRewatch(3)).toBe(true);
  });

  it('is not a rewatch for the first watch', () => {
    expect(shouldMarkRewatch(0)).toBe(false);
  });
});
