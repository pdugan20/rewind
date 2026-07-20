import { createRoute, z } from '@hono/zod-openapi';
import { eq, and, asc, desc, gte, sql, count } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { checkins } from '../db/schema/places.js';
import { setCache } from '../lib/cache.js';
import { DateFilterQuery, buildDateCondition } from '../lib/date-filters.js';
import { createOpenAPIApp } from '../lib/openapi.js';
import {
  errorResponses,
  PaginationMeta,
  PaginationQuery,
} from '../lib/schemas/common.js';

const places = createOpenAPIApp();

// ─── Helper functions ────────────────────────────────────────────────

function paginate(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    total_pages: Math.ceil(total / limit),
  };
}

// ─── Schemas ─────────────────────────────────────────────────────────

const CheckinSchema = z.object({
  id: z.number(),
  venue_id: z.string().nullable(),
  venue_name: z.string(),
  venue_category: z.string().nullable(),
  venue_icon: z.string().nullable(),
  venue_city: z.string().nullable(),
  venue_state: z.string().nullable(),
  venue_country: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  checked_in_at: z.string(),
  shout: z.string().nullable(),
});

const CategoryCountSchema = z.object({
  category: z.string(),
  count: z.number(),
  icon: z.string().nullable(),
});

const CityCountSchema = z.object({
  city: z.string(),
  count: z.number(),
});

const TrendEntrySchema = z.object({
  period: z.string(),
  count: z.number(),
});

const VenueCountSchema = z.object({
  venue_name: z.string(),
  count: z.number(),
  icon: z.string().nullable(),
  city: z.string().nullable(),
});

const PlacesStatsSchema = z.object({
  total: z.number(),
  unique_venues: z.number(),
  this_year: z.number(),
  top_categories: z.array(CategoryCountSchema),
  top_cities: z.array(CityCountSchema),
  top_venues: z.array(VenueCountSchema),
});

// ─── Routes ──────────────────────────────────────────────────────────

// 1. GET /recent
const recentRoute = createRoute({
  method: 'get',
  path: '/recent',
  operationId: 'getPlacesRecent',
  tags: ['Places'],
  summary: 'Recent check-ins',
  description: 'Returns Foursquare/Swarm check-ins, newest first.',
  request: {
    query: PaginationQuery.merge(DateFilterQuery),
  },
  responses: {
    200: {
      description: 'Recent check-ins',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(CheckinSchema),
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                id: 4821,
                venue_id: '4b5b3f2af964a520fb0029e3',
                venue_name: 'Analog Coffee',
                venue_category: 'Coffee Shop',
                venue_icon:
                  'https://ss3.4sqi.net/img/categories_v2/food/coffeeshop_64.png',
                venue_city: 'Seattle',
                venue_state: 'WA',
                venue_country: 'United States',
                lat: 47.6205,
                lng: -122.3212,
                checked_in_at: '2026-03-18T17:05:00.000Z',
                shout: 'Morning cortado',
              },
            ],
            pagination: { page: 1, limit: 20, total: 4821, total_pages: 242 },
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

// 2. GET /stats
const statsRoute = createRoute({
  method: 'get',
  path: '/stats',
  operationId: 'getPlacesStats',
  tags: ['Places'],
  summary: 'Check-in stats',
  description:
    'Returns aggregate check-in statistics: total check-ins, unique venues, this-year count, top categories, top cities, and top venues. Optional date/from/to params scope every aggregation to the range except this_year, which always counts the current UTC year.',
  request: {
    query: DateFilterQuery,
  },
  responses: {
    200: {
      description: 'Check-in statistics',
      content: {
        'application/json': {
          schema: PlacesStatsSchema,
          example: {
            total: 4821,
            unique_venues: 1289,
            this_year: 143,
            top_categories: [
              {
                category: 'Coffee Shop',
                count: 612,
                icon: 'https://ss3.4sqi.net/img/categories_v2/food/coffeeshop_64.png',
              },
              {
                category: 'Bar',
                count: 402,
                icon: 'https://ss3.4sqi.net/img/categories_v2/nightlife/pub_64.png',
              },
            ],
            top_cities: [
              { city: 'Seattle', count: 3120 },
              { city: 'Portland', count: 288 },
            ],
            top_venues: [
              {
                venue_name: 'Analog Coffee',
                count: 96,
                icon: 'https://ss3.4sqi.net/img/categories_v2/food/coffeeshop_64.png',
                city: 'Seattle',
              },
              {
                venue_name: 'Bait Shop',
                count: 71,
                icon: 'https://ss3.4sqi.net/img/categories_v2/nightlife/pub_64.png',
                city: 'Seattle',
              },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

// 3. GET /trends
const trendsRoute = createRoute({
  method: 'get',
  path: '/trends',
  operationId: 'getPlacesTrends',
  tags: ['Places'],
  summary: 'Check-in trends',
  description:
    'Returns monthly check-in counts. Supports date filtering via from/to params.',
  request: {
    query: DateFilterQuery,
  },
  responses: {
    200: {
      description: 'Trend data',
      content: {
        'application/json': {
          schema: z.object({
            period: z.string(),
            data: z.array(TrendEntrySchema),
          }),
          example: {
            period: 'monthly',
            data: [
              { period: '2026-01', count: 14 },
              { period: '2026-02', count: 9 },
              { period: '2026-03', count: 17 },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

// ─── Handlers ────────────────────────────────────────────────────────

function formatCheckin(row: typeof checkins.$inferSelect) {
  return {
    id: row.id,
    venue_id: row.venueId,
    venue_name: row.venueName,
    venue_category: row.venueCategory,
    venue_icon: row.venueIcon,
    venue_city: row.venueCity,
    venue_state: row.venueState,
    venue_country: row.venueCountry,
    lat: row.lat,
    lng: row.lng,
    checked_in_at: row.checkedInAt,
    shout: row.shout,
  };
}

// 1. GET /recent
places.openapi(recentRoute, async (c) => {
  setCache(c, 'short');
  const db = createDb(c.env.DB);
  const { page, limit, date, from, to } = c.req.valid('query');

  const conditions = [eq(checkins.userId, 1)];
  const dateCondition = buildDateCondition(checkins.checkedInAt, {
    date,
    from,
    to,
  });
  if (dateCondition) conditions.push(dateCondition);

  const whereClause = and(...conditions);

  const [totalRow] = await db
    .select({ count: count() })
    .from(checkins)
    .where(whereClause);
  const total = totalRow?.count ?? 0;

  const rows = await db
    .select()
    .from(checkins)
    .where(whereClause)
    .orderBy(desc(checkins.checkedInAt))
    .limit(limit)
    .offset((page - 1) * limit);

  return c.json({
    data: rows.map(formatCheckin),
    pagination: paginate(page, limit, total),
  });
});

// 2. GET /stats
places.openapi(statsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const { date, from, to } = c.req.valid('query');

  const conditions = [eq(checkins.userId, 1)];
  const dateCondition = buildDateCondition(checkins.checkedInAt, {
    date,
    from,
    to,
  });
  if (dateCondition) conditions.push(dateCondition);

  const whereClause = and(...conditions);

  const yearStart = `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`;

  const [totals] = await db
    .select({
      total: count(),
      uniqueVenues: sql<number>`count(distinct ${checkins.venueId})`,
    })
    .from(checkins)
    .where(whereClause);

  // this_year is deliberately unscoped: it always counts the current UTC
  // year regardless of any date/from/to filters.
  const [thisYearRow] = await db
    .select({ thisYear: count() })
    .from(checkins)
    .where(and(eq(checkins.userId, 1), gte(checkins.checkedInAt, yearStart)));

  const topCategories = await db
    .select({
      category: checkins.venueCategory,
      count: sql<number>`count(*)`,
      // Representative icon for the category: a simple correlated pick
      // among the category's check-ins (icons rarely differ within one).
      icon: sql<string | null>`max(${checkins.venueIcon})`,
    })
    .from(checkins)
    .where(and(whereClause, sql`${checkins.venueCategory} IS NOT NULL`))
    .groupBy(checkins.venueCategory)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  const topCities = await db
    .select({
      city: checkins.venueCity,
      count: sql<number>`count(*)`,
    })
    .from(checkins)
    .where(and(whereClause, sql`${checkins.venueCity} IS NOT NULL`))
    .groupBy(checkins.venueCity)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  // Group by venue_id when present, otherwise by name: legacy venueless
  // check-ins still collapse into one entry per named venue.
  const venueKey = sql`coalesce(${checkins.venueId}, ${checkins.venueName})`;
  const topVenues = await db
    .select({
      venueName: sql<string>`max(${checkins.venueName})`,
      count: sql<number>`count(*)`,
      icon: sql<string | null>`max(${checkins.venueIcon})`,
      city: sql<string | null>`max(${checkins.venueCity})`,
    })
    .from(checkins)
    .where(whereClause)
    .groupBy(venueKey)
    .orderBy(desc(sql`count(*)`), asc(sql`max(${checkins.venueName})`))
    .limit(10);

  return c.json({
    total: totals?.total ?? 0,
    unique_venues: totals?.uniqueVenues ?? 0,
    this_year: thisYearRow?.thisYear ?? 0,
    top_categories: topCategories.map((r) => ({
      category: r.category!,
      count: r.count,
      icon: r.icon,
    })),
    top_cities: topCities.map((r) => ({ city: r.city!, count: r.count })),
    top_venues: topVenues.map((r) => ({
      venue_name: r.venueName,
      count: r.count,
      icon: r.icon,
      city: r.city,
    })),
  });
});

// 3. GET /trends
places.openapi(trendsRoute, async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);
  const { date, from, to } = c.req.valid('query');

  const conditions = [eq(checkins.userId, 1)];
  const dateCondition = buildDateCondition(checkins.checkedInAt, {
    date,
    from,
    to,
  });
  if (dateCondition) conditions.push(dateCondition);

  const monthExpr = sql`substr(${checkins.checkedInAt}, 1, 7)`;
  const trendData = await db
    .select({
      period: sql<string>`substr(${checkins.checkedInAt}, 1, 7)`,
      total: count(),
    })
    .from(checkins)
    .where(and(...conditions))
    .groupBy(monthExpr)
    .orderBy(asc(monthExpr));

  return c.json({
    period: 'monthly',
    data: trendData.map((t) => ({ period: t.period, count: t.total })),
  });
});

export default places;
