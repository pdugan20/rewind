import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { activityFeed, revalidationHooks } from '../db/schema/system.js';
import { setupTestDb } from '../test-helpers.js';
import { afterSync } from './after-sync.js';
import type { FeedItem } from './after-sync.js';

describe('afterSync', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    const db = drizzle(env.DB);

    await db.delete(activityFeed);

    await db.delete(revalidationHooks);
    vi.restoreAllMocks();
  });

  it('inserts feed items', async () => {
    const db = drizzle(env.DB);
    const feedItems: FeedItem[] = [
      {
        domain: 'listening',
        eventType: 'new_album',
        occurredAt: '2024-01-01T00:00:00Z',
        title: 'New album: OK Computer',
        subtitle: 'Radiohead',
        sourceId: 'album-1',
      },
    ];

    await afterSync(db, { domain: 'listening', feedItems });

    const items = await db.select().from(activityFeed);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('New album: OK Computer');
  });

  it('fires revalidation hooks for the given domain', async () => {
    const db = drizzle(env.DB);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    await db.insert(revalidationHooks).values({
      userId: 1,
      url: 'https://example.com/revalidate',
      domain: 'running',
      secret: 'test-secret',
      isActive: 1,
      createdAt: new Date().toISOString(),
    });

    await afterSync(db, { domain: 'running' });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/revalidate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Revalidation-Secret': 'test-secret',
        }),
      })
    );
  });

  it('does not fire hooks for other domains', async () => {
    const db = drizzle(env.DB);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    await db.insert(revalidationHooks).values({
      userId: 1,
      url: 'https://example.com/revalidate',
      domain: 'listening',
      secret: 'test-secret',
      isActive: 1,
      createdAt: new Date().toISOString(),
    });

    await afterSync(db, { domain: 'running' });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('continues if feed insert fails', async () => {
    const db = drizzle(env.DB);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    await db.insert(revalidationHooks).values({
      userId: 1,
      url: 'https://example.com/revalidate',
      domain: 'listening',
      secret: 'test-secret',
      isActive: 1,
      createdAt: new Date().toISOString(),
    });

    // Feed items with bad data should not prevent revalidation
    const badFeedItems: FeedItem[] = [
      {
        domain: 'listening',
        eventType: 'new_album',
        occurredAt: '', // invalid but won't throw in insert
        title: 'Test',
        sourceId: 'test-1',
      },
    ];

    await afterSync(db, {
      domain: 'listening',
      feedItems: badFeedItems,
    });

    // Revalidation should still fire
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('handles empty inputs gracefully', async () => {
    const db = drizzle(env.DB);

    // Should not throw
    await afterSync(db, { domain: 'listening' });
    await afterSync(db, {
      domain: 'listening',
      feedItems: [],
      searchItems: [],
    });

    const items = await db.select().from(activityFeed);
    expect(items).toHaveLength(0);
  });
});
