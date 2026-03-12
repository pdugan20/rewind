import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { createOpenAPIApp } from '../lib/openapi.js';
import { PaginationMeta, errorResponses } from '../lib/schemas/common.js';
import { setCache } from '../lib/cache.js';
import { requireAuth } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';

const VALID_DOMAINS = ['listening', 'running', 'watching', 'collecting'];

const search = createOpenAPIApp();

search.use('*', requireAuth('read'));

const SearchResultSchema = z.object({
  domain: z.string(),
  entity_type: z.string(),
  entity_id: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  image_key: z.string().nullable(),
});

const SearchResponseSchema = z.object({
  data: z.array(SearchResultSchema),
  pagination: PaginationMeta,
});

const searchRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Search'],
  summary: 'Cross-domain search',
  description:
    'Full-text search across all data domains (listening, running, watching, collecting).',
  request: {
    query: z.object({
      q: z.string().openapi({ description: 'Search query string' }),
      domain: z
        .enum(['listening', 'running', 'watching', 'collecting'])
        .optional()
        .openapi({ description: 'Filter results to a specific domain' }),
      limit: z
        .string()
        .optional()
        .openapi({ description: 'Results per page (1-100, default 20)' }),
      page: z
        .string()
        .optional()
        .openapi({ description: 'Page number (default 1)' }),
    }),
  },
  responses: {
    200: {
      description: 'Search results with pagination',
      content: {
        'application/json': {
          schema: SearchResponseSchema,
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

// GET /v1/search -- cross-domain full-text search
search.openapi(searchRoute, async (c) => {
  setCache(c, 'short');

  const query = c.req.query('q');
  if (!query || query.trim().length === 0) {
    return badRequest(c, 'Query parameter "q" is required') as any;
  }

  const domain = c.req.query('domain');
  if (domain && !VALID_DOMAINS.includes(domain)) {
    return badRequest(
      c,
      `Invalid domain: ${domain}. Must be one of: ${VALID_DOMAINS.join(', ')}`
    ) as any;
  }

  const limitParam = c.req.query('limit');
  const limit = Math.min(Math.max(parseInt(limitParam || '20', 10), 1), 100);

  const pageParam = c.req.query('page');
  const page = Math.max(parseInt(pageParam || '1', 10), 1);
  const offset = (page - 1) * limit;

  const db = drizzle(c.env.DB);

  // Sanitize query for FTS5: escape special characters and use prefix matching
  const sanitized = query.replace(/['"*]/g, '').trim();
  const ftsQuery = sanitized
    .split(/\s+/)
    .map((term) => `${term}*`)
    .join(' ');

  try {
    let results: {
      domain: string;
      entity_type: string;
      entity_id: string;
      title: string;
      subtitle: string | null;
      image_key: string | null;
    }[];
    let total: number;

    if (domain) {
      results = await db.all(
        sql`SELECT domain, entity_type, entity_id, title, subtitle, image_key
            FROM search_index
            WHERE search_index MATCH ${ftsQuery} AND domain = ${domain}
            ORDER BY rank
            LIMIT ${limit} OFFSET ${offset}`
      );

      const countRows = await db.all<{ total: number }>(
        sql`SELECT count(*) as total
            FROM search_index
            WHERE search_index MATCH ${ftsQuery} AND domain = ${domain}`
      );
      total = countRows[0]?.total ?? 0;
    } else {
      results = await db.all(
        sql`SELECT domain, entity_type, entity_id, title, subtitle, image_key
            FROM search_index
            WHERE search_index MATCH ${ftsQuery}
            ORDER BY rank
            LIMIT ${limit} OFFSET ${offset}`
      );

      const countRows = await db.all<{ total: number }>(
        sql`SELECT count(*) as total
            FROM search_index
            WHERE search_index MATCH ${ftsQuery}`
      );
      total = countRows[0]?.total ?? 0;
    }

    return c.json({
      data: results.map((r) => ({
        domain: r.domain,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        title: r.title,
        subtitle: r.subtitle,
        image_key: r.image_key,
      })),
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    // FTS5 table may not exist yet if migration hasn't been applied
    console.log(
      `[ERROR] Search query failed: ${error instanceof Error ? error.message : 'unknown error'}`
    );
    return c.json({
      data: [],
      pagination: {
        page,
        limit,
        total: 0,
        total_pages: 0,
      },
    });
  }
});

/**
 * Upsert a search index entry. Called by domain sync services.
 */
export async function upsertSearchIndex(
  db: ReturnType<typeof drizzle>,
  item: {
    domain: string;
    entityType: string;
    entityId: string;
    title: string;
    subtitle?: string;
    imageKey?: string;
  }
) {
  try {
    // Delete existing entry if any, then re-insert
    await db.run(
      sql`DELETE FROM search_index WHERE domain = ${item.domain} AND entity_type = ${item.entityType} AND entity_id = ${item.entityId}`
    );

    await db.run(
      sql`INSERT INTO search_index (domain, entity_type, entity_id, title, subtitle, image_key) VALUES (${item.domain}, ${item.entityType}, ${item.entityId}, ${item.title}, ${item.subtitle ?? null}, ${item.imageKey ?? null})`
    );
  } catch (error) {
    console.log(
      `[ERROR] Search index upsert failed: ${error instanceof Error ? error.message : 'unknown error'}`
    );
  }
}

/**
 * Batch upsert search index entries.
 */
export async function upsertSearchIndexBatch(
  db: ReturnType<typeof drizzle>,
  items: Array<{
    domain: string;
    entityType: string;
    entityId: string;
    title: string;
    subtitle?: string;
    imageKey?: string;
  }>
) {
  for (const item of items) {
    await upsertSearchIndex(db, item);
  }
}

export default search;
