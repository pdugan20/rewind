import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { activityFeed } from '../db/schema/system.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';
import { insertFeedItem, insertFeedItems } from './feed.js';

describe('feed routes', () => {
  let token: string;

  beforeAll(async () => {
    await setupTestDb();
    token = await createTestApiKey({ name: 'feed-test', scope: 'admin' });
  });

  beforeEach(async () => {
    const db = drizzle(env.DB);

    await db.delete(activityFeed);
  });

  describe('insertFeedItem', () => {
    it('inserts a single feed item', async () => {
      const db = drizzle(env.DB);
      await insertFeedItem(db, {
        domain: 'listening',
        eventType: 'scrobble',
        occurredAt: '2024-01-01T00:00:00Z',
        title: 'Test Song',
        subtitle: 'Test Artist',
        sourceId: 'listen-1',
      });

      const items = await db.select().from(activityFeed);
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Test Song');
      expect(items[0].domain).toBe('listening');
    });

    it('skips duplicate source_id + domain', async () => {
      const db = drizzle(env.DB);
      await insertFeedItem(db, {
        domain: 'listening',
        eventType: 'scrobble',
        occurredAt: '2024-01-01T00:00:00Z',
        title: 'Test Song',
        sourceId: 'listen-dup',
      });
      await insertFeedItem(db, {
        domain: 'listening',
        eventType: 'scrobble',
        occurredAt: '2024-01-01T00:00:00Z',
        title: 'Test Song Duplicate',
        sourceId: 'listen-dup',
      });

      const items = await db.select().from(activityFeed);
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Test Song');
    });
  });

  describe('insertFeedItems (batch)', () => {
    it('inserts multiple items', async () => {
      const db = drizzle(env.DB);
      await insertFeedItems(db, [
        {
          domain: 'listening',
          eventType: 'scrobble',
          occurredAt: '2024-01-01T00:00:00Z',
          title: 'Song 1',
          sourceId: 'batch-1',
        },
        {
          domain: 'running',
          eventType: 'activity',
          occurredAt: '2024-01-02T00:00:00Z',
          title: 'Morning Run',
          sourceId: 'batch-2',
        },
      ]);

      const items = await db.select().from(activityFeed);
      expect(items).toHaveLength(2);
    });

    it('skips items with existing source IDs', async () => {
      const db = drizzle(env.DB);
      await insertFeedItem(db, {
        domain: 'listening',
        eventType: 'scrobble',
        occurredAt: '2024-01-01T00:00:00Z',
        title: 'Existing Song',
        sourceId: 'existing-1',
      });

      await insertFeedItems(db, [
        {
          domain: 'listening',
          eventType: 'scrobble',
          occurredAt: '2024-01-01T00:00:00Z',
          title: 'Existing Song Again',
          sourceId: 'existing-1',
        },
        {
          domain: 'running',
          eventType: 'activity',
          occurredAt: '2024-01-02T00:00:00Z',
          title: 'New Run',
          sourceId: 'new-1',
        },
      ]);

      const items = await db.select().from(activityFeed);
      expect(items).toHaveLength(2);
    });
  });

  describe('GET /v1/feed', () => {
    it('returns empty feed', async () => {
      const res = await SELF.fetch('http://localhost/v1/feed', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toEqual([]);
      expect(body.pagination.has_more).toBe(false);
    });

    it('returns feed items ordered by occurred_at desc', async () => {
      const db = drizzle(env.DB);
      await insertFeedItems(db, [
        {
          domain: 'listening',
          eventType: 'scrobble',
          occurredAt: '2024-01-01T00:00:00Z',
          title: 'Old Song',
          sourceId: 'old-1',
        },
        {
          domain: 'running',
          eventType: 'activity',
          occurredAt: '2024-01-03T00:00:00Z',
          title: 'New Run',
          sourceId: 'new-1',
        },
        {
          domain: 'watching',
          eventType: 'watch',
          occurredAt: '2024-01-02T00:00:00Z',
          title: 'Movie',
          sourceId: 'watch-1',
        },
      ]);

      const res = await SELF.fetch('http://localhost/v1/feed', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(3);
      expect(body.data[0].title).toBe('New Run');
      expect(body.data[1].title).toBe('Movie');
      expect(body.data[2].title).toBe('Old Song');
    });

    it('supports cursor-based pagination', async () => {
      const db = drizzle(env.DB);
      const items = Array.from({ length: 5 }, (_, i) => ({
        domain: 'listening',
        eventType: 'scrobble',
        occurredAt: `2024-01-0${i + 1}T00:00:00Z`,
        title: `Song ${i + 1}`,
        sourceId: `cursor-${i + 1}`,
      }));
      await insertFeedItems(db, items);

      const res1 = await SELF.fetch('http://localhost/v1/feed?limit=2', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body1 = (await res1.json()) as any;
      expect(body1.data).toHaveLength(2);
      expect(body1.pagination.has_more).toBe(true);
      expect(body1.pagination.next_cursor).toBeTruthy();

      const res2 = await SELF.fetch(
        `http://localhost/v1/feed?limit=2&cursor=${body1.pagination.next_cursor}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const body2 = (await res2.json()) as any;
      expect(body2.data).toHaveLength(2);
    });

    it('requires auth', async () => {
      const res = await SELF.fetch('http://localhost/v1/feed');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/feed/domain/:domain', () => {
    it('filters by domain', async () => {
      const db = drizzle(env.DB);
      await insertFeedItems(db, [
        {
          domain: 'listening',
          eventType: 'scrobble',
          occurredAt: '2024-01-01T00:00:00Z',
          title: 'Song',
          sourceId: 'domain-1',
        },
        {
          domain: 'running',
          eventType: 'activity',
          occurredAt: '2024-01-02T00:00:00Z',
          title: 'Run',
          sourceId: 'domain-2',
        },
      ]);

      const res = await SELF.fetch(
        'http://localhost/v1/feed/domain/listening',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].domain).toBe('listening');
    });

    it('returns 400 for invalid domain', async () => {
      const res = await SELF.fetch('http://localhost/v1/feed/domain/invalid', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
    });
  });
});
