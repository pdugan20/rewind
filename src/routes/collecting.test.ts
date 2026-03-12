import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  applyD1Migrations,
} from 'cloudflare:test';
import app from '../index.js';

const testEnv = env as any;

// Helper to create an authenticated request
function authRequest(path: string, method = 'GET'): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      Authorization: 'Bearer rw_test_admin_key',
    },
  });
}

// Helper to execute a request through the app
async function fetchApp(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

// Helper to run prepared statement
async function dbRun(sql: string, ...params: unknown[]) {
  return testEnv.DB.prepare(sql)
    .bind(...params)
    .run();
}

describe('collecting routes', () => {
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
    await dbRun('DELETE FROM collection_listening_xref');
    await dbRun('DELETE FROM discogs_collection');
    await dbRun('DELETE FROM discogs_release_artists');
    await dbRun('DELETE FROM discogs_wantlist');
    await dbRun('DELETE FROM discogs_collection_stats');
    await dbRun('DELETE FROM discogs_artists');
    await dbRun('DELETE FROM discogs_releases');
  });

  describe('GET /v1/collecting/collection', () => {
    it('should return empty collection', async () => {
      const response = await fetchApp(authRequest('/v1/collecting/collection'));
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

    it('should return collection items with pagination', async () => {
      await dbRun(
        "INSERT INTO discogs_releases (id, user_id, discogs_id, title, year, genres, formats, format_details, labels, discogs_url, created_at, updated_at) VALUES (1, 1, 100, 'Test Album', 2020, '[\"Rock\"]', '[\"Vinyl\"]', '[\"LP\"]', '[]', 'https://discogs.com/release/100', '2024-01-01', '2024-01-01')"
      );
      await dbRun(
        "INSERT INTO discogs_artists (id, user_id, discogs_id, name, created_at) VALUES (1, 1, 200, 'Test Artist', '2024-01-01')"
      );
      await dbRun(
        'INSERT INTO discogs_release_artists (id, release_id, artist_id) VALUES (1, 1, 1)'
      );
      await dbRun(
        "INSERT INTO discogs_collection (id, user_id, release_id, instance_id, folder_id, rating, date_added, created_at) VALUES (1, 1, 1, 1001, 0, 5, '2024-01-15T00:00:00Z', '2024-01-15')"
      );

      const response = await fetchApp(authRequest('/v1/collecting/collection'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe('Test Album');
      expect(body.data[0].artists).toContain('Test Artist');
      expect(body.data[0].discogs_id).toBe(100);
      expect(body.pagination.total).toBe(1);
    });

    it('should require auth', async () => {
      const response = await fetchApp(
        new Request('http://localhost/v1/collecting/collection')
      );
      expect(response.status).toBe(401);
    });
  });

  describe('GET /v1/collecting/stats', () => {
    it('should return empty stats when no data', async () => {
      const response = await fetchApp(authRequest('/v1/collecting/stats'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data.total_items).toBe(0);
    });

    it('should return stats when populated', async () => {
      await dbRun(
        'INSERT INTO discogs_collection_stats (user_id, total_items, by_format, wantlist_count, unique_artists, top_genre, added_this_year, by_genre, by_decade, updated_at) VALUES (1, 42, \'{"vinyl":30,"cd":10,"cassette":1,"other":1}\', 5, 25, \'Rock\', 3, \'{"Rock":30}\', \'{"2000s":20}\', \'2024-01-01\')'
      );

      const response = await fetchApp(authRequest('/v1/collecting/stats'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data.total_items).toBe(42);
      expect(body.data.by_format.vinyl).toBe(30);
      expect(body.data.wantlist_count).toBe(5);
    });
  });

  describe('GET /v1/collecting/recent', () => {
    it('should return recently added items', async () => {
      const response = await fetchApp(authRequest('/v1/collecting/recent'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toEqual([]);
    });

    it('should respect limit parameter', async () => {
      const response = await fetchApp(
        authRequest('/v1/collecting/recent?limit=3')
      );
      expect(response.status).toBe(200);
    });
  });

  describe('GET /v1/collecting/collection/:id', () => {
    it('should return 400 for invalid id', async () => {
      const response = await fetchApp(
        authRequest('/v1/collecting/collection/abc')
      );
      expect(response.status).toBe(400);
    });

    it('should return 404 for nonexistent item', async () => {
      const response = await fetchApp(
        authRequest('/v1/collecting/collection/999')
      );
      expect(response.status).toBe(404);
    });

    it('should return item detail', async () => {
      await dbRun(
        'INSERT INTO discogs_releases (id, user_id, discogs_id, title, year, genres, formats, format_details, labels, discogs_url, tracklist, country, created_at, updated_at) VALUES (1, 1, 100, \'Detail Album\', 2019, \'["Rock"]\', \'["Vinyl"]\', \'["LP","Album"]\', \'[{"name":"Label","catno":"L001"}]\', \'https://discogs.com/release/100\', \'[{"position":"A1","title":"Song","duration":"3:00"}]\', \'US\', \'2024-01-01\', \'2024-01-01\')'
      );
      await dbRun(
        "INSERT INTO discogs_artists (id, user_id, discogs_id, name, created_at) VALUES (1, 1, 200, 'Detail Artist', '2024-01-01')"
      );
      await dbRun(
        'INSERT INTO discogs_release_artists (id, release_id, artist_id) VALUES (1, 1, 1)'
      );
      await dbRun(
        "INSERT INTO discogs_collection (id, user_id, release_id, instance_id, folder_id, rating, date_added, created_at) VALUES (1, 1, 1, 2001, 0, 4, '2024-06-01T00:00:00Z', '2024-06-01')"
      );

      const response = await fetchApp(
        authRequest('/v1/collecting/collection/1')
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.title).toBe('Detail Album');
      expect(body.tracklist).toHaveLength(1);
      expect(body.country).toBe('US');
    });
  });

  describe('GET /v1/collecting/wantlist', () => {
    it('should return empty wantlist', async () => {
      const response = await fetchApp(authRequest('/v1/collecting/wantlist'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it('should return wantlist items', async () => {
      await dbRun(
        "INSERT INTO discogs_wantlist (user_id, discogs_id, title, artists, year, formats, genres, date_added, created_at) VALUES (1, 500, 'Wanted Album', '[\"Wanted Artist\"]', 2022, '[\"Vinyl\"]', '[\"Electronic\"]', '2024-05-01T00:00:00Z', '2024-05-01')"
      );

      const response = await fetchApp(authRequest('/v1/collecting/wantlist'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe('Wanted Album');
    });
  });

  describe('GET /v1/collecting/formats', () => {
    it('should return empty format breakdown', async () => {
      const response = await fetchApp(authRequest('/v1/collecting/formats'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toEqual([]);
    });
  });

  describe('GET /v1/collecting/genres', () => {
    it('should return empty genre breakdown', async () => {
      const response = await fetchApp(authRequest('/v1/collecting/genres'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toEqual([]);
    });
  });

  describe('GET /v1/collecting/artists', () => {
    it('should return empty artist list', async () => {
      const response = await fetchApp(authRequest('/v1/collecting/artists'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toEqual([]);
    });
  });

  describe('GET /v1/collecting/cross-reference', () => {
    it('should return empty cross-reference', async () => {
      const response = await fetchApp(
        authRequest('/v1/collecting/cross-reference')
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.data).toEqual([]);
      expect(body.summary).toBeDefined();
      expect(body.pagination).toBeDefined();
    });
  });

  describe('Cache-Control headers', () => {
    it('should set long cache for collection', async () => {
      const response = await fetchApp(authRequest('/v1/collecting/collection'));
      expect(response.headers.get('Cache-Control')).toContain('max-age=86400');
    });

    it('should set medium cache for recent', async () => {
      const response = await fetchApp(authRequest('/v1/collecting/recent'));
      expect(response.headers.get('Cache-Control')).toContain('max-age=3600');
    });
  });
});
