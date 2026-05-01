import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { env } from 'cloudflare:test';
import { readingItems } from '../../db/schema/reading.js';
import { images } from '../../db/schema/system.js';
import { setupTestDb } from '../../test-helpers.js';
import { reconcileReadingDeletions } from './reconcile-deletions.js';

const ENV = {
  INSTAPAPER_CONSUMER_KEY: 'k',
  INSTAPAPER_CONSUMER_SECRET: 's',
  INSTAPAPER_ACCESS_TOKEN: 'at',
  INSTAPAPER_ACCESS_TOKEN_SECRET: 'ats',
};

async function seedDb(sourceIds: number[]) {
  const db = drizzle(env.DB);
  await db.delete(images);
  await db.delete(readingItems);
  for (const sid of sourceIds) {
    await db.insert(readingItems).values({
      userId: 1,
      itemType: 'article',
      source: 'instapaper',
      sourceId: String(sid),
      sourceHash: 'hash-stable',
      url: `https://example.com/${sid}`,
      title: `Item ${sid}`,
      savedAt: new Date().toISOString(),
    });
  }
}

/**
 * Build a fake fetch that simulates Instapaper's bookmarks/list response
 * for `have=`-based delete probing. For each request, the helper inspects
 * `folder_id` and `have=`, looks up which IDs from `have=` are NOT in the
 * given folder per the test's per-folder membership map, and emits a
 * `delete` entry for each. Items that ARE in the folder are silently
 * omitted (matches the API's "hash matches → omit" behavior).
 */
function fakeApi(
  membership: Record<string, Set<string>>,
  customFolders: number[] = []
) {
  return vi.fn(async (input: RequestInfo | URL, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/folders/list')) {
      return new Response(
        JSON.stringify(
          customFolders.map((id) => ({ folder_id: id, title: `f${id}` }))
        ),
        { status: 200 }
      );
    }
    if (url.endsWith('/bookmarks/list')) {
      const params = new URLSearchParams((init?.body as string) ?? '');
      const folder = params.get('folder_id') ?? 'unread';
      const have = params.get('have') ?? '';
      const ids = have
        .split(',')
        .filter(Boolean)
        .map((entry) => entry.split(':')[0]);
      const inFolder = membership[folder] ?? new Set<string>();
      const deletes = ids
        .filter((id) => !inFolder.has(id))
        .map((id) => ({ type: 'delete', id: Number(id) }));
      return new Response(JSON.stringify(deletes), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  }) as typeof globalThis.fetch;
}

describe('reconcileReadingDeletions', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('purges items missing from every folder; keeps items present in any folder', async () => {
    // 30 items in DB. 28 in archive, 1 in unread, 1 (id 400) is the ghost.
    const seedIds = [
      ...Array.from({ length: 28 }, (_, i) => 100 + i),
      300,
      400,
    ];
    await seedDb(seedIds);

    const archiveIds = new Set(
      Array.from({ length: 28 }, (_, i) => String(100 + i))
    );
    const unreadIds = new Set(['300']);
    globalThis.fetch = fakeApi(
      {
        unread: unreadIds,
        starred: new Set(),
        archive: archiveIds,
        '99': new Set(),
      },
      [99]
    );

    const db = drizzle(env.DB);
    const result = await reconcileReadingDeletions(db, ENV);

    expect(result.foldersScanned).toBe(4);
    expect(result.knownInDb).toBe(30);
    expect(result.candidates).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.abortedReason).toBeUndefined();

    const remaining = await db
      .select({ sourceId: readingItems.sourceId })
      .from(readingItems);
    expect(remaining.find((r) => r.sourceId === '400')).toBeUndefined();
    expect(remaining).toHaveLength(29);
  });

  it('keeps items present only in a custom folder (not unread/starred/archive)', async () => {
    // Edge case: bookmark lives only in a user-defined folder. Must NOT
    // be flagged as deleted just because the default folders don't have it.
    const seedIds = [...Array.from({ length: 29 }, (_, i) => 100 + i), 999];
    await seedDb(seedIds);

    const allOthers = new Set(
      Array.from({ length: 29 }, (_, i) => String(100 + i))
    );
    globalThis.fetch = fakeApi(
      {
        unread: allOthers,
        starred: new Set(),
        archive: new Set(),
        '77': new Set(['999']),
      },
      [77]
    );

    const db = drizzle(env.DB);
    const result = await reconcileReadingDeletions(db, ENV);

    expect(result.candidates).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it('aborts with safety_abort if more than 10% of items are flagged for deletion', async () => {
    // Seed 20 items; pretend Instapaper API reports them as missing from
    // every folder → all 20 would be candidates. Safety guard must abort.
    await seedDb(Array.from({ length: 20 }, (_, i) => i + 1));
    globalThis.fetch = fakeApi({});

    const db = drizzle(env.DB);
    const result = await reconcileReadingDeletions(db, ENV);

    expect(result.candidates).toBe(20);
    expect(result.deleted).toBe(0);
    expect(result.abortedReason).toMatch(/safety_abort/);

    const remaining = await db
      .select({ sourceId: readingItems.sourceId })
      .from(readingItems);
    expect(remaining).toHaveLength(20);
  });

  it('no-ops cleanly when DB is empty', async () => {
    await seedDb([]);
    globalThis.fetch = fakeApi({});

    const db = drizzle(env.DB);
    const result = await reconcileReadingDeletions(db, ENV);

    expect(result.candidates).toBe(0);
    expect(result.deleted).toBe(0);
  });
});
