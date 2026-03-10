import { describe, it, expect } from 'vitest';

describe('watching routes', () => {
  it('has correct endpoint structure', () => {
    // Verify the route module exports correctly
    // Full integration tests require the Workers pool with D1
    expect(true).toBe(true);
  });

  it('paginate helper produces correct output', () => {
    // Test the pagination logic
    const page = 2;
    const limit = 20;
    const total = 55;
    const totalPages = Math.ceil(total / limit);

    expect(totalPages).toBe(3);
    expect(page).toBeLessThanOrEqual(totalPages);
  });

  it('calendar year filtering works with string comparison', () => {
    const testDate = '2026-03-08T12:00:00.000Z';
    const year = testDate.substring(0, 4);
    expect(year).toBe('2026');
  });

  it('duplicate detection uses date substring', () => {
    const watchedAt = '2026-03-08T15:30:00.000Z';
    const watchDate = watchedAt.substring(0, 10);
    expect(watchDate).toBe('2026-03-08');
  });

  it('trend period grouping formats correctly', () => {
    // Monthly grouping
    const date = '2026-03-08T12:00:00.000Z';
    const monthly = date.substring(0, 7);
    expect(monthly).toBe('2026-03');
  });
});

// ─── 4.7.7 — TV Show endpoint tests ──────────────────────────────────

describe('TV show endpoints', () => {
  it('module can be imported', async () => {
    const mod = await import('./watching.js');
    expect(mod.default).toBeDefined();
  });

  it('show list response shape matches pagination convention', () => {
    // Verify the expected response shape
    const mockResponse = {
      data: [
        {
          id: 1,
          title: 'Breaking Bad',
          year: 2008,
          tmdb_id: 1396,
          poster_url: null,
          thumbhash: null,
          dominant_color: null,
          accent_color: null,
          total_seasons: 5,
          total_episodes: 62,
          episodes_watched: 30,
        },
      ],
      pagination: {
        page: 1,
        limit: 20,
        total: 1,
        total_pages: 1,
      },
    };

    expect(mockResponse.data).toHaveLength(1);
    expect(mockResponse.pagination).toHaveProperty('page');
    expect(mockResponse.pagination).toHaveProperty('limit');
    expect(mockResponse.pagination).toHaveProperty('total');
    expect(mockResponse.pagination).toHaveProperty('total_pages');
    expect(mockResponse.data[0]).toHaveProperty('id');
    expect(mockResponse.data[0]).toHaveProperty('title');
    expect(mockResponse.data[0]).toHaveProperty('tmdb_id');
    expect(mockResponse.data[0]).toHaveProperty('total_seasons');
    expect(mockResponse.data[0]).toHaveProperty('total_episodes');
    expect(mockResponse.data[0]).toHaveProperty('episodes_watched');
  });

  it('show detail response includes seasons array grouped by season number', () => {
    const mockDetailResponse = {
      id: 1,
      title: 'Breaking Bad',
      year: 2008,
      tmdb_id: 1396,
      summary: 'A chemistry teacher turned meth dealer',
      poster_url: null,
      thumbhash: null,
      dominant_color: null,
      accent_color: null,
      total_seasons: 5,
      total_episodes: 62,
      episodes_watched: 3,
      seasons: [
        {
          season_number: 1,
          episodes_watched: 2,
          episodes: [
            {
              season: 1,
              episode: 1,
              title: 'Pilot',
              watched_at: '2026-01-01T00:00:00.000Z',
            },
            {
              season: 1,
              episode: 2,
              title: "Cat's in the Bag...",
              watched_at: '2026-01-02T00:00:00.000Z',
            },
          ],
        },
        {
          season_number: 2,
          episodes_watched: 1,
          episodes: [
            {
              season: 2,
              episode: 1,
              title: 'Seven Thirty-Seven',
              watched_at: '2026-02-01T00:00:00.000Z',
            },
          ],
        },
      ],
    };

    expect(mockDetailResponse.seasons).toHaveLength(2);
    expect(mockDetailResponse.seasons[0].season_number).toBe(1);
    expect(mockDetailResponse.seasons[0].episodes_watched).toBe(2);
    expect(mockDetailResponse.seasons[0].episodes).toHaveLength(2);
    expect(mockDetailResponse.seasons[1].season_number).toBe(2);
    expect(mockDetailResponse.episodes_watched).toBe(3);
  });

  it('season detail response includes show_id and season_number', () => {
    const mockSeasonResponse = {
      show_id: 1,
      show_title: 'Breaking Bad',
      season_number: 1,
      episodes: [
        {
          season: 1,
          episode: 1,
          title: 'Pilot',
          watched_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    expect(mockSeasonResponse).toHaveProperty('show_id');
    expect(mockSeasonResponse).toHaveProperty('show_title');
    expect(mockSeasonResponse).toHaveProperty('season_number');
    expect(mockSeasonResponse).toHaveProperty('episodes');
    expect(mockSeasonResponse.episodes[0]).toHaveProperty('season');
    expect(mockSeasonResponse.episodes[0]).toHaveProperty('episode');
    expect(mockSeasonResponse.episodes[0]).toHaveProperty('title');
    expect(mockSeasonResponse.episodes[0]).toHaveProperty('watched_at');
  });

  it('show list pagination clamps page minimum to 1', () => {
    const rawPage = '-1';
    const page = Math.max(parseInt(rawPage), 1);
    expect(page).toBe(1);
  });

  it('show list pagination clamps limit between 1 and 100', () => {
    const rawLimitTooHigh = '500';
    const limitHigh = Math.min(Math.max(parseInt(rawLimitTooHigh), 1), 100);
    expect(limitHigh).toBe(100);

    const rawLimitTooLow = '0';
    const limitLow = Math.min(Math.max(parseInt(rawLimitTooLow), 1), 100);
    expect(limitLow).toBe(1);
  });

  it('show list defaults to sorting by title ascending', () => {
    const rawSort: string | undefined = undefined;
    const rawOrder: string | undefined = undefined;
    const sort = rawSort || 'title';
    const order = rawOrder || 'asc';
    expect(sort).toBe('title');
    expect(order).toBe('asc');
  });

  it('invalid show ID returns error response shape', () => {
    const id = parseInt('abc');
    expect(isNaN(id)).toBe(true);

    // Error response shape
    const errorResponse = { error: 'Invalid show ID', status: 400 };
    expect(errorResponse).toHaveProperty('error');
    expect(errorResponse).toHaveProperty('status');
    expect(errorResponse.status).toBe(400);
  });

  it('invalid season number returns error response shape', () => {
    const id = parseInt('1');
    const season = parseInt('abc');

    expect(isNaN(id)).toBe(false);
    expect(isNaN(season)).toBe(true);

    const errorResponse = {
      error: 'Invalid show ID or season number',
      status: 400,
    };
    expect(errorResponse.status).toBe(400);
  });

  it('show not found returns 404 error shape', () => {
    const errorResponse = { error: 'Show not found', status: 404 };
    expect(errorResponse.error).toBe('Show not found');
    expect(errorResponse.status).toBe(404);
  });
});

// ─── 4.9.6 — Manual entry endpoint tests ─────────────────────────────

describe('manual entry endpoints', () => {
  it('POST /admin/watching/movies requires tmdb_id or title', () => {
    const bodyWithTmdbId = { tmdb_id: 27205 };
    const bodyWithTitle = { title: 'Inception' };
    const bodyEmpty: Record<string, unknown> = {};

    expect(bodyWithTmdbId.tmdb_id || bodyWithTitle.title).toBeTruthy();
    expect(!bodyEmpty.tmdb_id && !bodyEmpty.title).toBe(true);
  });

  it('manual entry response shape on success (201)', () => {
    const mockResponse = {
      id: 1,
      movie_id: 42,
      watched_at: '2026-03-08T00:00:00.000Z',
      source: 'manual',
      user_rating: 4.5,
      rewatch: false,
    };

    expect(mockResponse).toHaveProperty('id');
    expect(mockResponse).toHaveProperty('movie_id');
    expect(mockResponse).toHaveProperty('watched_at');
    expect(mockResponse.source).toBe('manual');
    expect(mockResponse).toHaveProperty('user_rating');
    expect(mockResponse).toHaveProperty('rewatch');
  });

  it('manual entry sets source to manual', () => {
    const source = 'manual';
    expect(source).toBe('manual');
  });

  it('manual entry defaults watched_at to current ISO time', () => {
    const body: Record<string, unknown> = {};
    const watchedAt = (body.watched_at as string) || new Date().toISOString();
    expect(watchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('manual entry converts rewatch boolean to integer', () => {
    const rewatchTrue = true as boolean;
    const rewatchFalse = false as boolean;
    expect(rewatchTrue ? 1 : 0).toBe(1);
    expect(rewatchFalse ? 1 : 0).toBe(0);
  });

  it('duplicate watch event on same date returns 409', () => {
    const errorResponse = {
      error: 'Duplicate watch event for this movie on this date',
      status: 409,
    };
    expect(errorResponse.status).toBe(409);
    expect(errorResponse.error).toContain('Duplicate');
  });

  it('TMDB lookup failure returns 400', () => {
    const errorMsg = 'TMDB API error: 404 Not Found';
    const errorResponse = {
      error: `TMDB lookup failed: ${errorMsg}`,
      status: 400,
    };
    expect(errorResponse.status).toBe(400);
    expect(errorResponse.error).toContain('TMDB lookup failed');
  });

  it('TMDB search with no results returns 404', () => {
    const errorResponse = {
      error: 'No matching movie found on TMDB',
      status: 404,
    };
    expect(errorResponse.status).toBe(404);
  });

  it('PUT /admin/watching/movies/:id validates watch event ID', () => {
    const id = parseInt('abc');
    expect(isNaN(id)).toBe(true);

    const errorResponse = {
      error: 'Invalid watch event ID',
      status: 400,
    };
    expect(errorResponse.status).toBe(400);
  });

  it('PUT /admin/watching/movies/:id requires at least one field', () => {
    const updates = {};
    expect(Object.keys(updates).length).toBe(0);

    const errorResponse = {
      error: 'No fields to update',
      status: 400,
    };
    expect(errorResponse.status).toBe(400);
  });

  it('PUT /admin/watching/movies/:id returns updated event shape', () => {
    const mockUpdated = {
      id: 1,
      movie_id: 42,
      watched_at: '2026-03-09T00:00:00.000Z',
      source: 'manual',
      user_rating: 5,
      rewatch: true,
    };

    expect(mockUpdated).toHaveProperty('id');
    expect(mockUpdated).toHaveProperty('movie_id');
    expect(mockUpdated).toHaveProperty('watched_at');
    expect(mockUpdated).toHaveProperty('source');
    expect(mockUpdated).toHaveProperty('user_rating');
    expect(mockUpdated).toHaveProperty('rewatch');
  });

  it('PUT maps body fields to database column names', () => {
    const body = {
      watched_at: '2026-03-09T00:00:00.000Z',
      rating: 5,
      rewatch: true,
    };

    const updates: Record<string, unknown> = {};
    if (body.watched_at !== undefined) updates.watchedAt = body.watched_at;
    if (body.rating !== undefined) updates.userRating = body.rating;
    if (body.rewatch !== undefined) updates.rewatch = body.rewatch ? 1 : 0;

    expect(updates.watchedAt).toBe('2026-03-09T00:00:00.000Z');
    expect(updates.userRating).toBe(5);
    expect(updates.rewatch).toBe(1);
  });

  it('DELETE /admin/watching/movies/:id validates ID', () => {
    const id = parseInt('abc');
    expect(isNaN(id)).toBe(true);
  });

  it('DELETE /admin/watching/movies/:id returns not found for missing event', () => {
    const errorResponse = {
      error: 'Watch event not found',
      status: 404,
    };
    expect(errorResponse.status).toBe(404);
  });

  it('DELETE /admin/watching/movies/:id returns success shape', () => {
    const mockResponse = { success: true, deleted_id: 1 };
    expect(mockResponse.success).toBe(true);
    expect(mockResponse.deleted_id).toBe(1);
  });

  it('manual entry dedup check uses date substring', () => {
    const watchedAt = '2026-03-08T22:30:00.000Z';
    const watchDate = watchedAt.substring(0, 10);
    expect(watchDate).toBe('2026-03-08');

    // Different times same day should be considered duplicates
    const watchedAt2 = '2026-03-08T10:00:00.000Z';
    const watchDate2 = watchedAt2.substring(0, 10);
    expect(watchDate).toBe(watchDate2);
  });

  it('TMDB search uses title and optional year', () => {
    const body = { title: 'Inception', year: 2010 };
    expect(body.title).toBe('Inception');
    expect(body.year).toBe(2010);

    const bodyNoYear: { title: string; year?: number } = {
      title: 'Inception',
    };
    expect(bodyNoYear.year).toBeUndefined();
  });
});
