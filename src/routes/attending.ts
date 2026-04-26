import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import {
  attendedEventPerformers,
  attendedEventPlayers,
  attendedEvents,
  attendedEventTickets,
  performers,
  players,
  venues,
} from '../db/schema/attending.js';
import { setCache } from '../lib/cache.js';
import { getImageAttachmentBatch } from '../lib/images.js';
import { badRequest, notFound } from '../lib/errors.js';
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
  id: z.number().openapi({ example: 12 }),
  name: z.string().openapi({ example: 'T-Mobile Park' }),
  city: z.string().nullable().openapi({ example: 'Seattle' }),
  state: z.string().nullable().openapi({ example: 'WA' }),
  country: z.string().nullable().openapi({ example: 'US' }),
  latitude: z.number().nullable().openapi({ example: 47.5914 }),
  longitude: z.number().nullable().openapi({ example: -122.3325 }),
  capacity: z.number().nullable().openapi({ example: 47929 }),
});

const TicketSchema = z.object({
  id: z.number().openapi({ example: 871 }),
  vendor: z.string().openapi({ example: 'ticketmaster' }),
  order_id: z.string().nullable().openapi({ example: '32-43215/SEA' }),
  section: z.string().nullable().openapi({ example: '147' }),
  row: z.string().nullable().openapi({ example: '15' }),
  seat: z.string().nullable().openapi({ example: '12' }),
  quantity: z.number().openapi({ example: 2 }),
  total_price_cents: z.number().nullable().openapi({ example: 8400 }),
  currency: z.string().openapi({ example: 'USD' }),
  purchased_at: z
    .string()
    .nullable()
    .openapi({ example: '2024-06-15T18:42:11Z' }),
});

const AttendedEventSchema = z.object({
  id: z.number().openapi({ example: 142 }),
  category: z.string().openapi({ example: 'sports' }),
  event_type: z.string().openapi({ example: 'mlb_game' }),
  event_date: z.string().openapi({ example: '2024-08-12' }),
  event_datetime: z
    .string()
    .nullable()
    .openapi({ example: '2024-08-12T19:10:00Z' }),
  title: z.string().openapi({ example: 'Seattle Mariners vs Houston Astros' }),
  subtitle: z.string().nullable().openapi({ example: 'Mariners 4, Astros 2' }),
  series_id: z.string().nullable().openapi({ example: 'mlb-2024-mariners' }),
  external_id: z.string().nullable().openapi({ example: '745423' }),
  external_source: z.string().nullable().openapi({ example: 'mlb_stats_api' }),
  event_data: z
    .record(z.string(), z.any())
    .nullable()
    .openapi({
      example: {
        season: 2024,
        home_team: 'Seattle Mariners',
        away_team: 'Houston Astros',
        home_score: 4,
        away_score: 2,
        my_team_won: true,
        winning_pitcher: 'Logan Gilbert',
      },
    }),
  notes: z.string().nullable().openapi({ example: null }),
  attended: z.boolean().openapi({ example: true }),
  venue: VenueSchema.nullable(),
  tickets: z.array(TicketSchema),
});

const PlayerPhotoSchema = z.object({
  cdn_url: z
    .string()
    .openapi({ example: 'https://cdn.rewind.rest/.../players/silo/123' }),
  thumbhash: z.string().nullable(),
  dominant_color: z.string().nullable().openapi({ example: '#1a3a6c' }),
  accent_color: z.string().nullable().openapi({ example: '#c4ced4' }),
});

const PlayerSchema = z.object({
  id: z.number().openapi({ example: 42 }),
  league: z.string().openapi({ example: 'mlb' }),
  mlb_stats_id: z.number().nullable().openapi({ example: 663728 }),
  espn_id: z.string().nullable().openapi({ example: '41292' }),
  full_name: z.string().openapi({ example: 'Cal Raleigh' }),
  primary_position: z.string().nullable().openapi({ example: 'C' }),
  primary_number: z.string().nullable().openapi({ example: '29' }),
  birth_date: z.string().nullable().openapi({ example: '1996-11-26' }),
  birth_country: z.string().nullable().openapi({ example: 'USA' }),
  bats: z.string().nullable().openapi({ example: 'B' }),
  throws: z.string().nullable().openapi({ example: 'R' }),
  primary_team_id: z.number().nullable().openapi({ example: 136 }),
  debut_date: z.string().nullable().openapi({ example: '2021-07-11' }),
  photo_silo: PlayerPhotoSchema.nullable(),
  photo_full: PlayerPhotoSchema.nullable(),
});

const AppearanceSchema = z.object({
  player: PlayerSchema,
  team_id: z.number().nullable(),
  is_home: z.boolean(),
  batting_line: z.record(z.string(), z.any()).nullable(),
  pitching_line: z.record(z.string(), z.any()).nullable(),
  fielding_line: z.record(z.string(), z.any()).nullable(),
  decision: z.string().nullable().openapi({ example: 'W' }),
  notable: z.boolean(),
});

const AttendedEventDetailSchema = AttendedEventSchema.extend({
  players: z.array(AppearanceSchema),
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
      page: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .default(1)
        .openapi({ example: 1 }),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .openapi({ example: 20 }),
      category: z
        .enum(['sports', 'music', 'arts'])
        .optional()
        .openapi({ example: 'sports' }),
      event_type: z.string().optional().openapi({ example: 'mlb_game' }),
      season: z.coerce.number().int().optional().openapi({ example: 2024 }),
      year: z.coerce.number().int().optional().openapi({ example: 2024 }),
      venue_id: z.coerce.number().int().optional().openapi({ example: 12 }),
      attended: z.coerce
        .number()
        .int()
        .min(0)
        .max(1)
        .optional()
        .openapi({ example: 1 }),
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
  description:
    'Returns a single attended event with its venue, tickets, performers, and event_data.',
  request: {
    params: z.object({
      id: z.coerce
        .number()
        .int()
        .openapi({ param: { name: 'id', in: 'path', required: true } }),
    }),
  },
  responses: {
    200: {
      description: 'Event detail',
      content: {
        'application/json': { schema: AttendedEventDetailSchema },
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

  // Per-game player appearances (populated for MLB games via the
  // box score backfill). Joined with the players table to surface
  // bios and photo lookups.
  const appearanceRows = await db
    .select()
    .from(attendedEventPlayers)
    .leftJoin(players, eq(players.id, attendedEventPlayers.playerId))
    .where(eq(attendedEventPlayers.eventId, e.id));

  const playerIdStrings = appearanceRows
    .map((r) => (r.players ? String(r.players.id) : null))
    .filter((s): s is string => s !== null);
  const [siloMap, fullMap] = await Promise.all([
    getImageAttachmentBatch(db, 'attending', 'player_silo', playerIdStrings),
    getImageAttachmentBatch(db, 'attending', 'player_full', playerIdStrings),
  ]);

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
      players: appearanceRows
        .filter((r) => r.players != null)
        .map((r) => {
          const p = r.players!;
          const a = r.attended_event_players;
          const eid = String(p.id);
          return {
            player: {
              id: p.id,
              league: p.league,
              mlb_stats_id: p.mlbStatsId,
              espn_id: p.espnId,
              full_name: p.fullName,
              primary_position: p.primaryPosition,
              primary_number: p.primaryNumber,
              birth_date: p.birthDate,
              birth_country: p.birthCountry,
              bats: p.bats,
              throws: p.throws,
              primary_team_id: p.primaryTeamId,
              debut_date: p.debutDate,
              photo_silo: siloMap.get(eid) ?? null,
              photo_full: fullMap.get(eid) ?? null,
            },
            team_id: a.teamId,
            is_home: a.isHome === 1,
            batting_line: parseJson<Record<string, unknown>>(a.battingLine),
            pitching_line: parseJson<Record<string, unknown>>(a.pitchingLine),
            fielding_line: parseJson<Record<string, unknown>>(a.fieldingLine),
            decision: a.decision,
            notable: a.notable === 1,
          };
        }),
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
      league: z.string().openapi({
        param: { name: 'league', in: 'path', required: true },
        example: 'mlb',
      }),
      season: z.coerce
        .number()
        .int()
        .openapi({
          param: { name: 'season', in: 'path', required: true },
          example: 2024,
        }),
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
    // Only count W/L for games actually attended. Lets the
    // season-shorthand "all_home" pattern with exceptions report
    // your attended record (6-0) rather than the team's record (6-1).
    if (e.attended === 1) {
      if (ed?.my_team_won === true) wins++;
      else if (ed?.my_team_won === false) losses++;
    }
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
  description:
    'Returns the venues catalog used by attended events. Includes city, state, country, lat/long, and capacity when known.',
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
  description:
    'Returns counts of attended events broken down by category, event_type, and year. Useful for top-line stats on the portfolio page.',
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

// ─── GET /players ───────────────────────────────────────────────────

const playersListRoute = createRoute({
  method: 'get',
  path: '/players',
  operationId: 'listAttendedPlayers',
  tags: ['Attending'],
  summary: 'List players you have watched play',
  description:
    'Returns players who appeared in any attended sports event. Filterable by league and team_id. Includes both photo variants when available.',
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),
      league: z.string().optional().openapi({ example: 'mlb' }),
      team_id: z.coerce.number().int().optional().openapi({ example: 136 }),
    }),
  },
  responses: {
    200: {
      description: 'Players',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(PlayerSchema),
            pagination: PaginationMeta,
          }),
        },
      },
    },
    ...errorResponses(401),
  },
});

attending.openapi(playersListRoute, async (c) => {
  const db = createDb(c.env.DB);
  const { page, limit, league, team_id } = c.req.valid('query');
  const offset = (page - 1) * limit;

  const conditions = [eq(players.userId, 1)];
  if (league) conditions.push(eq(players.league, league));
  if (team_id) conditions.push(eq(players.primaryTeamId, team_id));
  const where = and(...conditions);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(players)
    .where(where);

  const rows = await db
    .select()
    .from(players)
    .where(where)
    .orderBy(asc(players.lastName), asc(players.firstName))
    .limit(limit)
    .offset(offset);

  const playerIds = rows.map((p) => String(p.id));
  const [siloMap, fullMap] = await Promise.all([
    getImageAttachmentBatch(db, 'attending', 'player_silo', playerIds),
    getImageAttachmentBatch(db, 'attending', 'player_full', playerIds),
  ]);

  setCache(c, 'medium');
  return c.json(
    {
      data: rows.map((p) => ({
        id: p.id,
        league: p.league,
        mlb_stats_id: p.mlbStatsId,
        espn_id: p.espnId,
        full_name: p.fullName,
        primary_position: p.primaryPosition,
        primary_number: p.primaryNumber,
        birth_date: p.birthDate,
        birth_country: p.birthCountry,
        bats: p.bats,
        throws: p.throws,
        primary_team_id: p.primaryTeamId,
        debut_date: p.debutDate,
        photo_silo: siloMap.get(String(p.id)) ?? null,
        photo_full: fullMap.get(String(p.id)) ?? null,
      })),
      pagination: paginate(page, limit, count),
    },
    200
  );
});

// ─── GET /players/:id ───────────────────────────────────────────────

const playerDetailRoute = createRoute({
  method: 'get',
  path: '/players/{id}',
  operationId: 'getAttendedPlayer',
  tags: ['Attending'],
  summary: 'Get a player you have watched play',
  description:
    "Returns the player bio with both photo variants when available, plus a list of every attended event in which they appeared along with that game's stat lines.",
  request: {
    params: z.object({
      id: z.coerce
        .number()
        .int()
        .openapi({ param: { name: 'id', in: 'path', required: true } }),
    }),
  },
  responses: {
    200: {
      description: 'Player detail',
      content: {
        'application/json': {
          schema: PlayerSchema.extend({
            appearances: z.array(
              z.object({
                event_id: z.number(),
                event_date: z.string(),
                title: z.string(),
                team_id: z.number().nullable(),
                is_home: z.boolean(),
                batting_line: z.record(z.string(), z.any()).nullable(),
                pitching_line: z.record(z.string(), z.any()).nullable(),
                decision: z.string().nullable(),
                notable: z.boolean(),
              })
            ),
          }),
        },
      },
    },
    ...errorResponses(401, 404),
  },
});

attending.openapi(playerDetailRoute, async (c) => {
  const db = createDb(c.env.DB);
  const { id } = c.req.valid('param');

  const [p] = await db
    .select()
    .from(players)
    .where(and(eq(players.id, id), eq(players.userId, 1)))
    .limit(1);
  if (!p) return notFound(c, 'Player not found') as any;

  const eid = String(p.id);
  const [siloMap, fullMap] = await Promise.all([
    getImageAttachmentBatch(db, 'attending', 'player_silo', [eid]),
    getImageAttachmentBatch(db, 'attending', 'player_full', [eid]),
  ]);

  const appearances = await db
    .select()
    .from(attendedEventPlayers)
    .leftJoin(
      attendedEvents,
      eq(attendedEvents.id, attendedEventPlayers.eventId)
    )
    .where(eq(attendedEventPlayers.playerId, id))
    .orderBy(desc(attendedEvents.eventDate));

  setCache(c, 'medium');
  return c.json(
    {
      id: p.id,
      league: p.league,
      mlb_stats_id: p.mlbStatsId,
      espn_id: p.espnId,
      full_name: p.fullName,
      primary_position: p.primaryPosition,
      primary_number: p.primaryNumber,
      birth_date: p.birthDate,
      birth_country: p.birthCountry,
      bats: p.bats,
      throws: p.throws,
      primary_team_id: p.primaryTeamId,
      debut_date: p.debutDate,
      photo_silo: siloMap.get(eid) ?? null,
      photo_full: fullMap.get(eid) ?? null,
      appearances: appearances
        .filter((r) => r.attended_events != null)
        .map((r) => {
          const a = r.attended_event_players;
          const ev = r.attended_events!;
          return {
            event_id: ev.id,
            event_date: ev.eventDate,
            title: ev.title,
            team_id: a.teamId,
            is_home: a.isHome === 1,
            batting_line: parseJson<Record<string, unknown>>(a.battingLine),
            pitching_line: parseJson<Record<string, unknown>>(a.pitchingLine),
            decision: a.decision,
            notable: a.notable === 1,
          };
        }),
    },
    200
  );
});

// ─── GET /year/{year} ───────────────────────────────────────────────

const YearParamSchema = z.object({
  year: z.coerce
    .number()
    .int()
    .openapi({
      param: { name: 'year', in: 'path', required: true },
      example: 2024,
    }),
});

const YearInReviewSchema = z.object({
  year: z.number(),
  total_events: z.number(),
  total_spent_cents: z.number(),
  by_category: z.array(z.object({ category: z.string(), count: z.number() })),
  by_event_type: z.array(
    z.object({ event_type: z.string(), count: z.number() })
  ),
  monthly: z.array(
    z.object({
      month: z.string().openapi({ example: '2024-08' }),
      count: z.number(),
    })
  ),
  top_venues: z.array(
    z.object({
      venue_id: z.number(),
      name: z.string(),
      city: z.string().nullable(),
      count: z.number(),
    })
  ),
  top_performers: z.array(
    z.object({
      performer_id: z.number(),
      name: z.string(),
      count: z.number(),
    })
  ),
  events: z.array(
    z.object({
      id: z.number(),
      event_date: z.string(),
      event_type: z.string(),
      title: z.string(),
      subtitle: z.string().nullable(),
      venue_name: z.string().nullable(),
    })
  ),
});

const yearInReviewRoute = createRoute({
  method: 'get',
  path: '/year/{year}',
  operationId: 'getAttendingYearInReview',
  tags: ['Attending'],
  summary: 'Year in review',
  description:
    'Returns a year-in-review summary for attended events: totals, monthly breakdown, top venues, top concert performers, and the full event list. 404 when no attended events exist for the year.',
  request: {
    params: YearParamSchema,
  },
  responses: {
    200: {
      description: 'Year in review',
      content: { 'application/json': { schema: YearInReviewSchema } },
    },
    ...errorResponses(400, 401, 404),
  },
});

attending.openapi(yearInReviewRoute, async (c) => {
  const db = createDb(c.env.DB);
  const { year } = c.req.valid('param');
  const currentYear = new Date().getFullYear();

  if (year < 2000 || year > currentYear + 1) {
    return badRequest(c, 'Invalid year') as any;
  }

  setCache(c, year < currentYear ? 'long' : 'medium');

  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;
  // event_date is venue-local YYYY-MM-DD; lexicographic comparison is
  // safe within a year. attended=1 only — events you didn't actually go
  // to don't count toward the recap.
  const where = and(
    eq(attendedEvents.userId, 1),
    eq(attendedEvents.attended, 1),
    gte(attendedEvents.eventDate, startDate),
    lte(attendedEvents.eventDate, endDate)
  );

  // Six aggregates fan out in parallel; same pattern as the listening
  // year-in-review (see commit 2d0a193 for the rationale).
  const totalsP = db
    .select({ total: sql<number>`count(*)` })
    .from(attendedEvents)
    .where(where);

  const byCategoryP = db
    .select({
      category: attendedEvents.category,
      count: sql<number>`count(*)`,
    })
    .from(attendedEvents)
    .where(where)
    .groupBy(attendedEvents.category)
    .orderBy(desc(sql`count(*)`));

  const byEventTypeP = db
    .select({
      event_type: attendedEvents.eventType,
      count: sql<number>`count(*)`,
    })
    .from(attendedEvents)
    .where(where)
    .groupBy(attendedEvents.eventType)
    .orderBy(desc(sql`count(*)`));

  const monthlyRowsP = db
    .select({
      month: sql<string>`substr(${attendedEvents.eventDate}, 1, 7)`,
      count: sql<number>`count(*)`,
    })
    .from(attendedEvents)
    .where(where)
    .groupBy(sql`substr(${attendedEvents.eventDate}, 1, 7)`)
    .orderBy(asc(sql`substr(${attendedEvents.eventDate}, 1, 7)`));

  const topVenuesP = db
    .select({
      venue_id: venues.id,
      name: venues.name,
      city: venues.city,
      count: sql<number>`count(*)`,
    })
    .from(attendedEvents)
    .innerJoin(venues, eq(venues.id, attendedEvents.venueId))
    .where(where)
    .groupBy(venues.id)
    .orderBy(desc(sql`count(*)`))
    .limit(5);

  const topPerformersP = db
    .select({
      performer_id: performers.id,
      name: performers.name,
      count: sql<number>`count(*)`,
    })
    .from(attendedEventPerformers)
    .innerJoin(
      performers,
      eq(performers.id, attendedEventPerformers.performerId)
    )
    .innerJoin(
      attendedEvents,
      eq(attendedEvents.id, attendedEventPerformers.eventId)
    )
    .where(where)
    .groupBy(performers.id)
    .orderBy(desc(sql`count(*)`))
    .limit(5);

  const totalSpentP = db
    .select({
      cents: sql<number>`coalesce(sum(${attendedEventTickets.totalPriceCents}), 0)`,
    })
    .from(attendedEventTickets)
    .innerJoin(
      attendedEvents,
      eq(attendedEvents.id, attendedEventTickets.eventId)
    )
    .where(where);

  const eventsListP = db
    .select({
      id: attendedEvents.id,
      event_date: attendedEvents.eventDate,
      event_type: attendedEvents.eventType,
      title: attendedEvents.title,
      subtitle: attendedEvents.subtitle,
      venue_name: venues.name,
    })
    .from(attendedEvents)
    .leftJoin(venues, eq(venues.id, attendedEvents.venueId))
    .where(where)
    .orderBy(asc(attendedEvents.eventDate));

  const [
    totals,
    byCategory,
    byEventType,
    monthlyRows,
    topVenues,
    topPerformers,
    totalSpent,
    eventsList,
  ] = await Promise.all([
    totalsP,
    byCategoryP,
    byEventTypeP,
    monthlyRowsP,
    topVenuesP,
    topPerformersP,
    totalSpentP,
    eventsListP,
  ]);

  const totalEvents = totals[0]?.total ?? 0;
  if (totalEvents === 0) {
    return notFound(c, `No attended events for year ${year}`) as any;
  }

  // Backfill missing months with zeros so consumers don't have to.
  const monthlyMap = new Map(monthlyRows.map((r) => [r.month, r.count]));
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const mm = String(i + 1).padStart(2, '0');
    const key = `${year}-${mm}`;
    return { month: key, count: monthlyMap.get(key) ?? 0 };
  });

  return c.json(
    {
      year,
      total_events: totalEvents,
      total_spent_cents: totalSpent[0]?.cents ?? 0,
      by_category: byCategory,
      by_event_type: byEventType,
      monthly,
      top_venues: topVenues,
      top_performers: topPerformers,
      events: eventsList,
    },
    200
  );
});

export default attending;
