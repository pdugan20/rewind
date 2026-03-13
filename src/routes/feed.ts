import { createRoute, z } from '@hono/zod-openapi';
import { desc, eq, and, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { activityFeed } from '../db/schema/system.js';
import { setCache } from '../lib/cache.js';
import { DateFilterQuery, buildDateCondition } from '../lib/date-filters.js';
import { requireAuth } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses } from '../lib/schemas/common.js';

const VALID_DOMAINS = ['listening', 'running', 'watching', 'collecting'];

const feed = createOpenAPIApp();

feed.use('*', requireAuth('read'));

// --- Schemas ---

const CursorPaginationQuerySchema = z
  .object({
    cursor: z.string().optional().openapi({
      description: 'Cursor for pagination (feed item ID)',
      example: '42',
    }),
    limit: z.string().optional().openapi({
      description: 'Number of items per page (1-100, default 50)',
      example: '50',
    }),
  })
  .merge(DateFilterQuery);

const FeedItemSchema = z.object({
  id: z.number(),
  domain: z.string(),
  event_type: z.string(),
  occurred_at: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  image_key: z.string().nullable(),
  source_id: z.string(),
  metadata: z.any().nullable(),
  created_at: z.string(),
});

const CursorPaginationSchema = z.object({
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  limit: z.number(),
});

const FeedResponseSchema = z.object({
  data: z.array(FeedItemSchema),
  pagination: CursorPaginationSchema,
});

const DomainParamSchema = z.object({
  domain: z
    .enum(['listening', 'running', 'watching', 'collecting'] as const)
    .openapi({
      description: 'Activity domain to filter by',
      example: 'listening',
    }),
});

// --- Routes ---

const getFeedRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Feed'],
  summary: 'Cross-domain activity feed',
  description:
    'Returns a cross-domain activity feed with cursor-based pagination.',
  request: {
    query: CursorPaginationQuerySchema,
  },
  responses: {
    200: {
      description: 'Activity feed items with cursor pagination',
      content: {
        'application/json': {
          schema: FeedResponseSchema,
        },
      },
    },
    ...errorResponses(401),
  },
});

feed.openapi(getFeedRoute, async (c) => {
  setCache(c, 'short');

  const cursor = c.req.query('cursor');
  const limitParam = c.req.query('limit');
  const limit = Math.min(Math.max(parseInt(limitParam || '50', 10), 1), 100);

  const db = drizzle(c.env.DB);

  const dateCondition = buildDateCondition(activityFeed.occurredAt, {
    date: c.req.query('date'),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });

  const conditions = [eq(activityFeed.userId, 1)];
  if (cursor) {
    conditions.push(lt(activityFeed.id, parseInt(cursor, 10)));
  }
  if (dateCondition) {
    conditions.push(dateCondition);
  }

  const items = await db
    .select()
    .from(activityFeed)
    .where(and(...conditions))
    .orderBy(desc(activityFeed.occurredAt), desc(activityFeed.id))
    .limit(limit + 1);

  const hasMore = items.length > limit;
  const data = items.slice(0, limit);
  const nextCursor = hasMore ? String(data[data.length - 1].id) : null;

  return c.json({
    data: data.map(formatFeedItem),
    pagination: {
      next_cursor: nextCursor,
      has_more: hasMore,
      limit,
    },
  });
});

const getDomainFeedRoute = createRoute({
  method: 'get',
  path: '/domain/{domain}',
  tags: ['Feed'],
  summary: 'Single-domain activity feed',
  description:
    'Returns an activity feed filtered to a single domain with cursor-based pagination.',
  request: {
    params: DomainParamSchema,
    query: CursorPaginationQuerySchema,
  },
  responses: {
    200: {
      description: 'Domain-filtered activity feed items with cursor pagination',
      content: {
        'application/json': {
          schema: FeedResponseSchema,
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

feed.openapi(getDomainFeedRoute, async (c) => {
  setCache(c, 'short');

  const domain = c.req.param('domain');
  if (!VALID_DOMAINS.includes(domain)) {
    return badRequest(
      c,
      `Invalid domain: ${domain}. Must be one of: ${VALID_DOMAINS.join(', ')}`
    ) as any;
  }

  const cursor = c.req.query('cursor');
  const limitParam = c.req.query('limit');
  const limit = Math.min(Math.max(parseInt(limitParam || '50', 10), 1), 100);

  const db = drizzle(c.env.DB);

  const dateCondition = buildDateCondition(activityFeed.occurredAt, {
    date: c.req.query('date'),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });

  const conditions = [
    eq(activityFeed.userId, 1),
    eq(activityFeed.domain, domain),
  ];
  if (cursor) {
    conditions.push(lt(activityFeed.id, parseInt(cursor, 10)));
  }
  if (dateCondition) {
    conditions.push(dateCondition);
  }

  const items = await db
    .select()
    .from(activityFeed)
    .where(and(...conditions))
    .orderBy(desc(activityFeed.occurredAt), desc(activityFeed.id))
    .limit(limit + 1);

  const hasMore = items.length > limit;
  const data = items.slice(0, limit);
  const nextCursor = hasMore ? String(data[data.length - 1].id) : null;

  return c.json({
    data: data.map(formatFeedItem),
    pagination: {
      next_cursor: nextCursor,
      has_more: hasMore,
      limit,
    },
  });
});

// --- On This Day ---

const OnThisDayItemSchema = z.object({
  id: z.number(),
  domain: z.string(),
  event_type: z.string(),
  occurred_at: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  image_key: z.string().nullable(),
  source_id: z.string(),
  metadata: z.any().nullable(),
});

const OnThisDayYearSchema = z.object({
  year: z.number(),
  items: z.array(OnThisDayItemSchema),
});

const onThisDayRoute = createRoute({
  method: 'get',
  path: '/on-this-day',
  tags: ['Feed'],
  summary: 'On this day',
  description:
    'Returns activity from a given calendar date across all years, grouped by year.',
  request: {
    query: z.object({
      month: z.coerce.number().int().min(1).max(12).openapi({ example: 3 }),
      day: z.coerce.number().int().min(1).max(31).openapi({ example: 13 }),
    }),
  },
  responses: {
    200: {
      description: 'Activity grouped by year for the given date',
      content: {
        'application/json': {
          schema: z.object({
            month: z.number(),
            day: z.number(),
            years: z.array(OnThisDayYearSchema),
          }),
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

feed.openapi(onThisDayRoute, async (c) => {
  setCache(c, 'medium');
  const month = parseInt(c.req.query('month') ?? '');
  const day = parseInt(c.req.query('day') ?? '');

  if (
    isNaN(month) ||
    isNaN(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return badRequest(
      c,
      'Valid month (1-12) and day (1-31) are required'
    ) as any;
  }

  const db = drizzle(c.env.DB);
  const monthStr = String(month).padStart(2, '0');
  const dayStr = String(day).padStart(2, '0');
  const items = await db
    .select()
    .from(activityFeed)
    .where(
      and(
        eq(activityFeed.userId, 1),
        sql`substr(${activityFeed.occurredAt}, 6, 5) = ${`${monthStr}-${dayStr}`}`
      )
    )
    .orderBy(desc(activityFeed.occurredAt));

  // Group by year
  const yearMap = new Map<number, typeof items>();
  for (const item of items) {
    const year = new Date(item.occurredAt).getFullYear();
    if (!yearMap.has(year)) yearMap.set(year, []);
    yearMap.get(year)!.push(item);
  }

  const years = [...yearMap.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, yearItems]) => ({
      year,
      items: yearItems.map(formatFeedItem),
    }));

  return c.json({ month, day, years });
});

function formatFeedItem(item: typeof activityFeed.$inferSelect) {
  return {
    id: item.id,
    domain: item.domain,
    event_type: item.eventType,
    occurred_at: item.occurredAt,
    title: item.title,
    subtitle: item.subtitle,
    image_key: item.imageKey,
    source_id: item.sourceId,
    metadata: item.metadata ? JSON.parse(item.metadata) : null,
    created_at: item.createdAt,
  };
}

/**
 * Insert an activity feed item. Called by domain sync services.
 */
export async function insertFeedItem(
  db: ReturnType<typeof drizzle>,
  item: {
    domain: string;
    eventType: string;
    occurredAt: string;
    title: string;
    subtitle?: string;
    imageKey?: string;
    sourceId: string;
    metadata?: Record<string, unknown>;
    userId?: number;
  }
) {
  // Upsert: skip if sourceId + domain already exists
  const existing = await db
    .select({ id: activityFeed.id })
    .from(activityFeed)
    .where(
      and(
        eq(activityFeed.domain, item.domain),
        eq(activityFeed.sourceId, item.sourceId)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    return;
  }

  await db.insert(activityFeed).values({
    userId: item.userId ?? 1,
    domain: item.domain,
    eventType: item.eventType,
    occurredAt: item.occurredAt,
    title: item.title,
    subtitle: item.subtitle ?? null,
    imageKey: item.imageKey ?? null,
    sourceId: item.sourceId,
    metadata: item.metadata ? JSON.stringify(item.metadata) : null,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Batch insert activity feed items. Called by domain sync services.
 */
export async function insertFeedItems(
  db: ReturnType<typeof drizzle>,
  items: Array<{
    domain: string;
    eventType: string;
    occurredAt: string;
    title: string;
    subtitle?: string;
    imageKey?: string;
    sourceId: string;
    metadata?: Record<string, unknown>;
    userId?: number;
  }>
) {
  if (items.length === 0) return;

  // Get existing sourceIds for these domains to skip duplicates
  const domains = [...new Set(items.map((i) => i.domain))];
  const sourceIds = items.map((i) => i.sourceId);

  const existing = await db
    .select({
      sourceId: activityFeed.sourceId,
      domain: activityFeed.domain,
    })
    .from(activityFeed)
    .where(
      and(
        sql`${activityFeed.domain} IN (${sql.join(
          domains.map((d) => sql`${d}`),
          sql`, `
        )})`,
        sql`${activityFeed.sourceId} IN (${sql.join(
          sourceIds.map((s) => sql`${s}`),
          sql`, `
        )})`
      )
    );

  const existingSet = new Set(existing.map((e) => `${e.domain}:${e.sourceId}`));

  const newItems = items.filter(
    (i) => !existingSet.has(`${i.domain}:${i.sourceId}`)
  );

  if (newItems.length === 0) return;

  const now = new Date().toISOString();
  await db.insert(activityFeed).values(
    newItems.map((item) => ({
      userId: item.userId ?? 1,
      domain: item.domain,
      eventType: item.eventType,
      occurredAt: item.occurredAt,
      title: item.title,
      subtitle: item.subtitle ?? null,
      imageKey: item.imageKey ?? null,
      sourceId: item.sourceId,
      metadata: item.metadata ? JSON.stringify(item.metadata) : null,
      createdAt: now,
    }))
  );
}

export default feed;
