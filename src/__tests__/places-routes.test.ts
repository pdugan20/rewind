import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createDb } from '../db/client.js';
import { checkins } from '../db/schema/places.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';

const CURRENT_YEAR = new Date().getFullYear();

describe('Places endpoints', () => {
  let readToken: string;
  let adminToken: string;

  beforeAll(async () => {
    await setupTestDb();
    readToken = await createTestApiKey({ scope: 'read', name: 'places-read' });
    adminToken = await createTestApiKey({
      scope: 'admin',
      name: 'places-admin',
    });

    const db = createDb(env.DB);
    await db.insert(checkins).values([
      {
        foursquareId: 'fsq-1',
        venueId: 'venue-coffee',
        venueName: 'Analog Coffee',
        venueCategory: 'Coffee Shop',
        venueCity: 'Seattle',
        venueState: 'WA',
        venueCountry: 'United States',
        lat: 47.62,
        lng: -122.32,
        checkedInAt: '2019-03-10T17:00:00.000Z',
        shout: 'Morning cortado',
      },
      {
        foursquareId: 'fsq-2',
        venueId: 'venue-coffee',
        venueName: 'Analog Coffee',
        venueCategory: 'Coffee Shop',
        venueCity: 'Seattle',
        venueState: 'WA',
        venueCountry: 'United States',
        lat: 47.62,
        lng: -122.32,
        checkedInAt: `${CURRENT_YEAR}-02-01T18:30:00.000Z`,
      },
      {
        foursquareId: 'fsq-3',
        venueId: 'venue-bar',
        venueName: 'Bait Shop',
        venueCategory: 'Bar',
        venueCity: 'Seattle',
        venueState: 'WA',
        venueCountry: 'United States',
        checkedInAt: `${CURRENT_YEAR}-03-05T02:15:00.000Z`,
      },
      {
        foursquareId: 'fsq-4',
        venueId: 'venue-pdx',
        venueName: "Powell's Books",
        venueCategory: 'Bookstore',
        venueCity: 'Portland',
        venueState: 'OR',
        venueCountry: 'United States',
        checkedInAt: `${CURRENT_YEAR}-04-20T21:00:00.000Z`,
      },
    ]);
  });

  describe('GET /v1/places/recent', () => {
    it('returns check-ins newest first with a pagination envelope', async () => {
      const res = await SELF.fetch('http://localhost/v1/places/recent', {
        headers: { Authorization: `Bearer ${readToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{
          id: number;
          venue_name: string;
          venue_category: string | null;
          venue_city: string | null;
          checked_in_at: string;
          shout: string | null;
        }>;
        pagination: { page: number; limit: number; total: number };
      };
      expect(body.pagination.total).toBe(4);
      expect(body.data.length).toBe(4);
      expect(body.data[0].venue_name).toBe("Powell's Books");
      expect(body.data[body.data.length - 1].shout).toBe('Morning cortado');
      // newest first ordering
      const dates = body.data.map((d) => d.checked_in_at);
      expect([...dates].sort().reverse()).toEqual(dates);
    });

    it('respects limit and page', async () => {
      const res = await SELF.fetch(
        'http://localhost/v1/places/recent?limit=2&page=2',
        { headers: { Authorization: `Bearer ${readToken}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ venue_name: string }>;
        pagination: {
          page: number;
          limit: number;
          total: number;
          total_pages: number;
        };
      };
      expect(body.pagination).toEqual({
        page: 2,
        limit: 2,
        total: 4,
        total_pages: 2,
      });
      expect(body.data.length).toBe(2);
      expect(body.data[1].venue_name).toBe('Analog Coffee');
    });

    it('filters by date', async () => {
      const res = await SELF.fetch(
        `http://localhost/v1/places/recent?date=${CURRENT_YEAR}-03-05`,
        { headers: { Authorization: `Bearer ${readToken}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ venue_name: string }>;
        pagination: { total: number };
      };
      expect(body.pagination.total).toBe(1);
      expect(body.data[0].venue_name).toBe('Bait Shop');
    });

    it('filters by from/to range', async () => {
      const res = await SELF.fetch(
        'http://localhost/v1/places/recent?from=2019-01-01T00:00:00Z&to=2019-12-31T23:59:59Z',
        { headers: { Authorization: `Bearer ${readToken}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ venue_name: string }>;
        pagination: { total: number };
      };
      expect(body.pagination.total).toBe(1);
      expect(body.data[0].venue_name).toBe('Analog Coffee');
    });

    it('requires auth', async () => {
      const res = await SELF.fetch('http://localhost/v1/places/recent');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/places/stats', () => {
    it('returns live aggregates', async () => {
      const res = await SELF.fetch('http://localhost/v1/places/stats', {
        headers: { Authorization: `Bearer ${readToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: number;
        unique_venues: number;
        this_year: number;
        top_categories: Array<{ category: string; count: number }>;
        top_cities: Array<{ city: string; count: number }>;
      };
      expect(body.total).toBe(4);
      expect(body.unique_venues).toBe(3);
      expect(body.this_year).toBe(3);
      expect(body.top_categories[0]).toEqual({
        category: 'Coffee Shop',
        count: 2,
      });
      expect(body.top_categories.length).toBe(3);
      expect(body.top_cities[0]).toEqual({ city: 'Seattle', count: 3 });
      expect(body.top_cities[1]).toEqual({ city: 'Portland', count: 1 });
    });
  });

  describe('POST /v1/admin/sync/places', () => {
    it('rejects read keys', async () => {
      const res = await SELF.fetch('http://localhost/v1/admin/sync/places', {
        method: 'POST',
        headers: { Authorization: `Bearer ${readToken}` },
      });
      expect(res.status).toBe(403);
    });

    it('returns a 500 error envelope when the Foursquare token is missing', async () => {
      // Test env has no FOURSQUARE_ACCESS_TOKEN; the route surfaces the
      // sync failure as the standard error envelope.
      const res = await SELF.fetch('http://localhost/v1/admin/sync/places', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string; status: number };
      expect(body.status).toBe(500);
      expect(body.error).toContain('FOURSQUARE_ACCESS_TOKEN');
    });
  });
});
