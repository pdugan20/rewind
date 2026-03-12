import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  applyD1Migrations,
} from 'cloudflare:test';
import app from '../index.js';

const testEnv = env as any;

function authRequest(path: string, method = 'GET', body?: object): Request {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: 'Bearer rw_test_admin_key',
      'Content-Type': 'application/json',
    },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}

async function fetchApp(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function dbRun(sql: string, ...params: unknown[]) {
  return testEnv.DB.prepare(sql)
    .bind(...params)
    .run();
}

describe('collecting media routes', () => {
  beforeAll(async () => {
    const migrations = testEnv.TEST_MIGRATIONS;
    if (Array.isArray(migrations)) {
      await applyD1Migrations(testEnv.DB, migrations);
    }

    // Create test API key
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode('rw_test_admin_key')
    );
    const keyHash = [...new Uint8Array(hashBuffer)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    await dbRun(
      "INSERT OR IGNORE INTO api_keys (user_id, key_hash, key_prefix, key_hint, name, scope, created_at) VALUES (1, ?, 'rw_test', '****_key', 'test', 'admin', ?)",
      keyHash,
      new Date().toISOString()
    );
  });

  beforeEach(async () => {
    await dbRun('DELETE FROM trakt_collection');
    await dbRun('DELETE FROM trakt_collection_stats');
    await dbRun('DELETE FROM movies WHERE id > 0');
  });

  async function insertMovie(
    id: number,
    title: string,
    year: number,
    tmdbId: number
  ) {
    await dbRun(
      "INSERT INTO movies (id, user_id, title, year, tmdb_id, created_at) VALUES (?, 1, ?, ?, ?, '2024-01-01')",
      id,
      title,
      year,
      tmdbId
    );
  }

  async function insertCollectionItem(
    id: number,
    movieId: number,
    traktId: number,
    mediaType: string,
    collectedAt: string
  ) {
    await dbRun(
      "INSERT INTO trakt_collection (id, user_id, movie_id, trakt_id, media_type, collected_at, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, '2024-01-01', '2024-01-01')",
      id,
      movieId,
      traktId,
      mediaType,
      collectedAt
    );
  }

  describe('GET /v1/collecting/media', () => {
    it('should return empty collection', async () => {
      const response = await fetchApp(authRequest('/v1/collecting/media'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 0,
        total_pages: 0,
      });
    });

    it('should return media items with pagination', async () => {
      await insertMovie(1, 'The Matrix', 1999, 603);
      await insertCollectionItem(1, 1, 481, 'bluray', '2024-06-15T00:00:00Z');

      const response = await fetchApp(authRequest('/v1/collecting/media'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe('The Matrix');
      expect(body.data[0].media_type).toBe('bluray');
      expect(body.pagination.total).toBe(1);
    });

    it('should filter by format', async () => {
      await insertMovie(1, 'The Matrix', 1999, 603);
      await insertMovie(2, 'Blade Runner', 1982, 78);
      await insertCollectionItem(1, 1, 481, 'bluray', '2024-06-15T00:00:00Z');
      await insertCollectionItem(2, 2, 482, 'hddvd', '2024-06-16T00:00:00Z');

      const response = await fetchApp(
        authRequest('/v1/collecting/media?format=hddvd')
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe('Blade Runner');
    });

    it('should require auth', async () => {
      const response = await fetchApp(
        new Request('http://localhost/v1/collecting/media')
      );
      expect(response.status).toBe(401);
    });
  });

  describe('GET /v1/collecting/media/stats', () => {
    it('should return empty stats when no data', async () => {
      const response = await fetchApp(
        authRequest('/v1/collecting/media/stats')
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data.total_items).toBe(0);
    });

    it('should return stats when populated', async () => {
      await dbRun(
        'INSERT INTO trakt_collection_stats (user_id, total_items, by_format, by_resolution, by_hdr, by_genre, by_decade, added_this_year, updated_at) VALUES (1, 25, \'{"bluray":15,"uhd_bluray":8,"hddvd":2}\', \'{"uhd_4k":8,"hd_1080p":17}\', \'{"dolby_vision":5}\', \'{"Action":10,"Sci-Fi":8}\', \'{"1990s":5,"2000s":12,"2010s":8}\', 3, \'2024-01-01\')'
      );

      const response = await fetchApp(
        authRequest('/v1/collecting/media/stats')
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data.total_items).toBe(25);
      expect(body.data.by_format.bluray).toBe(15);
      expect(body.data.by_format.hddvd).toBe(2);
    });
  });

  describe('GET /v1/collecting/media/recent', () => {
    it('should return empty when no items', async () => {
      const response = await fetchApp(
        authRequest('/v1/collecting/media/recent')
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toEqual([]);
    });

    it('should return recently collected items in order', async () => {
      await insertMovie(1, 'Old Movie', 1985, 100);
      await insertMovie(2, 'New Movie', 2023, 200);
      await insertCollectionItem(1, 1, 481, 'bluray', '2024-01-01T00:00:00Z');
      await insertCollectionItem(
        2,
        2,
        482,
        'uhd_bluray',
        '2024-06-15T00:00:00Z'
      );

      const response = await fetchApp(
        authRequest('/v1/collecting/media/recent')
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toHaveLength(2);
      // Most recent first
      expect(body.data[0].title).toBe('New Movie');
      expect(body.data[1].title).toBe('Old Movie');
    });

    it('should respect limit parameter', async () => {
      await insertMovie(1, 'Movie 1', 2000, 100);
      await insertMovie(2, 'Movie 2', 2001, 200);
      await insertCollectionItem(1, 1, 481, 'bluray', '2024-01-01T00:00:00Z');
      await insertCollectionItem(2, 2, 482, 'bluray', '2024-06-15T00:00:00Z');

      const response = await fetchApp(
        authRequest('/v1/collecting/media/recent?limit=1')
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toHaveLength(1);
    });
  });

  describe('GET /v1/collecting/media/formats', () => {
    it('should return empty format breakdown', async () => {
      const response = await fetchApp(
        authRequest('/v1/collecting/media/formats')
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toEqual([]);
    });

    it('should return format counts', async () => {
      await insertMovie(1, 'Movie A', 2000, 100);
      await insertMovie(2, 'Movie B', 2001, 200);
      await insertMovie(3, 'Movie C', 2002, 300);
      await insertCollectionItem(1, 1, 481, 'bluray', '2024-01-01T00:00:00Z');
      await insertCollectionItem(2, 2, 482, 'bluray', '2024-01-02T00:00:00Z');
      await insertCollectionItem(3, 3, 483, 'hddvd', '2024-01-03T00:00:00Z');

      const response = await fetchApp(
        authRequest('/v1/collecting/media/formats')
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data.length).toBeGreaterThanOrEqual(2);

      const bluray = body.data.find(
        (f: { name: string }) => f.name === 'bluray'
      );
      const hddvd = body.data.find((f: { name: string }) => f.name === 'hddvd');
      expect(bluray.count).toBe(2);
      expect(hddvd.count).toBe(1);
    });
  });

  describe('GET /v1/collecting/media/:id', () => {
    it('should return 400 for invalid id', async () => {
      const response = await fetchApp(authRequest('/v1/collecting/media/abc'));
      expect(response.status).toBe(400);
    });

    it('should return 404 for nonexistent item', async () => {
      const response = await fetchApp(authRequest('/v1/collecting/media/999'));
      expect(response.status).toBe(404);
    });

    it('should return item detail', async () => {
      await insertMovie(1, 'The Matrix', 1999, 603);
      await insertCollectionItem(1, 1, 481, 'bluray', '2024-06-15T00:00:00Z');

      const response = await fetchApp(authRequest('/v1/collecting/media/1'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.title).toBe('The Matrix');
      expect(body.media_type).toBe('bluray');
      expect(body.year).toBe(1999);
    });
  });

  describe('GET /v1/collecting/media/cross-reference', () => {
    it('should return empty cross-reference', async () => {
      const response = await fetchApp(
        authRequest('/v1/collecting/media/cross-reference')
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toEqual([]);
      expect(body.summary).toBeDefined();
      expect(body.pagination).toBeDefined();
    });
  });

  describe('Cache-Control headers', () => {
    it('should set cache for media list', async () => {
      const response = await fetchApp(authRequest('/v1/collecting/media'));
      expect(response.headers.get('Cache-Control')).toBeDefined();
    });

    it('should set cache for media recent', async () => {
      const response = await fetchApp(
        authRequest('/v1/collecting/media/recent')
      );
      expect(response.headers.get('Cache-Control')).toBeDefined();
    });
  });
});
