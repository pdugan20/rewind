import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import {
  attendedEventPerformers,
  attendedEvents,
  attendedEventTickets,
  performers,
  venues,
} from '../db/schema/attending.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';

describe('GET /v1/attending/year/{year}', () => {
  let token: string;

  beforeAll(async () => {
    await setupTestDb();
    token = await createTestApiKey({ name: 'year-test', scope: 'read' });
  });

  beforeEach(async () => {
    const db = drizzle(env.DB);
    await db.delete(attendedEventTickets);
    await db.delete(attendedEventPerformers);
    await db.delete(attendedEvents);
    await db.delete(performers);
    await db.delete(venues);
  });

  it('returns 404 when no attended events for the year', async () => {
    const res = await SELF.fetch('https://test/v1/attending/year/2024', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for an out-of-range year', async () => {
    const res = await SELF.fetch('https://test/v1/attending/year/1990', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it('aggregates attended events and ignores attended=0 + other years', async () => {
    const db = drizzle(env.DB);
    const [v1] = await db
      .insert(venues)
      .values({ name: 'T-Mobile Park', city: 'Seattle' })
      .returning();
    const [v2] = await db
      .insert(venues)
      .values({ name: 'Husky Stadium', city: 'Seattle' })
      .returning();
    const [p1] = await db
      .insert(performers)
      .values({ name: 'Phoebe Bridgers' })
      .returning();

    const now = new Date().toISOString();
    // Three attended in 2024, two at T-Mobile and one at Husky.
    const [e1] = await db
      .insert(attendedEvents)
      .values({
        userId: 1,
        category: 'sports',
        eventType: 'mlb_game',
        eventDate: '2024-06-15',
        title: 'Mariners vs Yankees',
        venueId: v1.id,
        attended: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await db.insert(attendedEvents).values({
      userId: 1,
      category: 'sports',
      eventType: 'mlb_game',
      eventDate: '2024-06-22',
      title: 'Mariners vs Astros',
      venueId: v1.id,
      attended: 1,
      createdAt: now,
      updatedAt: now,
    });
    const [e3] = await db
      .insert(attendedEvents)
      .values({
        userId: 1,
        category: 'music',
        eventType: 'concert',
        eventDate: '2024-09-12',
        title: 'Phoebe Bridgers',
        venueId: v2.id,
        attended: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    // attended=0 — should be excluded
    await db.insert(attendedEvents).values({
      userId: 1,
      category: 'sports',
      eventType: 'mlb_game',
      eventDate: '2024-07-04',
      title: 'Skipped game',
      venueId: v1.id,
      attended: 0,
      createdAt: now,
      updatedAt: now,
    });
    // Wrong year — should be excluded
    await db.insert(attendedEvents).values({
      userId: 1,
      category: 'sports',
      eventType: 'mlb_game',
      eventDate: '2023-08-01',
      title: 'Last year',
      venueId: v1.id,
      attended: 1,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(attendedEventPerformers).values({
      eventId: e3.id,
      performerId: p1.id,
      role: 'headliner',
    });
    await db.insert(attendedEventTickets).values({
      userId: 1,
      eventId: e1.id,
      vendor: 'ticketmaster',
      orderId: 'TM-1',
      totalPriceCents: 12000,
      currency: 'USD',
      sourceType: 'gmail',
      createdAt: now,
    });

    const res = await SELF.fetch('https://test/v1/attending/year/2024', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      year: number;
      total_events: number;
      total_spent_cents: number;
      by_category: Array<{ category: string; count: number }>;
      by_event_type: Array<{ event_type: string; count: number }>;
      monthly: Array<{ month: string; count: number }>;
      top_venues: Array<{ name: string; count: number }>;
      top_performers: Array<{ name: string; count: number }>;
      events: Array<{ title: string }>;
    };

    expect(body.year).toBe(2024);
    expect(body.total_events).toBe(3);
    expect(body.total_spent_cents).toBe(12000);

    expect(body.by_category).toEqual(
      expect.arrayContaining([
        { category: 'sports', count: 2 },
        { category: 'music', count: 1 },
      ])
    );
    expect(body.by_event_type).toEqual(
      expect.arrayContaining([
        { event_type: 'mlb_game', count: 2 },
        { event_type: 'concert', count: 1 },
      ])
    );

    // Monthly array always has 12 rows; empty months are zero-filled.
    expect(body.monthly).toHaveLength(12);
    expect(body.monthly.find((m) => m.month === '2024-06')?.count).toBe(2);
    expect(body.monthly.find((m) => m.month === '2024-09')?.count).toBe(1);
    expect(body.monthly.find((m) => m.month === '2024-01')?.count).toBe(0);

    expect(body.top_venues[0]).toMatchObject({
      name: 'T-Mobile Park',
      count: 2,
    });
    expect(body.top_performers[0]).toMatchObject({
      name: 'Phoebe Bridgers',
      count: 1,
    });

    expect(body.events).toHaveLength(3);
    expect(body.events[0].title).toBe('Mariners vs Yankees'); // sorted by date asc
  });
});
