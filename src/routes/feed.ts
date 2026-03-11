import { Hono } from 'hono';
import { desc, eq, and, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../types/env.js';
import { activityFeed } from '../db/schema/system.js';
import { setCache } from '../lib/cache.js';
import { requireAuth } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';

const VALID_DOMAINS = ['listening', 'running', 'watching', 'collecting'];

const feed = new Hono<{ Bindings: Env }>();

feed.use('*', requireAuth('read'));

// GET /v1/feed -- cross-domain activity feed with cursor-based pagination
feed.get('/', async (c) => {
  setCache(c, 'short');

  const cursor = c.req.query('cursor');
  const limitParam = c.req.query('limit');
  const limit = Math.min(Math.max(parseInt(limitParam || '50', 10), 1), 100);

  const db = drizzle(c.env.DB);

  const conditions = [eq(activityFeed.userId, 1)];
  if (cursor) {
    conditions.push(lt(activityFeed.id, parseInt(cursor, 10)));
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

// GET /v1/feed/domain/:domain -- single-domain feed
feed.get('/domain/:domain', async (c) => {
  setCache(c, 'short');

  const domain = c.req.param('domain');
  if (!VALID_DOMAINS.includes(domain)) {
    return badRequest(
      c,
      `Invalid domain: ${domain}. Must be one of: ${VALID_DOMAINS.join(', ')}`
    );
  }

  const cursor = c.req.query('cursor');
  const limitParam = c.req.query('limit');
  const limit = Math.min(Math.max(parseInt(limitParam || '50', 10), 1), 100);

  const db = drizzle(c.env.DB);

  const conditions = [
    eq(activityFeed.userId, 1),
    eq(activityFeed.domain, domain),
  ];
  if (cursor) {
    conditions.push(lt(activityFeed.id, parseInt(cursor, 10)));
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
