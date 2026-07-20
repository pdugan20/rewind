import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { eq, sql, asc } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import { checkins } from '../../db/schema/places.js';
import { syncRuns } from '../../db/schema/system.js';
import { setupTestDbWithFts5 } from '../../test-helpers.js';
import { syncCheckins, syncPlaces, buildCheckinFeedItem } from './sync.js';
import type { FoursquareClient, FoursquareCheckin } from './client.js';
import type { Env } from '../../types/env.js';

function checkin(
  n: number,
  overrides: Partial<FoursquareCheckin> = {}
): FoursquareCheckin {
  return {
    id: `chk${n}`,
    createdAt: 1700000000 + n * 86400,
    venue: {
      id: `venue${n}`,
      name: `Venue ${n}`,
      categories: [
        { name: 'Secondary Category' },
        { name: 'Coffee Shop', primary: true },
      ],
      location: {
        city: 'Seattle',
        state: 'WA',
        country: 'United States',
        lat: 47.6 + n * 0.001,
        lng: -122.3,
      },
    },
    ...overrides,
  };
}

/**
 * Slice-serving fake: pages come from a single fixture array so any
 * offset the sync asks for returns the right window, including overlap.
 * Returns pageSize items per call regardless of the requested limit,
 * which lets tests exercise multi-page walks with small fixtures.
 */
function makeClient(
  all: FoursquareCheckin[],
  { pageSize = 250, count = all.length } = {}
): { client: FoursquareClient; calls: { offset: number; limit: number }[] } {
  const calls: { offset: number; limit: number }[] = [];
  const client = {
    getCheckins: async ({ offset = 0, limit = 250 } = {}) => {
      calls.push({ offset, limit });
      return { items: all.slice(offset, offset + pageSize), count };
    },
  } as unknown as FoursquareClient;
  return { client, calls };
}

beforeAll(async () => {
  await setupTestDbWithFts5();
});

describe('buildCheckinFeedItem', () => {
  it('builds a places checkin feed item with a stable source id', () => {
    const item = buildCheckinFeedItem({
      foursquareId: 'abc123',
      venueId: 'v1',
      venueName: 'Victrola Coffee',
      venueCity: 'Seattle',
      checkedInAt: '2026-07-01T18:00:00.000Z',
    });
    expect(item).toEqual({
      domain: 'places',
      eventType: 'checkin',
      occurredAt: '2026-07-01T18:00:00.000Z',
      title: 'Checked in at Victrola Coffee',
      sourceId: 'foursquare:checkin:abc123',
    });
  });
});

describe('syncCheckins', () => {
  it('walks a bounded batch oldest-first and reports remaining from the API count', async () => {
    const db = createDb(env.DB);
    const all = Array.from({ length: 10 }, (_, i) => checkin(i));
    const { client, calls } = makeClient(all, { pageSize: 2 });

    const result = await syncCheckins(db, client, 1, { maxPages: 2 });

    expect(result.synced).toBe(4);
    expect(result.skipped).toBe(0);
    expect(result.remaining).toBe(6);
    expect(calls.map((c) => c.offset)).toEqual([0, 2]);

    const rows = await db
      .select()
      .from(checkins)
      .orderBy(asc(checkins.checkedInAt));
    expect(rows).toHaveLength(4);
    expect(rows[0].foursquareId).toBe('chk0');
    expect(rows[0].venueName).toBe('Venue 0');
    expect(rows[0].venueCategory).toBe('Coffee Shop'); // primary wins
    expect(rows[0].venueCity).toBe('Seattle');
    expect(rows[0].venueState).toBe('WA');
    expect(rows[0].venueCountry).toBe('United States');
    expect(rows[0].lat).toBeCloseTo(47.6);
    expect(rows[0].lng).toBeCloseTo(-122.3);
    expect(rows[0].userId).toBe(1);
    // Epoch seconds converted to ISO 8601
    expect(rows[0].checkedInAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('resumes from the local count cursor and finishes with remaining 0', async () => {
    const db = createDb(env.DB);
    const all = Array.from({ length: 10 }, (_, i) => checkin(i));

    const firstBatch = makeClient(all, { pageSize: 2 });
    await syncCheckins(db, firstBatch.client, 1, { maxPages: 2 });

    const secondBatch = makeClient(all, { pageSize: 2 });
    const result = await syncCheckins(db, secondBatch.client, 1, {
      maxPages: 8,
    });

    expect(secondBatch.calls[0].offset).toBe(4);
    expect(result.synced).toBe(6);
    expect(result.remaining).toBe(0);

    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(checkins);
    expect(row.count).toBe(10);
  });

  it('ignores other users when computing the offset cursor', async () => {
    const db = createDb(env.DB);
    await db.insert(checkins).values({
      userId: 2,
      foursquareId: 'other-user-chk',
      venueName: 'Elsewhere',
      checkedInAt: '2020-01-01T00:00:00.000Z',
    });

    const { calls, client } = makeClient([checkin(1)]);
    await syncCheckins(db, client, 1, { maxPages: 1 });

    expect(calls[0].offset).toBe(0);
  });

  it('skips and counts legacy checkins with no venue', async () => {
    const db = createDb(env.DB);
    const all = [checkin(0, { venue: undefined }), checkin(1), checkin(2)];
    const { client } = makeClient(all);

    const result = await syncCheckins(db, client, 1, { maxPages: 8 });

    expect(result.synced).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.remaining).toBe(0);

    const rows = await db.select().from(checkins);
    expect(rows.map((r) => r.foursquareId).sort()).toEqual(['chk1', 'chk2']);
  });

  it('deduplicates overlap on foursquare_id with truthful counts', async () => {
    const db = createDb(env.DB);
    // The venueless first item never inserts, so the count cursor lags the
    // API offset by one and the second run re-fetches an already-stored
    // checkin — the onConflictDoNothing + meta.changes guard must count it
    // as skipped, not synced.
    const all = [checkin(0, { venue: undefined }), checkin(1), checkin(2)];

    const run1 = await syncCheckins(db, makeClient(all).client, 1, {
      maxPages: 8,
    });
    expect(run1.synced).toBe(2);

    const run2 = await syncCheckins(db, makeClient(all).client, 1, {
      maxPages: 8,
    });
    expect(run2.synced).toBe(0);
    expect(run2.skipped).toBe(1);

    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(checkins);
    expect(row.count).toBe(2);
  });

  it('reports zero remaining when the API returns an empty page', async () => {
    const db = createDb(env.DB);
    const { client } = makeClient([], { count: 0 });

    const result = await syncCheckins(db, client, 1, { maxPages: 8 });
    expect(result).toMatchObject({ synced: 0, skipped: 0, remaining: 0 });
  });
});

describe('syncPlaces', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function placesEnv(token?: string): Env {
    return { ...env, FOURSQUARE_ACCESS_TOKEN: token } as unknown as Env;
  }

  it('records a completed sync run and writes feed and search items', async () => {
    const items = [checkin(1), checkin(2)];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          meta: { code: 200 },
          response: { checkins: { count: 2, items } },
        })
      )
    );

    const result = await syncPlaces(placesEnv('test-token'));

    expect(result).toEqual({ synced: 2, remaining: 0 });

    const [run] = await createDb(env.DB)
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.domain, 'places'));
    expect(run.syncType).toBe('foursquare');
    expect(run.status).toBe('completed');
    expect(run.itemsSynced).toBe(2);

    const feedRows = await env.DB.prepare(
      "SELECT source_id, event_type, title FROM activity_feed WHERE domain = 'places' ORDER BY source_id"
    ).all();
    expect(feedRows.results).toHaveLength(2);
    expect(feedRows.results[0]).toMatchObject({
      source_id: 'foursquare:checkin:chk1',
      event_type: 'checkin',
      title: 'Checked in at Venue 1',
    });

    const searchRows = await env.DB.prepare(
      "SELECT entity_type, entity_id, title FROM search_index WHERE domain = 'places' ORDER BY entity_id"
    ).all();
    expect(searchRows.results).toHaveLength(2);
    expect(searchRows.results[0]).toMatchObject({
      entity_type: 'venue',
      entity_id: 'venue1',
    });
  });

  it('marks the run failed and rethrows when the token is missing', async () => {
    await expect(syncPlaces(placesEnv(undefined))).rejects.toThrow(
      'FOURSQUARE_ACCESS_TOKEN'
    );

    const [run] = await createDb(env.DB)
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.domain, 'places'));
    expect(run.status).toBe('failed');
    expect(run.error).toContain('FOURSQUARE_ACCESS_TOKEN');
  });
});
