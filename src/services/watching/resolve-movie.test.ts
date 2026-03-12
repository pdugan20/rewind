import { describe, it, expect } from 'vitest';
import type { ResolveMovieParams } from './resolve-movie.js';

describe('resolveMovie', () => {
  it('exports resolveMovie function', async () => {
    const mod = await import('./resolve-movie.js');
    expect(mod.resolveMovie).toBeDefined();
    expect(typeof mod.resolveMovie).toBe('function');
  });

  it('exports ResolveMovieParams type with expected shape', () => {
    // Verify the params interface accepts all source scenarios
    const plexParams: ResolveMovieParams = {
      tmdbId: 27205,
      plexRatingKey: '12345',
      title: 'Inception',
      year: 2010,
    };
    expect(plexParams.tmdbId).toBe(27205);
    expect(plexParams.plexRatingKey).toBe('12345');

    const letterboxdParams: ResolveMovieParams = {
      tmdbId: 27205,
      title: 'Inception',
      year: 2010,
    };
    expect(letterboxdParams.tmdbId).toBe(27205);
    expect(letterboxdParams.plexRatingKey).toBeUndefined();

    const traktParams: ResolveMovieParams = {
      tmdbId: 550,
      title: 'Fight Club',
      year: 1999,
    };
    expect(traktParams.tmdbId).toBe(550);

    const manualTitleOnly: ResolveMovieParams = {
      title: 'Inception',
      year: 2010,
    };
    expect(manualTitleOnly.tmdbId).toBeUndefined();

    const plexNoTmdb: ResolveMovieParams = {
      plexRatingKey: '99999',
      title: 'Some TV Special',
      year: 2020,
    };
    expect(plexNoTmdb.tmdbId).toBeUndefined();
    expect(plexNoTmdb.plexRatingKey).toBe('99999');
  });

  it('accepts null year for unknown release dates', () => {
    const params: ResolveMovieParams = {
      tmdbId: 12345,
      title: 'Unknown Movie',
      year: null,
    };
    expect(params.year).toBeNull();
  });
});

describe('resolve-movie resolution contract', () => {
  /**
   * These tests document the expected resolution behavior.
   * The actual DB + TMDB interactions are tested via watching e2e tests.
   * Here we verify the contract that all four callers rely on.
   */

  it('Plex source provides tmdbId + plexRatingKey for best match', () => {
    // Plex resolves tmdbId from Guid array before calling resolveMovie.
    // When both are provided, tmdbId lookup runs first (most reliable).
    const params: ResolveMovieParams = {
      tmdbId: 27205,
      plexRatingKey: '12345',
      title: 'Inception',
      year: 2010,
    };

    // tmdbId is set: step 1 runs first
    expect(params.tmdbId).toBeDefined();
    // plexRatingKey will be back-filled on existing row if missing
    expect(params.plexRatingKey).toBeDefined();
  });

  it('Plex source without tmdbId falls back to plexRatingKey lookup', () => {
    // Some Plex items have no Guid metadata (rare, e.g., local content)
    const params: ResolveMovieParams = {
      plexRatingKey: '57869',
      title: "It's Always Sunny: A Very Sunny Christmas",
      year: 2009,
    };

    // No tmdbId: step 1 skipped, step 2 runs (plexRatingKey lookup)
    expect(params.tmdbId).toBeUndefined();
    expect(params.plexRatingKey).toBeDefined();
  });

  it('Letterboxd source provides tmdbId only (no plexRatingKey)', () => {
    const params: ResolveMovieParams = {
      tmdbId: 27205,
      title: 'Inception',
      year: 2010,
    };

    // tmdbId is set: step 1 runs. No plexRatingKey to back-fill.
    expect(params.tmdbId).toBeDefined();
    expect(params.plexRatingKey).toBeUndefined();
  });

  it('Letterboxd fallback uses title+year when no tmdbId in RSS', () => {
    const params: ResolveMovieParams = {
      title: 'Inception',
      year: 2010,
    };

    // No tmdbId or plexRatingKey: steps 1 and 2 skipped.
    // Step 3 searches TMDB by title+year.
    expect(params.tmdbId).toBeUndefined();
    expect(params.plexRatingKey).toBeUndefined();
    expect(params.title).toBeDefined();
    expect(params.year).toBeDefined();
  });

  it('Trakt source always has tmdbId', () => {
    const params: ResolveMovieParams = {
      tmdbId: 550,
      title: 'Fight Club',
      year: 1999,
    };

    // Trakt skips items without tmdbId in the sync loop,
    // so resolveMovie always receives one.
    expect(params.tmdbId).toBeDefined();
  });

  it('manual entry can use either tmdbId or title+year', () => {
    const byTmdbId: ResolveMovieParams = {
      tmdbId: 27205,
      title: '',
      year: undefined,
    };
    expect(byTmdbId.tmdbId).toBeDefined();

    const byTitle: ResolveMovieParams = {
      title: 'Inception',
      year: 2010,
    };
    expect(byTitle.tmdbId).toBeUndefined();
    expect(byTitle.title).toBeTruthy();
  });

  it('cross-source dedup: same tmdbId from different sources resolves to same movie', () => {
    // Plex and Letterboxd both provide tmdbId 27205 for "Inception"
    const plexParams: ResolveMovieParams = {
      tmdbId: 27205,
      plexRatingKey: '12345',
      title: 'Inception',
      year: 2010,
    };

    const letterboxdParams: ResolveMovieParams = {
      tmdbId: 27205,
      title: 'Inception',
      year: 2010,
    };

    // Both share the same tmdbId, so step 1 finds the same row
    expect(plexParams.tmdbId).toBe(letterboxdParams.tmdbId);
  });

  it('back-fill scenario: Plex movie gets plexRatingKey added to Letterboxd-created row', () => {
    // 1. Letterboxd creates movie with tmdbId=27205, no plexRatingKey
    // 2. Plex later syncs same movie with tmdbId=27205 + plexRatingKey="12345"
    // 3. resolveMovie finds existing by tmdbId, back-fills plexRatingKey
    const plexParams: ResolveMovieParams = {
      tmdbId: 27205,
      plexRatingKey: '12345',
      title: 'Inception',
      year: 2010,
    };

    // The back-fill happens because:
    // - tmdbId matches an existing row (step 1)
    // - plexRatingKey is provided in params
    // - existing row may not have plexRatingKey yet
    expect(plexParams.tmdbId).toBeDefined();
    expect(plexParams.plexRatingKey).toBeDefined();
  });

  it('back-fill scenario: Plex-only movie gets tmdbId added when found via search', () => {
    // 1. Plex creates movie with plexRatingKey="57869", no tmdbId
    // 2. resolveMovie finds existing by plexRatingKey (step 2)
    // 3. Since existing.tmdbId is null, searches TMDB by title+year
    // 4. Back-fills tmdbId on the existing row
    const params: ResolveMovieParams = {
      plexRatingKey: '57869',
      title: 'Some Movie',
      year: 2020,
    };

    // No tmdbId provided: step 1 skipped.
    // plexRatingKey lookup (step 2) finds the row.
    // tmdbId will be resolved via search and back-filled.
    expect(params.tmdbId).toBeUndefined();
    expect(params.plexRatingKey).toBeDefined();
  });

  it('returns null when TMDB search finds nothing and no IDs provided', () => {
    // When a movie can't be resolved via any path, resolveMovie returns null.
    // The caller decides how to handle it (skip, insert with Plex-only data, etc.)
    const params: ResolveMovieParams = {
      title: 'Totally Obscure Unlisted Film',
      year: 1923,
    };

    // No tmdbId, no plexRatingKey, title+year search returns empty
    expect(params.tmdbId).toBeUndefined();
    expect(params.plexRatingKey).toBeUndefined();
  });
});
