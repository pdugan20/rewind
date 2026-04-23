import { createRoute, z } from '@hono/zod-openapi';
import { inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { createOpenAPIApp } from '../lib/openapi.js';
import { PaginationMeta, errorResponses } from '../lib/schemas/common.js';
import { setCache } from '../lib/cache.js';
import { requireAuth } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';
import { normalizeForSearch } from '../lib/search-normalize.js';
import { buildCdnUrl } from '../services/images/presets.js';
import { readingItems } from '../db/schema/reading.js';
import { images } from '../db/schema/system.js';
import { embedQuery } from '../services/embeddings/reading.js';

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
  score: z.number().optional(),
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
      mode: z.enum(['keyword', 'semantic', 'hybrid']).optional().openapi({
        description:
          'Ranking mode. keyword = FTS only (default). semantic = Vectorize only (reading domain). hybrid = FTS + semantic via reciprocal rank fusion (reading domain).',
      }),
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

// Inner row shape returned from both FTS and semantic paths.
type HitRow = {
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
  score?: number;
};

type FtsResult = { rows: HitRow[]; total: number };

async function runFtsSearch(
  db: ReturnType<typeof drizzle>,
  opts: { ftsQuery: string; domain?: string; limit: number; offset: number }
): Promise<FtsResult> {
  const { ftsQuery, domain, limit, offset } = opts;
  const rows = await db.all<HitRow>(
    domain
      ? sql`WITH matches AS (
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
      : sql`WITH matches AS (
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
    domain
      ? sql`SELECT count(*) as total FROM search_index WHERE search_index MATCH ${ftsQuery} AND domain = ${domain}`
      : sql`SELECT count(*) as total FROM search_index WHERE search_index MATCH ${ftsQuery}`
  );
  return { rows, total: countRows[0]?.total ?? 0 };
}

/**
 * Run a Voyage+Vectorize semantic search for reading articles.
 * Returns the top-K articles by cosine similarity with the query embedding,
 * enriched with image rows (same shape as FTS rows) and a `score` field.
 */
async function runSemanticSearch(
  env: {
    VECTORIZE_READING: VectorizeIndex;
    VOYAGE_API_KEY: string;
    DB: D1Database;
  },
  opts: { query: string; topK: number }
): Promise<HitRow[]> {
  const vec = await embedQuery(env, opts.query);
  const matches = await env.VECTORIZE_READING.query(vec, {
    topK: opts.topK,
    returnMetadata: 'indexed',
  });

  if (matches.matches.length === 0) return [];

  const articleIds = matches.matches
    .map((m) => {
      // id shape is reading:article:{id}; extract the numeric part.
      const parts = m.id.split(':');
      return Number(parts[parts.length - 1]);
    })
    .filter((n) => Number.isFinite(n));

  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: readingItems.id,
      title: readingItems.title,
      description: readingItems.description,
      r2Key: images.r2Key,
      imageVersion: images.imageVersion,
      thumbhash: images.thumbhash,
      dominantColor: images.dominantColor,
    })
    .from(readingItems)
    .leftJoin(
      images,
      sql`${images.domain} = 'reading' AND ${images.entityType} = 'articles' AND ${images.entityId} = CAST(${readingItems.id} AS TEXT)`
    )
    .where(inArray(readingItems.id, articleIds));

  const rowById = new Map(rows.map((r) => [r.id, r]));

  return matches.matches
    .map((m) => {
      const parts = m.id.split(':');
      const id = Number(parts[parts.length - 1]);
      const r = rowById.get(id);
      if (!r) return null;
      const hit: HitRow = {
        domain: 'reading',
        entity_type: 'article',
        entity_id: String(id),
        title: r.title,
        subtitle: r.description ?? null,
        image_key: null,
        r2_key: r.r2Key ?? null,
        image_version: r.imageVersion ?? null,
        thumbhash: r.thumbhash ?? null,
        dominant_color: r.dominantColor ?? null,
        score: m.score,
      };
      return hit;
    })
    .filter((x): x is HitRow => x !== null);
}

/**
 * Reciprocal Rank Fusion.
 * Combines two ranked lists by summing 1 / (k + rank) across retrievers.
 * k=60 is the standard choice in the RRF paper.
 */
function rrfCombine(lists: HitRow[][], limit: number, k = 60): HitRow[] {
  const scores = new Map<string, number>();
  const rowByKey = new Map<string, HitRow>();

  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const key = `${r.domain}:${r.entity_type}:${r.entity_id}`;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + i + 1));
      if (!rowByKey.has(key)) rowByKey.set(key, r);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, score]) => ({ ...rowByKey.get(key)!, score }));
}

function toPayload(r: HitRow) {
  return {
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
    ...(typeof r.score === 'number' ? { score: r.score } : {}),
  };
}

// GET /v1/search -- cross-domain full-text search (+ optional semantic/hybrid)
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

  const mode = (c.req.query('mode') ?? 'keyword') as
    | 'keyword'
    | 'semantic'
    | 'hybrid';

  if (
    (mode === 'semantic' || mode === 'hybrid') &&
    domain &&
    domain !== 'reading'
  ) {
    return badRequest(
      c,
      `mode=${mode} is only supported for domain=reading (or no domain filter).`
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
    if (mode === 'semantic') {
      const hits = await runSemanticSearch(c.env as any, {
        query,
        topK: limit + offset,
      });
      const paged = hits.slice(offset, offset + limit);
      return c.json({
        data: paged.map(toPayload),
        pagination: {
          page,
          limit,
          total: hits.length,
          total_pages: Math.ceil(hits.length / limit),
        },
      });
    }

    if (mode === 'hybrid') {
      // Pull top-K from each retriever (twice the requested page size,
      // capped at 50) and fuse. Pagination applied after fusion.
      const poolSize = Math.min(Math.max(limit * 2, 20), 50);
      const [fts, semantic] = await Promise.all([
        runFtsSearch(db, {
          ftsQuery,
          domain: 'reading',
          limit: poolSize,
          offset: 0,
        }).then((r) => r.rows),
        runSemanticSearch(c.env as any, { query, topK: poolSize }),
      ]);
      const fused = rrfCombine([fts, semantic], limit + offset);
      const paged = fused.slice(offset, offset + limit);
      return c.json({
        data: paged.map(toPayload),
        pagination: {
          page,
          limit,
          total: fused.length,
          total_pages: Math.ceil(fused.length / limit),
        },
      });
    }

    // keyword (default)
    const { rows, total } = await runFtsSearch(db, {
      ftsQuery,
      domain,
      limit,
      offset,
    });
    return c.json({
      data: rows.map(toPayload),
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
