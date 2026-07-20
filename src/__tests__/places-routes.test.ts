import { describe, it, expect, beforeAll } from 'vitest';
import {
  env,
  SELF,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import app from '../index.js';
import { createDb } from '../db/client.js';
import { checkins } from '../db/schema/places.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';
import type { Env } from '../types/env.js';

const CURRENT_YEAR = new Date().getFullYear();

const COFFEE_ICON =
  'https://ss3.4sqi.net/img/categories_v2/food/coffeeshop_64.png';
const BOOK_ICON =
  'https://ss3.4sqi.net/img/categories_v2/shops/bookstore_64.png';

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
        venueIcon: COFFEE_ICON,
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
        venueIcon: COFFEE_ICON,
        venueCity: 'Seattle',
        venueState: 'WA',
        venueCountry: 'United States',
        lat: 47.62,
        lng: -122.32,
        checkedInAt: `${CURRENT_YEAR}-03-28T18:30:00.000Z`,
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
        venueIcon: BOOK_ICON,
        venueCity: 'Portland',
        venueState: 'OR',
        venueCountry: 'United States',
        checkedInAt: `${CURRENT_YEAR}-04-20T21:00:00.000Z`,
      },
      // Two venue_id-less check-ins at the same named venue: top_venues
      // must fall back to grouping by name when venue_id is null.
      {
        foursquareId: 'fsq-5',
        venueName: 'Street Taco Cart',
        checkedInAt: '2019-03-11T20:00:00.000Z',
      },
      {
        foursquareId: 'fsq-6',
        venueName: 'Street Taco Cart',
        checkedInAt: '2019-03-12T20:00:00.000Z',
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
          venue_icon: string | null;
          venue_city: string | null;
          checked_in_at: string;
          shout: string | null;
        }>;
        pagination: { page: number; limit: number; total: number };
      };
      expect(body.pagination.total).toBe(6);
      expect(body.data.length).toBe(6);
      expect(body.data[0].venue_name).toBe("Powell's Books");
      expect(body.data[0].venue_icon).toBe(BOOK_ICON);
      expect(body.data[body.data.length - 1].shout).toBe('Morning cortado');
      // Icon-less check-ins surface an explicit null.
      const bar = body.data.find((d) => d.venue_name === 'Bait Shop');
      expect(bar?.venue_icon).toBeNull();
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
        total: 6,
        total_pages: 3,
      });
      expect(body.data.length).toBe(2);
      expect(body.data[1].venue_name).toBe('Street Taco Cart');
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
      expect(body.pagination.total).toBe(3);
      expect(body.data[0].venue_name).toBe('Street Taco Cart');
      expect(body.data[2].venue_name).toBe('Analog Coffee');
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
        top_categories: Array<{
          category: string;
          count: number;
          icon: string | null;
        }>;
        top_cities: Array<{ city: string; count: number }>;
        top_venues: Array<{
          venue_name: string;
          count: number;
          icon: string | null;
          city: string | null;
        }>;
      };
      expect(body.total).toBe(6);
      expect(body.unique_venues).toBe(3);
      expect(body.this_year).toBe(3);
      expect(body.top_categories[0]).toEqual({
        category: 'Coffee Shop',
        count: 2,
        icon: COFFEE_ICON,
      });
      expect(body.top_categories.length).toBe(3);
      const bookstore = body.top_categories.find(
        (t) => t.category === 'Bookstore'
      );
      expect(bookstore?.icon).toBe(BOOK_ICON);
      // Categories whose check-ins carry no icon report null.
      const barCat = body.top_categories.find((t) => t.category === 'Bar');
      expect(barCat?.icon).toBeNull();
      expect(body.top_cities[0]).toEqual({ city: 'Seattle', count: 3 });
      expect(body.top_cities[1]).toEqual({ city: 'Portland', count: 1 });
      // Ties on count break alphabetically by venue name; venue_id-less
      // check-ins at the same named venue group together by name.
      expect(body.top_venues).toEqual([
        {
          venue_name: 'Analog Coffee',
          count: 2,
          icon: COFFEE_ICON,
          city: 'Seattle',
        },
        { venue_name: 'Street Taco Cart', count: 2, icon: null, city: null },
        { venue_name: 'Bait Shop', count: 1, icon: null, city: 'Seattle' },
        {
          venue_name: "Powell's Books",
          count: 1,
          icon: BOOK_ICON,
          city: 'Portland',
        },
      ]);
    });

    it('scopes aggregates to a from/to range while this_year stays global', async () => {
      const res = await SELF.fetch(
        'http://localhost/v1/places/stats?from=2019-01-01T00:00:00Z&to=2019-12-31T23:59:59Z',
        { headers: { Authorization: `Bearer ${readToken}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: number;
        unique_venues: number;
        this_year: number;
        top_categories: Array<{
          category: string;
          count: number;
          icon: string | null;
        }>;
        top_cities: Array<{ city: string; count: number }>;
        top_venues: Array<{
          venue_name: string;
          count: number;
          icon: string | null;
          city: string | null;
        }>;
      };
      expect(body.total).toBe(3);
      expect(body.unique_venues).toBe(1);
      // this_year ignores date filters: it always counts the current UTC year.
      expect(body.this_year).toBe(3);
      expect(body.top_categories).toEqual([
        { category: 'Coffee Shop', count: 1, icon: COFFEE_ICON },
      ]);
      expect(body.top_cities).toEqual([{ city: 'Seattle', count: 1 }]);
      expect(body.top_venues).toEqual([
        { venue_name: 'Street Taco Cart', count: 2, icon: null, city: null },
        {
          venue_name: 'Analog Coffee',
          count: 1,
          icon: COFFEE_ICON,
          city: 'Seattle',
        },
      ]);
    });

    it('scopes aggregates to a single day via date', async () => {
      const res = await SELF.fetch(
        `http://localhost/v1/places/stats?date=${CURRENT_YEAR}-04-20`,
        { headers: { Authorization: `Bearer ${readToken}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: number;
        unique_venues: number;
        this_year: number;
        top_venues: Array<{ venue_name: string; count: number }>;
      };
      expect(body.total).toBe(1);
      expect(body.unique_venues).toBe(1);
      expect(body.this_year).toBe(3);
      expect(body.top_venues).toEqual([
        {
          venue_name: "Powell's Books",
          count: 1,
          icon: BOOK_ICON,
          city: 'Portland',
        },
      ]);
    });
  });

  describe('GET /v1/places/trends', () => {
    it('returns monthly check-in counts in ascending period order', async () => {
      const res = await SELF.fetch('http://localhost/v1/places/trends', {
        headers: { Authorization: `Bearer ${readToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        period: string;
        data: Array<{ period: string; count: number }>;
      };
      expect(body.period).toBe('monthly');
      expect(body.data).toEqual([
        { period: '2019-03', count: 3 },
        { period: `${CURRENT_YEAR}-03`, count: 2 },
        { period: `${CURRENT_YEAR}-04`, count: 1 },
      ]);
    });

    it('filters by from/to range', async () => {
      const res = await SELF.fetch(
        'http://localhost/v1/places/trends?from=2019-01-01T00:00:00Z&to=2019-12-31T23:59:59Z',
        { headers: { Authorization: `Bearer ${readToken}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        period: string;
        data: Array<{ period: string; count: number }>;
      };
      expect(body.data).toEqual([{ period: '2019-03', count: 3 }]);
    });

    it('requires auth', async () => {
      const res = await SELF.fetch('http://localhost/v1/places/trends');
      expect(res.status).toBe(401);
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
      // Call the app with an env that explicitly strips the token: the
      // local .dev.vars may define FOURSQUARE_ACCESS_TOKEN, and this test
      // must neither depend on that nor make a live API call. The route
      // surfaces the sync failure as the standard error envelope.
      const tokenlessEnv = {
        ...env,
        FOURSQUARE_ACCESS_TOKEN: undefined,
      } as unknown as Env;
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request('http://localhost/v1/admin/sync/places', {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
        tokenlessEnv,
        ctx
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string; status: number };
      expect(body.status).toBe(500);
      expect(body.error).toContain('FOURSQUARE_ACCESS_TOKEN');
    });
  });
});
