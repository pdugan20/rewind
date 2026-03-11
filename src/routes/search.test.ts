import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { setupTestDbWithFts5, createTestApiKey } from '../test-helpers.js';
import { upsertSearchIndex, upsertSearchIndexBatch } from './search.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('search routes', () => {
  let token: string;

  beforeAll(async () => {
    await setupTestDbWithFts5();
    token = await createTestApiKey({ name: 'search-test', scope: 'admin' });
  });

  beforeEach(async () => {
    try {
      await env.DB.exec('DELETE FROM search_index');
    } catch {
      // ignore
    }
  });

  describe('upsertSearchIndex', () => {
    it('inserts a search index entry', async () => {
      const db = drizzle(env.DB);
      await upsertSearchIndex(db, {
        domain: 'listening',
        entityType: 'artist',
        entityId: 'artist-1',
        title: 'Radiohead',
      });

      const results = await env.DB.prepare(
        "SELECT * FROM search_index WHERE search_index MATCH 'Radiohead'"
      ).all();
      expect(results.results).toHaveLength(1);
    });

    it('updates an existing entry by delete and re-insert', async () => {
      const db = drizzle(env.DB);
      await upsertSearchIndex(db, {
        domain: 'listening',
        entityType: 'artist',
        entityId: 'artist-1',
        title: 'Radiohead',
      });
      await upsertSearchIndex(db, {
        domain: 'listening',
        entityType: 'artist',
        entityId: 'artist-1',
        title: 'Radiohead Updated',
      });

      const results = await env.DB.prepare(
        "SELECT * FROM search_index WHERE search_index MATCH 'Updated'"
      ).all();
      expect(results.results.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('upsertSearchIndexBatch', () => {
    it('inserts multiple entries', async () => {
      const db = drizzle(env.DB);
      await upsertSearchIndexBatch(db, [
        {
          domain: 'listening',
          entityType: 'artist',
          entityId: 'artist-1',
          title: 'Radiohead',
        },
        {
          domain: 'watching',
          entityType: 'movie',
          entityId: 'movie-1',
          title: 'Inception',
        },
      ]);

      const results = await env.DB.prepare('SELECT * FROM search_index').all();
      expect(results.results).toHaveLength(2);
    });
  });

  describe('GET /v1/search', () => {
    it('returns 400 when no query provided', async () => {
      const res = await SELF.fetch('http://localhost/v1/search', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
    });

    it('searches across domains', async () => {
      const db = drizzle(env.DB);
      await upsertSearchIndexBatch(db, [
        {
          domain: 'listening',
          entityType: 'artist',
          entityId: 'a-1',
          title: 'Radiohead',
          subtitle: 'Alternative Rock',
        },
        {
          domain: 'watching',
          entityType: 'movie',
          entityId: 'm-1',
          title: 'Radio Days',
          subtitle: 'Woody Allen',
        },
        {
          domain: 'running',
          entityType: 'activity',
          entityId: 'r-1',
          title: 'Morning Run',
        },
      ]);

      const res = await SELF.fetch('http://localhost/v1/search?q=Radio', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data.length).toBeGreaterThanOrEqual(2);
      expect(body.pagination).toBeTruthy();
    });

    it('filters by domain', async () => {
      const db = drizzle(env.DB);
      await upsertSearchIndexBatch(db, [
        {
          domain: 'listening',
          entityType: 'artist',
          entityId: 'a-1',
          title: 'Radiohead',
        },
        {
          domain: 'watching',
          entityType: 'movie',
          entityId: 'm-1',
          title: 'Radio Days',
        },
      ]);

      const res = await SELF.fetch(
        'http://localhost/v1/search?q=Radio&domain=listening',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].domain).toBe('listening');
    });

    it('returns 400 for invalid domain filter', async () => {
      const res = await SELF.fetch(
        'http://localhost/v1/search?q=test&domain=invalid',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(400);
    });

    it('requires auth', async () => {
      const res = await SELF.fetch('http://localhost/v1/search?q=test');
      expect(res.status).toBe(401);
    });
  });
});
