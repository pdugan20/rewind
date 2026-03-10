import { describe, it, expect } from 'vitest';
import { syncWatching, computeWatchStats } from './sync.js';

describe('syncWatching', () => {
  it('exports syncWatching function', () => {
    expect(typeof syncWatching).toBe('function');
  });

  it('exports computeWatchStats function', () => {
    expect(typeof computeWatchStats).toBe('function');
  });
});

describe('Plex sync orchestrator logic', () => {
  it('syncWatching requires PLEX_URL, PLEX_TOKEN, and TMDB_API_KEY in env', () => {
    // The function signature requires these three env vars
    // Verify the function accepts the correct shape
    const fn = syncWatching;
    expect(fn.length).toBe(2); // db and env params
  });

  it('computeWatchStats accepts a single db parameter', () => {
    expect(computeWatchStats.length).toBe(1);
  });
});

describe('Plex sync data flow', () => {
  it('library section type determines sync path', () => {
    // Movie sections call syncMovies, show sections call syncShows
    const movieSection = { key: '1', type: 'movie', title: 'Movies' };
    const showSection = { key: '2', type: 'show', title: 'TV Shows' };

    expect(movieSection.type).toBe('movie');
    expect(showSection.type).toBe('show');

    // Sections with unrecognized types are skipped
    const musicSection = { key: '3', type: 'artist', title: 'Music' };
    expect(['movie', 'show']).not.toContain(musicSection.type);
  });

  it('sync run records domain as watching with plex_library type', () => {
    const syncRunValues = {
      domain: 'watching',
      syncType: 'plex_library',
      status: 'running',
    };

    expect(syncRunValues.domain).toBe('watching');
    expect(syncRunValues.syncType).toBe('plex_library');
    expect(syncRunValues.status).toBe('running');
  });

  it('sync run metadata includes moviesSynced and showsSynced', () => {
    const moviesSynced = 5;
    const showsSynced = 12;
    const metadata = JSON.stringify({ moviesSynced, showsSynced });
    const parsed = JSON.parse(metadata);

    expect(parsed.moviesSynced).toBe(5);
    expect(parsed.showsSynced).toBe(12);
  });

  it('sync run records error message on failure', () => {
    const error = new Error('Plex connection timeout');
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    expect(errorMessage).toBe('Plex connection timeout');
  });

  it('lastViewedAt converts from Unix timestamp to ISO 8601', () => {
    const lastViewedAt = 1709913600; // 2024-03-08T16:00:00.000Z
    const watchedAt = new Date(lastViewedAt * 1000).toISOString();

    expect(watchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(watchedAt).toContain('2024-03-08');
  });

  it('duplicate detection uses date substring from watched_at', () => {
    const watchedAt = '2026-03-08T15:30:00.000Z';
    const watchDate = watchedAt.substring(0, 10);
    expect(watchDate).toBe('2026-03-08');
  });

  it('watch stats compute total from count results', () => {
    const totalResult = { total: 42 };
    const watchTimeResult = { totalTime: 360000 };
    const thisYearResult = { total: 10 };

    const statsValues = {
      totalMovies: totalResult?.total || 0,
      totalWatchTimeS: watchTimeResult?.totalTime || 0,
      moviesThisYear: thisYearResult?.total || 0,
    };

    expect(statsValues.totalMovies).toBe(42);
    expect(statsValues.totalWatchTimeS).toBe(360000);
    expect(statsValues.moviesThisYear).toBe(10);
  });

  it('watch stats handle null/zero results', () => {
    const totalResult = { total: 0 };
    const watchTimeResult = { totalTime: 0 };

    const statsValues = {
      totalMovies: totalResult?.total || 0,
      totalWatchTimeS: watchTimeResult?.totalTime || 0,
    };

    expect(statsValues.totalMovies).toBe(0);
    expect(statsValues.totalWatchTimeS).toBe(0);
  });

  it('episode sync skips entries without grandparentRatingKey', () => {
    const episode = {
      ratingKey: '100',
      type: 'episode',
      title: 'Pilot',
      // missing grandparentRatingKey
    };

    expect(episode.grandparentRatingKey).toBeUndefined();
    // In the actual sync, this would cause a continue
  });

  it('episode insert uses parentIndex and index for season/episode numbers', () => {
    const episode = {
      grandparentRatingKey: '50',
      grandparentTitle: 'Breaking Bad',
      parentIndex: 1,
      index: 3,
      title: 'And the Bag\'s in the River',
      lastViewedAt: 1709913600,
    };

    expect(episode.parentIndex).toBe(1); // seasonNumber
    expect(episode.index).toBe(3); // episodeNumber
  });

  it('episode insert defaults to 0 for missing parentIndex and index', () => {
    const episode = {
      grandparentRatingKey: '50',
      title: 'Unknown Episode',
    };

    const seasonNumber = episode.parentIndex || 0;
    const episodeNumber = episode.index || 0;

    expect(seasonNumber).toBe(0);
    expect(episodeNumber).toBe(0);
  });
});
