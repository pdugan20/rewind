import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import {
  attendedEvents,
  attendedEventTickets,
  venues,
} from '../db/schema/attending.js';
import { setCache } from '../lib/cache.js';
import { notFound } from '../lib/errors.js';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses, PaginationMeta } from '../lib/schemas/common.js';

const attending = createOpenAPIApp();

// ─── Helpers ────────────────────────────────────────────────────────

function paginate(page: number, limit: number, total: number) {
  return { page, limit, total, total_pages: Math.ceil(total / limit) };
}

function parseJson<T = unknown>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ─── Schemas ────────────────────────────────────────────────────────

const VenueSchema = z.object({
  id: z.number(),
  name: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  capacity: z.number().nullable(),
});

const TicketSchema = z.object({
  id: z.number(),
  vendor: z.string(),
  order_id: z.string().nullable(),
  section: z.string().nullable(),
  row: z.string().nullable(),
  seat: z.string().nullable(),
  quantity: z.number(),
  total_price_cents: z.number().nullable(),
  currency: z.string(),
  purchased_at: z.string().nullable(),
});

const AttendedEventSchema = z.object({
  id: z.number(),
  category: z.string(),
  event_type: z.string(),
  event_date: z.string(),
  event_datetime: z.string().nullable(),
  title: z.string(),
  subtitle: z.string().nullable(),
  series_id: z.string().nullable(),
  external_id: z.string().nullable(),
  external_source: z.string().nullable(),
  event_data: z.record(z.string(), z.any()).nullable(),
  notes: z.string().nullable(),
  attended: z.boolean(),
  venue: VenueSchema.nullable(),
  tickets: z.array(TicketSchema),
});

// ─── GET /events ────────────────────────────────────────────────────

const eventsRoute = createRoute({
  method: 'get',
  path: '/events',
  operationId: 'listAttendedEvents',
  tags: ['Attending'],
  summary: 'List attended events',
  description:
    'Returns events you have tickets for, optionally filtered by category, event_type, season, year, and venue. Includes events you bought tickets for but did not attend (attended=false).',
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      category: z.enum(['sports', 'music', 'arts']).optional(),
      event_type: z.string().optional(),
      season: z.coerce.number().int().optional(),
      year: z.coerce.number().int().optional(),
      venue_id: z.coerce.number().int().optional(),
      attended: z.coerce.number().int().min(0).max(1).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Attended events',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(AttendedEventSchema),
            pagination: PaginationMeta,
          }),
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

attending.openapi(eventsRoute, async (c) => {
  const db = createDb(c.env.DB);
  const {
    page,
    limit,
    category,
    event_type,
    season,
    year,
    venue_id,
    attended,
  } = c.req.valid('query');
  const offset = (page - 1) * limit;

  const conditions = [eq(attendedEvents.userId, 1)];
  if (category) conditions.push(eq(attendedEvents.category, category));
  if (event_type) conditions.push(eq(attendedEvents.eventType, event_type));
  if (venue_id) conditions.push(eq(attendedEvents.venueId, venue_id));
  if (attended !== undefined)
    conditions.push(eq(attendedEvents.attended, attended));
  if (year) {
    conditions.push(
      sql`substr(${attendedEvents.eventDate}, 1, 4) = ${String(year)}`
    );
  }
  if (season) {
    conditions.push(
      sql`json_extract(${attendedEvents.eventData}, '$.season') = ${season}`
    );
  }

  const where = and(...conditions);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(attendedEvents)
    .where(where);

  const rows = await db
    .select()
    .from(attendedEvents)
    .leftJoin(venues, eq(attendedEvents.venueId, venues.id))
    .where(where)
    .orderBy(desc(attendedEvents.eventDate))
    .limit(limit)
    .offset(offset);

  const eventIds = rows.map((r) => r.attended_events.id);
  const tickets = eventIds.length
    ? await db
        .select()
        .from(attendedEventTickets)
        .where(
          sql`${attendedEventTickets.eventId} IN (${sql.join(eventIds, sql`, `)})`
        )
    : [];
  const ticketsByEvent = new Map<number, typeof tickets>();
  for (const t of tickets) {
    const existing = ticketsByEvent.get(t.eventId) ?? [];
    existing.push(t);
    ticketsByEvent.set(t.eventId, existing);
  }

  const data = rows.map((r) => {
    const e = r.attended_events;
    const v = r.venues;
    return {
      id: e.id,
      category: e.category,
      event_type: e.eventType,
      event_date: e.eventDate,
      event_datetime: e.eventDatetime,
      title: e.title,
      subtitle: e.subtitle,
      series_id: e.seriesId,
      external_id: e.externalId,
      external_source: e.externalSource,
      event_data: parseJson<Record<string, unknown>>(e.eventData),
      notes: e.notes,
      attended: e.attended === 1,
      venue: v
        ? {
            id: v.id,
            name: v.name,
            city: v.city,
            state: v.state,
            country: v.country,
            latitude: v.latitude,
            longitude: v.longitude,
            capacity: v.capacity,
          }
        : null,
      tickets: (ticketsByEvent.get(e.id) ?? []).map((t) => ({
        id: t.id,
        vendor: t.vendor,
        order_id: t.orderId,
        section: t.section,
        row: t.row,
        seat: t.seat,
        quantity: t.quantity,
        total_price_cents: t.totalPriceCents,
        currency: t.currency,
        purchased_at: t.purchasedAt,
      })),
    };
  });

  setCache(c, 'short');
  return c.json({ data, pagination: paginate(page, limit, count) }, 200);
});

// ─── GET /events/:id ────────────────────────────────────────────────

const eventDetailRoute = createRoute({
  method: 'get',
  path: '/events/{id}',
  operationId: 'getAttendedEvent',
  tags: ['Attending'],
  summary: 'Get an attended event',
  request: {
    params: z.object({ id: z.coerce.number().int() }),
  },
  responses: {
    200: {
      description: 'Event detail',
      content: {
        'application/json': { schema: AttendedEventSchema },
      },
    },
    ...errorResponses(401, 404),
  },
});

attending.openapi(eventDetailRoute, async (c) => {
  const db = createDb(c.env.DB);
  const { id } = c.req.valid('param');

  const rows = await db
    .select()
    .from(attendedEvents)
    .leftJoin(venues, eq(attendedEvents.venueId, venues.id))
    .where(and(eq(attendedEvents.id, id), eq(attendedEvents.userId, 1)))
    .limit(1);

  if (!rows.length) return notFound(c, 'Event not found') as any;
  const r = rows[0];
  const e = r.attended_events;
  const v = r.venues;

  const tickets = await db
    .select()
    .from(attendedEventTickets)
    .where(eq(attendedEventTickets.eventId, e.id));

  setCache(c, 'short');
  return c.json(
    {
      id: e.id,
      category: e.category,
      event_type: e.eventType,
      event_date: e.eventDate,
      event_datetime: e.eventDatetime,
      title: e.title,
      subtitle: e.subtitle,
      series_id: e.seriesId,
      external_id: e.externalId,
      external_source: e.externalSource,
      event_data: parseJson<Record<string, unknown>>(e.eventData),
      notes: e.notes,
      attended: e.attended === 1,
      venue: v
        ? {
            id: v.id,
            name: v.name,
            city: v.city,
            state: v.state,
            country: v.country,
            latitude: v.latitude,
            longitude: v.longitude,
            capacity: v.capacity,
          }
        : null,
      tickets: tickets.map((t) => ({
        id: t.id,
        vendor: t.vendor,
        order_id: t.orderId,
        section: t.section,
        row: t.row,
        seat: t.seat,
        quantity: t.quantity,
        total_price_cents: t.totalPriceCents,
        currency: t.currency,
        purchased_at: t.purchasedAt,
      })),
    },
    200
  );
});

// ─── GET /seasons/:league/:season ───────────────────────────────────

const seasonRoute = createRoute({
  method: 'get',
  path: '/seasons/{league}/{season}',
  operationId: 'getAttendedSeason',
  tags: ['Attending'],
  summary: 'Attended games in a sports season',
  description:
    'Returns the games you attended (or hold tickets for) in a given league + season. Pair with a public schedule API (MLB Stats API, ESPN, etc.) on the consumer side to overlay attendance on the full schedule.',
  request: {
    params: z.object({
      league: z.string().openapi({ example: 'mlb' }),
      season: z.coerce.number().int().openapi({ example: 2024 }),
    }),
  },
  responses: {
    200: {
      description: 'Attended games this season',
      content: {
        'application/json': {
          schema: z.object({
            league: z.string(),
            season: z.number(),
            attended_count: z.number(),
            wins: z.number(),
            losses: z.number(),
            data: z.array(AttendedEventSchema),
          }),
        },
      },
    },
    ...errorResponses(401),
  },
});

attending.openapi(seasonRoute, async (c) => {
  const db = createDb(c.env.DB);
  const { league, season } = c.req.valid('param');
  const eventType = `${league.toLowerCase()}_game`;

  const rows = await db
    .select()
    .from(attendedEvents)
    .leftJoin(venues, eq(attendedEvents.venueId, venues.id))
    .where(
      and(
        eq(attendedEvents.userId, 1),
        eq(attendedEvents.eventType, eventType),
        sql`json_extract(${attendedEvents.eventData}, '$.season') = ${season}`
      )
    )
    .orderBy(asc(attendedEvents.eventDate));

  let wins = 0;
  let losses = 0;
  const data = rows.map((r) => {
    const e = r.attended_events;
    const v = r.venues;
    const ed = parseJson<Record<string, unknown>>(e.eventData);
    if (ed?.my_team_won === true) wins++;
    else if (ed?.my_team_won === false) losses++;
    return {
      id: e.id,
      category: e.category,
      event_type: e.eventType,
      event_date: e.eventDate,
      event_datetime: e.eventDatetime,
      title: e.title,
      subtitle: e.subtitle,
      series_id: e.seriesId,
      external_id: e.externalId,
      external_source: e.externalSource,
      event_data: ed,
      notes: e.notes,
      attended: e.attended === 1,
      venue: v
        ? {
            id: v.id,
            name: v.name,
            city: v.city,
            state: v.state,
            country: v.country,
            latitude: v.latitude,
            longitude: v.longitude,
            capacity: v.capacity,
          }
        : null,
      tickets: [],
    };
  });

  setCache(c, 'short');
  return c.json(
    {
      league,
      season,
      attended_count: data.filter((d) => d.attended).length,
      wins,
      losses,
      data,
    },
    200
  );
});

// ─── GET /venues ────────────────────────────────────────────────────

const venuesRoute = createRoute({
  method: 'get',
  path: '/venues',
  operationId: 'listVenues',
  tags: ['Attending'],
  summary: 'List venues',
  responses: {
    200: {
      description: 'Venues',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(VenueSchema) }),
        },
      },
    },
    ...errorResponses(401),
  },
});

attending.openapi(venuesRoute, async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select()
    .from(venues)
    .where(eq(venues.userId, 1))
    .orderBy(asc(venues.name));
  setCache(c, 'medium');
  return c.json(
    {
      data: rows.map((v) => ({
        id: v.id,
        name: v.name,
        city: v.city,
        state: v.state,
        country: v.country,
        latitude: v.latitude,
        longitude: v.longitude,
        capacity: v.capacity,
      })),
    },
    200
  );
});

// ─── GET /stats ─────────────────────────────────────────────────────

const statsRoute = createRoute({
  method: 'get',
  path: '/stats',
  operationId: 'getAttendingStats',
  tags: ['Attending'],
  summary: 'Aggregate attending stats',
  responses: {
    200: {
      description: 'Stats',
      content: {
        'application/json': {
          schema: z.object({
            total_events: z.number(),
            attended_events: z.number(),
            by_category: z.array(
              z.object({ category: z.string(), count: z.number() })
            ),
            by_event_type: z.array(
              z.object({ event_type: z.string(), count: z.number() })
            ),
            by_year: z.array(z.object({ year: z.string(), count: z.number() })),
          }),
        },
      },
    },
    ...errorResponses(401),
  },
});

attending.openapi(statsRoute, async (c) => {
  const db = createDb(c.env.DB);

  const [totals] = await db
    .select({
      total: sql<number>`count(*)`,
      attended: sql<number>`sum(case when ${attendedEvents.attended} = 1 then 1 else 0 end)`,
    })
    .from(attendedEvents)
    .where(eq(attendedEvents.userId, 1));

  const byCategory = await db
    .select({
      category: attendedEvents.category,
      count: sql<number>`count(*)`,
    })
    .from(attendedEvents)
    .where(eq(attendedEvents.userId, 1))
    .groupBy(attendedEvents.category);

  const byEventType = await db
    .select({
      event_type: attendedEvents.eventType,
      count: sql<number>`count(*)`,
    })
    .from(attendedEvents)
    .where(eq(attendedEvents.userId, 1))
    .groupBy(attendedEvents.eventType);

  const byYear = await db
    .select({
      year: sql<string>`substr(${attendedEvents.eventDate}, 1, 4)`,
      count: sql<number>`count(*)`,
    })
    .from(attendedEvents)
    .where(eq(attendedEvents.userId, 1))
    .groupBy(sql`substr(${attendedEvents.eventDate}, 1, 4)`)
    .orderBy(sql`substr(${attendedEvents.eventDate}, 1, 4) desc`);

  setCache(c, 'short');
  return c.json(
    {
      total_events: totals?.total ?? 0,
      attended_events: totals?.attended ?? 0,
      by_category: byCategory,
      by_event_type: byEventType,
      by_year: byYear,
    },
    200
  );
});

export default attending;
