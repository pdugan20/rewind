import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { createOpenAPIApp } from '../lib/openapi.js';
import { PaginationMeta, errorResponses } from '../lib/schemas/common.js';
import { setCache } from '../lib/cache.js';
import { requireAuth } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';
import { normalizeForSearch } from '../lib/search-normalize.js';
import { buildCdnUrl } from '../services/images/presets.js';

const VALID_DOMAINS = [
  'listening',
  'running',
  'watching',
  'collecting',
  'reading',
];

const search = createOpenAPIApp();

search.use('*', requireAuth('read'));

const SearchImageSchema = z.object({
  cdn_url: z.string(),
  thumbhash: z.string().nullable(),
  dominant_color: z.string().nullable(),
});

const SearchResultSchema = z.object({
  domain: z.string(),
  entity_type: z.string(),
  entity_id: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  image_key: z.string().nullable(),
  image: SearchImageSchema.nullable(),
});

const SearchResponseSchema = z.object({
  data: z.array(SearchResultSchema),
  pagination: PaginationMeta,
});

const searchRoute = createRoute({
  method: 'get',
  path: '/',
  operationId: 'getSearch',
  tags: ['Search'],
  summary: 'Cross-domain search',
  description:
    'Full-text search across all data domains (listening, running, watching, collecting, reading).',
  request: {
    query: z.object({
      q: z.string().openapi({ description: 'Search query string' }),
      domain: z
        .enum(['listening', 'running', 'watching', 'collecting', 'reading'])
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
          example: {
            data: [
              {
                domain: 'listening',
                entity_type: 'artist',
                entity_id: '189',
                title: 'Nirvana',
                subtitle: null,
                image_key: null,
                image: null,
              },
            ],
            pagination: { page: 1, limit: 20, total: 9, total_pages: 1 },
          },
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

  // Normalize (collapses dotted acronyms, lowercase, strips smart quotes) then
  // sanitize for FTS5 (drop special chars, add prefix wildcard per term).
  const normalized = normalizeForSearch(query);
  const sanitized = normalized.replace(/['"*]/g, '').trim();
  if (!sanitized) {
    return c.json({
      data: [],
      pagination: { page, limit, total: 0, total_pages: 0 },
    });
  }
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
      r2_key: string | null;
      image_version: number | null;
      thumbhash: string | null;
      dominant_color: string | null;
    }[];
    let total: number;

    // Inner CTE selects FTS matches, outer LEFT JOIN enriches with the
    // images row for (domain, entity_type, entity_id). Done as two steps
    // because FTS5 tables can't appear on the right side of a JOIN directly.
    if (domain) {
      results = await db.all(
        sql`WITH matches AS (
              SELECT domain, entity_type, entity_id, title, subtitle, image_key, rank
              FROM search_index
              WHERE search_index MATCH ${ftsQuery} AND domain = ${domain}
              ORDER BY rank
              LIMIT ${limit} OFFSET ${offset}
            )
            SELECT m.domain, m.entity_type, m.entity_id, m.title, m.subtitle, m.image_key,
                   i.r2_key, i.image_version, i.thumbhash, i.dominant_color
            FROM matches m
            LEFT JOIN images i ON i.domain = m.domain AND i.entity_type = m.entity_type AND i.entity_id = m.entity_id
            ORDER BY m.rank`
      );

      const countRows = await db.all<{ total: number }>(
        sql`SELECT count(*) as total
            FROM search_index
            WHERE search_index MATCH ${ftsQuery} AND domain = ${domain}`
      );
      total = countRows[0]?.total ?? 0;
    } else {
      results = await db.all(
        sql`WITH matches AS (
              SELECT domain, entity_type, entity_id, title, subtitle, image_key, rank
              FROM search_index
              WHERE search_index MATCH ${ftsQuery}
              ORDER BY rank
              LIMIT ${limit} OFFSET ${offset}
            )
            SELECT m.domain, m.entity_type, m.entity_id, m.title, m.subtitle, m.image_key,
                   i.r2_key, i.image_version, i.thumbhash, i.dominant_color
            FROM matches m
            LEFT JOIN images i ON i.domain = m.domain AND i.entity_type = m.entity_type AND i.entity_id = m.entity_id
            ORDER BY m.rank`
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
        image: r.r2_key
          ? {
              cdn_url: buildCdnUrl(r.r2_key, 'medium', r.image_version ?? 1),
              thumbhash: r.thumbhash,
              dominant_color: r.dominant_color,
            }
          : null,
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

export type SearchIndexItem = {
  domain: string;
  entityType: string;
  entityId: string;
  title: string;
  subtitle?: string;
  body?: string;
  imageKey?: string;
};

/**
 * Upsert a search index entry. Called by domain sync services.
 * title / subtitle / body are normalized via normalizeForSearch so dotted
 * acronyms (S.N.L.) match their collapsed form (SNL) at query time.
 */
export async function upsertSearchIndex(
  db: ReturnType<typeof drizzle>,
  item: SearchIndexItem
) {
  try {
    const title = normalizeForSearch(item.title);
    const subtitle = item.subtitle ? normalizeForSearch(item.subtitle) : null;
    const body = item.body ? normalizeForSearch(item.body) : null;
    const imageKey = item.imageKey ?? null;

    // Delete existing entry if any, then re-insert
    await db.run(
      sql`DELETE FROM search_index WHERE domain = ${item.domain} AND entity_type = ${item.entityType} AND entity_id = ${item.entityId}`
    );

    await db.run(
      sql`INSERT INTO search_index (domain, entity_type, entity_id, title, subtitle, body, image_key) VALUES (${item.domain}, ${item.entityType}, ${item.entityId}, ${title}, ${subtitle}, ${body}, ${imageKey})`
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
  items: SearchIndexItem[]
) {
  for (const item of items) {
    await upsertSearchIndex(db, item);
  }
}

export default search;
