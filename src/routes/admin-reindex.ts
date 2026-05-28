/**
 * Admin maintenance endpoints:
 *   POST /v1/admin/reindex-search   -- rebuild FTS from source tables
 *   POST /v1/admin/reenrich-reading -- retry enrichArticle for failed rows
 */

import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses } from '../lib/schemas/common.js';
import { createDb } from '../db/client.js';
import { eq, sql } from 'drizzle-orm';
import { upsertSearchIndexBatch, type SearchIndexItem } from './search.js';
import { readingItems, readingHighlights } from '../db/schema/reading.js';
import { movies } from '../db/schema/watching.js';
import {
  lastfmArtists,
  lastfmAlbums,
  lastfmTracks,
} from '../db/schema/lastfm.js';
import { stravaActivities } from '../db/schema/strava.js';
import {
  discogsCollection,
  discogsReleases,
  discogsReleaseArtists,
  discogsArtists,
} from '../db/schema/discogs.js';
import { InstapaperClient } from '../services/instapaper/client.js';
import { enrichArticle } from '../services/instapaper/sync.js';
import { htmlToText } from '../lib/html-to-text.js';
import {
  embedArticles,
  type ArticleForEmbedding,
} from '../services/embeddings/reading.js';

const ALL_DOMAINS = [
  'reading',
  'watching',
  'listening',
  'running',
  'collecting',
] as const;
type Domain = (typeof ALL_DOMAINS)[number];

const adminReindex = createOpenAPIApp();

const DomainResultSchema = z.object({
  indexed: z.number(),
  took_ms: z.number(),
  total: z.number().optional(),
  has_more: z.boolean().optional(),
  next_offset: z.number().optional(),
  error: z.string().optional(),
});

const ReindexResponseSchema = z.object({
  domains: z.record(z.string(), DomainResultSchema),
});

const ReindexBodySchema = z
  .object({
    domains: z.array(z.enum(ALL_DOMAINS)).optional(),
    // Chunked reindex: insert at most `chunk_size` rows per call, starting
    // from `chunk_offset`. The DELETE only runs on chunk_offset === 0.
    // Necessary for `reading` (~20K rows) where a single-pass rebuild
    // exceeds the Workers CPU budget (Cloudflare error 1102).
    chunk_size: z.number().int().min(1).max(5000).optional(),
    chunk_offset: z.number().int().min(0).optional(),
  })
  .optional();

const reindexRoute = createRoute({
  method: 'post',
  path: '/reindex-search',
  operationId: 'reindexSearch',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Rebuild the FTS search_index',
  description:
    'Truncates and repopulates the search_index FTS table from source tables. Pass `domains` in the body to limit scope; default rebuilds all five domains.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: ReindexBodySchema,
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      description: 'Reindex complete',
      content: {
        'application/json': {
          schema: ReindexResponseSchema,
        },
      },
    },
    ...errorResponses(401),
  },
});

// When the caller doesn't pass chunk_size, we still chunk internally so
// the reading domain (~20K rows × up to 12K chars body) fits inside the
// Worker memory budget. 1000 rows per slice keeps any single domain's
// resident set under ~12 MB.
const INTERNAL_CHUNK_SIZE = 1000;

adminReindex.openapi(reindexRoute, async (c) => {
  const db = createDb(c.env.DB);
  const body = (await c.req.json().catch(() => undefined)) as
    | {
        domains?: Domain[];
        chunk_size?: number;
        chunk_offset?: number;
      }
    | undefined;
  const selected: readonly Domain[] =
    body?.domains && body.domains.length > 0 ? body.domains : ALL_DOMAINS;
  const chunkSize = body?.chunk_size;
  const chunkOffset = body?.chunk_offset ?? 0;

  const results: Record<string, z.infer<typeof DomainResultSchema>> = {};

  for (const domain of selected) {
    const t0 = Date.now();
    try {
      if (chunkSize === undefined) {
        // No-chunk-size callers want the legacy single-call rebuild.
        // We still chunk internally to avoid loading the whole reading
        // domain into memory at once. Loop until no more rows.
        await db.run(sql`DELETE FROM search_index WHERE domain = ${domain}`);
        let offset = 0;
        let indexed = 0;
        let total = 0;
        while (true) {
          const { items, total: t } = await buildSearchItemsForDomain(
            db,
            domain,
            offset,
            INTERNAL_CHUNK_SIZE
          );
          total = t;
          if (items.length === 0) break;
          await upsertSearchIndexBatch(db, items);
          offset += items.length;
          indexed += items.length;
          if (offset >= total) break;
        }
        results[domain] = {
          indexed,
          took_ms: Date.now() - t0,
          total,
          has_more: false,
          next_offset: indexed,
        };
        continue;
      }

      // Caller-driven chunked path: only DELETE on the first chunk;
      // subsequent chunks append. Caller loops until has_more === false.
      if (chunkOffset === 0) {
        await db.run(sql`DELETE FROM search_index WHERE domain = ${domain}`);
      }
      const { items, total } = await buildSearchItemsForDomain(
        db,
        domain,
        chunkOffset,
        chunkSize
      );
      await upsertSearchIndexBatch(db, items);
      const nextOffset = chunkOffset + items.length;
      results[domain] = {
        indexed: items.length,
        took_ms: Date.now() - t0,
        total,
        has_more: nextOffset < total,
        next_offset: nextOffset,
      };
    } catch (error) {
      results[domain] = {
        indexed: 0,
        took_ms: Date.now() - t0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return c.json({ domains: results });
});

// ─── Re-enrichment ───────────────────────────────────────────────────

const ReenrichBodySchema = z
  .object({
    limit: z.number().int().min(1).max(2000).optional(),
    mode: z
      .enum(['failed', 'missing-images'])
      .optional()
      .describe(
        'failed (default): retry rows where enrichment_status=failed. missing-images: re-run on rows that are completed but have no og_image_url, useful after upgrading the OG-fetch headers to rescue NYT/Bloomberg-style articles.'
      ),
  })
  .optional();

const ReenrichResponseSchema = z.object({
  retried: z.number(),
  succeeded: z.number(),
  still_failed: z.number(),
  took_ms: z.number(),
});

const reenrichRoute = createRoute({
  method: 'post',
  path: '/reenrich-reading',
  operationId: 'reenrichReading',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Retry enrichment for failed reading items',
  description:
    'Iterates reading_items where enrichment_status = "failed" and re-runs enrichArticle on each. Instapaper often has full body text even when the original URL fetch 403s, so this typically rescues articles that stalled on legacy OG-fetch errors.',
  request: {
    body: {
      content: { 'application/json': { schema: ReenrichBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      description: 'Re-enrichment complete',
      content: {
        'application/json': { schema: ReenrichResponseSchema },
      },
    },
    ...errorResponses(401, 500),
  },
});

adminReindex.openapi(reenrichRoute, async (c) => {
  const env = c.env as {
    INSTAPAPER_CONSUMER_KEY: string;
    INSTAPAPER_CONSUMER_SECRET: string;
    INSTAPAPER_ACCESS_TOKEN: string;
    INSTAPAPER_ACCESS_TOKEN_SECRET: string;
    SCRAPER_API_KEY?: string;
    OPENGRAPH_IO_KEY?: string;
  };
  const db = createDb(c.env.DB);

  const body = (await c.req.json().catch(() => undefined)) as
    | { limit?: number; mode?: 'failed' | 'missing-images' }
    | undefined;
  const limit = body?.limit ?? 500;
  const mode = body?.mode ?? 'failed';

  const client = new InstapaperClient(
    env.INSTAPAPER_CONSUMER_KEY,
    env.INSTAPAPER_CONSUMER_SECRET,
    env.INSTAPAPER_ACCESS_TOKEN,
    env.INSTAPAPER_ACCESS_TOKEN_SECRET
  );

  const t0 = Date.now();
  const filter =
    mode === 'missing-images'
      ? sql`${readingItems.userId} = 1 AND ${readingItems.ogImageUrl} IS NULL AND ${readingItems.url} IS NOT NULL`
      : sql`${readingItems.userId} = 1 AND ${readingItems.enrichmentStatus} = 'failed'`;
  const rows = await db
    .select({
      id: readingItems.id,
      sourceId: readingItems.sourceId,
      url: readingItems.url,
    })
    .from(readingItems)
    .where(filter)
    .limit(limit);

  // Process rows in parallel. og-fallback's internal slot pool caps
  // concurrent ScraperAPI/OG.io calls at 5, matching the Hobby-tier
  // plan limit; excess wait their turn.
  const results = await Promise.all(
    rows.map(async (row) => {
      const bookmarkId = Number(row.sourceId);
      if (!bookmarkId) return false;
      try {
        await enrichArticle(db, client, row.id, bookmarkId, row.url, {
          SCRAPER_API_KEY: env.SCRAPER_API_KEY,
          OPENGRAPH_IO_KEY: env.OPENGRAPH_IO_KEY,
        });
        const [after] = await db
          .select({
            status: readingItems.enrichmentStatus,
            ogImageUrl: readingItems.ogImageUrl,
          })
          .from(readingItems)
          .where(eq(readingItems.id, row.id))
          .limit(1);
        return mode === 'missing-images'
          ? after?.ogImageUrl != null
          : after?.status === 'completed';
      } catch {
        return false;
      }
    })
  );
  const succeeded = results.filter(Boolean).length;
  const stillFailed = results.length - succeeded;

  return c.json({
    retried: rows.length,
    succeeded,
    still_failed: stillFailed,
    took_ms: Date.now() - t0,
  });
});

// ─── Body-excerpt backfill ───────────────────────────────────────────

const BackfillBodyBodySchema = z
  .object({
    limit: z.number().int().min(1).max(5000).optional(),
    // When true, ignores the `body_excerpt IS NULL` predicate and
    // re-derives every row's excerpt from its content column. Use after
    // bumping the htmlToText maxChars cap so existing rows pick up the
    // wider window. Pair with `offset` to walk the full archive in
    // chunks; without `force`, the default path naturally exhausts
    // since each UPDATE drops a row from the NULL set.
    force: z.boolean().optional(),
    offset: z.number().int().min(0).optional(),
  })
  .optional();

const BackfillBodyResponseSchema = z.object({
  scanned: z.number(),
  updated: z.number(),
  took_ms: z.number(),
});

const backfillBodyRoute = createRoute({
  method: 'post',
  path: '/backfill-body-excerpt',
  operationId: 'backfillBodyExcerpt',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Populate reading_items.body_excerpt from existing content column',
  description:
    'Iterates reading_items and applies htmlToText to derive body_excerpt from content. Default path only touches rows where body_excerpt IS NULL. Pass force:true to re-derive every row (necessary after bumping the htmlToText cap); pair with offset for chunked pagination.',
  request: {
    body: {
      content: { 'application/json': { schema: BackfillBodyBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      description: 'Backfill complete',
      content: {
        'application/json': { schema: BackfillBodyResponseSchema },
      },
    },
    ...errorResponses(401, 500),
  },
});

adminReindex.openapi(backfillBodyRoute, async (c) => {
  const db = createDb(c.env.DB);
  const body = (await c.req.json().catch(() => undefined)) as
    | { limit?: number; force?: boolean; offset?: number }
    | undefined;
  const limit = body?.limit ?? 2000;
  const force = body?.force ?? false;
  const offset = body?.offset ?? 0;

  const t0 = Date.now();
  const rows = force
    ? await db
        .select({ id: readingItems.id, content: readingItems.content })
        .from(readingItems)
        .where(
          sql`${readingItems.userId} = 1
              AND ${readingItems.content} IS NOT NULL`
        )
        .orderBy(readingItems.id)
        .limit(limit)
        .offset(offset)
    : await db
        .select({ id: readingItems.id, content: readingItems.content })
        .from(readingItems)
        .where(
          sql`${readingItems.userId} = 1
              AND ${readingItems.bodyExcerpt} IS NULL
              AND ${readingItems.content} IS NOT NULL`
        )
        .limit(limit);

  let updated = 0;
  for (const row of rows) {
    const excerpt = htmlToText(row.content, { maxChars: 12000 });
    if (!excerpt) continue;
    await db
      .update(readingItems)
      .set({ bodyExcerpt: excerpt, updatedAt: new Date().toISOString() })
      .where(eq(readingItems.id, row.id));
    updated++;
  }

  return c.json({
    scanned: rows.length,
    updated,
    took_ms: Date.now() - t0,
  });
});

// ─── Vectorize backfill (reading embeddings) ─────────────────────────

const ReembedBodySchema = z
  .object({
    limit: z.number().int().min(1).max(5000).optional(),
    batchSize: z.number().int().min(1).max(50).optional(),
    onlyMissing: z.boolean().optional(),
    // Pagination cursor — bumps SQL OFFSET so callers can walk past
    // the first `limit` rows. Necessary for large backfills like the
    // Instapaper bulk ingest where 20K+ rows need embedding but the
    // route caps at 5000 per call.
    offset: z.number().int().min(0).optional(),
  })
  .optional();

const ReembedResponseSchema = z.object({
  scanned: z.number(),
  embedded: z.number(),
  skipped: z.number(),
  tokens: z.number(),
  took_ms: z.number(),
});

const reembedRoute = createRoute({
  method: 'post',
  path: '/reembed-reading',
  operationId: 'reembedReading',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Embed reading_items into Vectorize',
  description:
    'Iterates reading_items that have any indexable text (title/description/body_excerpt) and upserts their Voyage embeddings into the rewind-reading Vectorize index. Batches server-side.',
  request: {
    body: {
      content: { 'application/json': { schema: ReembedBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      description: 'Reembed complete',
      content: {
        'application/json': { schema: ReembedResponseSchema },
      },
    },
    ...errorResponses(401, 500),
  },
});

adminReindex.openapi(reembedRoute, async (c) => {
  const db = createDb(c.env.DB);
  const body = (await c.req.json().catch(() => undefined)) as
    | {
        limit?: number;
        batchSize?: number;
        onlyMissing?: boolean;
        offset?: number;
      }
    | undefined;
  const limit = body?.limit ?? 2000;
  const batchSize = body?.batchSize ?? 10;
  const offset = body?.offset ?? 0;

  const t0 = Date.now();

  // Select candidates: anything with *some* indexable text. We skip the
  // `onlyMissing` filter for now since Vectorize doesn't expose a cheap
  // "does vector exist" predicate; re-running is idempotent (upsert).
  // ORDER BY id makes pagination deterministic across calls.
  const rows = await db
    .select({
      id: readingItems.id,
      title: readingItems.title,
      description: readingItems.description,
      bodyExcerpt: readingItems.bodyExcerpt,
      status: readingItems.status,
      savedAt: readingItems.savedAt,
      domain: readingItems.domain,
    })
    .from(readingItems)
    .where(eq(readingItems.userId, 1))
    .orderBy(readingItems.id)
    .limit(limit)
    .offset(offset);

  const articles: ArticleForEmbedding[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    bodyExcerpt: r.bodyExcerpt,
    status: r.status,
    savedAt: r.savedAt,
    domain: r.domain,
  }));

  let embedded = 0;
  let skipped = 0;
  let tokens = 0;

  for (let i = 0; i < articles.length; i += batchSize) {
    const slice = articles.slice(i, i + batchSize);
    try {
      const result = await embedArticles(c.env, slice);
      embedded += result.embedded;
      skipped += result.skipped;
      tokens += result.tokens;
    } catch (err) {
      // Non-fatal: skip this batch, continue. Common cause would be a
      // Voyage rate limit or transient 5xx.
      skipped += slice.length;
      console.log(
        `[REEMBED] Batch ${i}-${i + slice.length} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return c.json({
    scanned: rows.length,
    embedded,
    skipped,
    tokens,
    took_ms: Date.now() - t0,
  });
});

type BuiltChunk = { items: SearchIndexItem[]; total: number };

async function buildSearchItemsForDomain(
  db: ReturnType<typeof createDb>,
  domain: Domain,
  offset: number,
  limit: number
): Promise<BuiltChunk> {
  switch (domain) {
    case 'reading':
      return buildReading(db, offset, limit);
    case 'watching':
      return buildAllThenSlice(buildWatching, db, offset, limit);
    case 'listening':
      return buildListening(db, offset, limit);
    case 'running':
      return buildAllThenSlice(buildRunning, db, offset, limit);
    case 'collecting':
      return buildAllThenSlice(buildCollecting, db, offset, limit);
  }
}

// Helper for non-reading domains: load all rows (small payloads — under
// a few thousand items, no body column), then slice in memory. Reading
// is the only domain that needs SQL-level pagination because of its
// 12K-char body column × ~20K rows.
async function buildAllThenSlice(
  fn: (db: ReturnType<typeof createDb>) => Promise<SearchIndexItem[]>,
  db: ReturnType<typeof createDb>,
  offset: number,
  limit: number
): Promise<BuiltChunk> {
  const all = await fn(db);
  return { items: all.slice(offset, offset + limit), total: all.length };
}

async function buildReading(
  db: ReturnType<typeof createDb>,
  offset: number,
  limit: number
): Promise<BuiltChunk> {
  // The combined stream is articles first (offsets [0, articleCount))
  // then highlights ([articleCount, articleCount + highlightCount)).
  // We always SQL-paginate so a 12K-char body × 20K-row archive never
  // materializes into a single Worker-resident array.
  const articleCountRow = await db
    .select({ c: sql<number>`count(*)` })
    .from(readingItems)
    .where(eq(readingItems.userId, 1));
  const articleCount = articleCountRow[0]?.c ?? 0;

  const highlightCountRow = await db
    .select({ c: sql<number>`count(*)` })
    .from(readingHighlights)
    .where(eq(readingHighlights.userId, 1));
  const highlightCount = highlightCountRow[0]?.c ?? 0;

  const total = articleCount + highlightCount;
  const items: SearchIndexItem[] = [];
  let remaining = limit;

  // Phase 1: article rows in [offset, articleCount).
  if (offset < articleCount && remaining > 0) {
    const take = Math.min(remaining, articleCount - offset);
    const rows = await db
      .select({
        id: readingItems.id,
        title: readingItems.title,
        description: readingItems.description,
        bodyExcerpt: readingItems.bodyExcerpt,
      })
      .from(readingItems)
      .where(eq(readingItems.userId, 1))
      .orderBy(readingItems.id)
      .limit(take)
      .offset(offset);
    for (const r of rows) {
      items.push({
        domain: 'reading',
        entityType: 'article',
        entityId: String(r.id),
        title: r.title,
        subtitle: r.description ?? undefined,
        body: r.bodyExcerpt ?? undefined,
      });
    }
    remaining -= rows.length;
  }

  // Phase 2: highlights, picking up wherever the article phase left off.
  // Title = first 80 chars of the highlight text, subtitle = parent
  // article title, body = full text + optional note so long highlights
  // still match on body.
  if (remaining > 0) {
    const consumedSoFar = limit - remaining; // items already pulled
    const globalCursor = offset + consumedSoFar;
    const hlOffset = Math.max(0, globalCursor - articleCount);
    if (hlOffset < highlightCount) {
      const rows = await db
        .select({
          id: readingHighlights.id,
          text: readingHighlights.text,
          note: readingHighlights.note,
          parentTitle: readingItems.title,
        })
        .from(readingHighlights)
        .innerJoin(readingItems, eq(readingHighlights.itemId, readingItems.id))
        .where(eq(readingHighlights.userId, 1))
        .orderBy(readingHighlights.id)
        .limit(remaining)
        .offset(hlOffset);
      for (const h of rows) {
        const text = h.text ?? '';
        const title = text.length > 80 ? text.slice(0, 80) + '…' : text;
        const body = h.note ? `${text} ${h.note}` : text;
        items.push({
          domain: 'reading',
          entityType: 'highlight',
          entityId: String(h.id),
          title,
          subtitle: h.parentTitle,
          body: body.length > title.length ? body : undefined,
        });
      }
    }
  }

  return { items, total };
}

async function buildWatching(
  db: ReturnType<typeof createDb>
): Promise<SearchIndexItem[]> {
  const rows = await db
    .select({
      id: movies.id,
      title: movies.title,
      year: movies.year,
    })
    .from(movies)
    .where(eq(movies.userId, 1));

  return rows.map((m) => ({
    domain: 'watching',
    entityType: 'movie',
    entityId: String(m.id),
    title: m.title,
    subtitle: m.year ? String(m.year) : undefined,
  }));
}

// Streaming reindex for listening. The combined stream is
//   artists  [0,                   artistCount)
//   albums   [artistCount,         artistCount + albumCount)
//   tracks   [artistCount + albumCount, total)
// Album/track subtitle is the artist name, joined at SQL time to avoid
// materializing the full artist map. Mirrors buildReading's
// segment-by-segment cursor so the legacy buildAllThenSlice path
// (which loaded all ~46K rows into Worker memory) is no longer needed
// for this domain.
async function buildListening(
  db: ReturnType<typeof createDb>,
  offset: number,
  limit: number
): Promise<BuiltChunk> {
  const artistCountRow = await db
    .select({ c: sql<number>`count(*)` })
    .from(lastfmArtists)
    .where(eq(lastfmArtists.userId, 1));
  const artistCount = Number(artistCountRow[0]?.c ?? 0);

  const albumCountRow = await db
    .select({ c: sql<number>`count(*)` })
    .from(lastfmAlbums)
    .where(eq(lastfmAlbums.userId, 1));
  const albumCount = Number(albumCountRow[0]?.c ?? 0);

  const trackCountRow = await db
    .select({ c: sql<number>`count(*)` })
    .from(lastfmTracks)
    .where(eq(lastfmTracks.userId, 1));
  const trackCount = Number(trackCountRow[0]?.c ?? 0);

  const total = artistCount + albumCount + trackCount;
  const items: SearchIndexItem[] = [];
  let cursor = offset;
  let remaining = limit;

  // Segment 1: artists
  if (cursor < artistCount && remaining > 0) {
    const take = Math.min(remaining, artistCount - cursor);
    const rows = await db
      .select({ id: lastfmArtists.id, name: lastfmArtists.name })
      .from(lastfmArtists)
      .where(eq(lastfmArtists.userId, 1))
      .orderBy(lastfmArtists.id)
      .limit(take)
      .offset(cursor);
    for (const r of rows) {
      items.push({
        domain: 'listening',
        entityType: 'artist',
        entityId: String(r.id),
        title: r.name,
      });
    }
    cursor += rows.length;
    remaining -= rows.length;
  }

  // Segment 2: albums (with artist-name subtitle via JOIN)
  if (cursor < artistCount + albumCount && remaining > 0) {
    const segmentOffset = Math.max(0, cursor - artistCount);
    const take = Math.min(remaining, artistCount + albumCount - cursor);
    const rows = await db
      .select({
        id: lastfmAlbums.id,
        name: lastfmAlbums.name,
        artistName: lastfmArtists.name,
      })
      .from(lastfmAlbums)
      .innerJoin(lastfmArtists, eq(lastfmAlbums.artistId, lastfmArtists.id))
      .where(eq(lastfmAlbums.userId, 1))
      .orderBy(lastfmAlbums.id)
      .limit(take)
      .offset(segmentOffset);
    for (const r of rows) {
      items.push({
        domain: 'listening',
        entityType: 'album',
        entityId: String(r.id),
        title: r.name,
        subtitle: r.artistName ?? undefined,
      });
    }
    cursor += rows.length;
    remaining -= rows.length;
  }

  // Segment 3: tracks
  if (cursor < total && remaining > 0) {
    const segmentOffset = Math.max(0, cursor - artistCount - albumCount);
    const take = Math.min(remaining, total - cursor);
    const rows = await db
      .select({
        id: lastfmTracks.id,
        name: lastfmTracks.name,
        artistName: lastfmArtists.name,
      })
      .from(lastfmTracks)
      .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
      .where(eq(lastfmTracks.userId, 1))
      .orderBy(lastfmTracks.id)
      .limit(take)
      .offset(segmentOffset);
    for (const r of rows) {
      items.push({
        domain: 'listening',
        entityType: 'track',
        entityId: String(r.id),
        title: r.name,
        subtitle: r.artistName ?? undefined,
      });
    }
  }

  return { items, total };
}

async function buildRunning(
  db: ReturnType<typeof createDb>
): Promise<SearchIndexItem[]> {
  const rows = await db
    .select({
      id: stravaActivities.id,
      name: stravaActivities.name,
      city: stravaActivities.city,
    })
    .from(stravaActivities)
    .where(eq(stravaActivities.userId, 1));

  return rows.map((a) => ({
    domain: 'running',
    entityType: 'activity',
    entityId: String(a.id),
    title: a.name ?? 'Run',
    subtitle: a.city ?? undefined,
  }));
}

async function buildCollecting(
  db: ReturnType<typeof createDb>
): Promise<SearchIndexItem[]> {
  // Build artist subtitle by joining release -> release_artists -> artists.
  // A release can have multiple artists; we just take the first for subtitle.
  const rows = await db
    .select({
      releaseId: discogsCollection.releaseId,
      title: discogsReleases.title,
    })
    .from(discogsCollection)
    .innerJoin(
      discogsReleases,
      eq(discogsCollection.releaseId, discogsReleases.id)
    )
    .where(eq(discogsCollection.userId, 1));

  const artistJoin = await db
    .select({
      releaseId: discogsReleaseArtists.releaseId,
      artistName: discogsArtists.name,
    })
    .from(discogsReleaseArtists)
    .innerJoin(
      discogsArtists,
      eq(discogsReleaseArtists.artistId, discogsArtists.id)
    );
  const firstArtistByRelease = new Map<number, string>();
  for (const row of artistJoin) {
    if (!firstArtistByRelease.has(row.releaseId)) {
      firstArtistByRelease.set(row.releaseId, row.artistName);
    }
  }

  return rows.map((r) => ({
    domain: 'collecting',
    entityType: 'release',
    entityId: String(r.releaseId),
    title: r.title ?? 'Untitled',
    subtitle: firstArtistByRelease.get(r.releaseId),
  }));
}

// ─── Clear reading image placeholders ────────────────────────────────
// When the image pipeline fails for an article, it inserts a row in
// `images` with source='none' as a placeholder so we don't retry
// endlessly. But that placeholder persists even after a later tier-3/4
// OG rescue populates og_image_url — processReadingImages will never
// re-pick the article because its id is in the images table.
//
// This endpoint clears placeholders for articles whose og_image_url
// has been populated since the placeholder was inserted, unblocking
// them so processReadingImages (or POST /v1/reading/admin/backfill-images)
// can flow the new URL into R2 + thumbhash + CDN.

const ClearPlaceholdersResponseSchema = z.object({
  cleared: z.number(),
  took_ms: z.number(),
});

const clearPlaceholdersRoute = createRoute({
  method: 'post',
  path: '/clear-reading-image-placeholders',
  operationId: 'clearReadingImagePlaceholders',
  'x-hidden': true,
  tags: ['Admin'],
  summary:
    'Clear images.source=none placeholders for reading articles with populated og_image_url',
  description:
    'Unblocks articles rescued by reenrich-reading missing-images mode so the image pipeline can process them.',
  responses: {
    200: {
      description: 'Cleared',
      content: {
        'application/json': { schema: ClearPlaceholdersResponseSchema },
      },
    },
    ...errorResponses(401, 500),
  },
});

// ─── One-shot: titlecase URL-shaped authors ──────────────────────────
// NYT (and some other sources) put a URL like
//   https://www.nytimes.com/by/mike-isaac
// in `article:author` meta instead of a name. Forward-facing extraction
// now converts these at sync time, but existing rows need a one-shot
// cleanup. Converts the last path slug to titlecase.

const CleanupAuthorsResponseSchema = z.object({
  scanned: z.number(),
  updated: z.number(),
  took_ms: z.number(),
});

const cleanupAuthorsRoute = createRoute({
  method: 'post',
  path: '/cleanup-reading-url-authors',
  operationId: 'cleanupReadingUrlAuthors',
  'x-hidden': true,
  tags: ['Admin'],
  summary:
    "Titlecase URL-shaped authors (e.g. 'https://.../by/mike-isaac' → 'Mike Isaac')",
  description:
    'Iterates reading_items where author starts with "http" (URL-shaped due to the source\'s `article:author` meta tag), strips the path slug, and titlecases it (e.g. `mike-isaac` → `Mike Isaac`). One-shot cleanup; forward sync now does this transformation at write time.',
  responses: {
    200: {
      description: 'Cleanup complete',
      content: {
        'application/json': { schema: CleanupAuthorsResponseSchema },
      },
    },
    ...errorResponses(401, 500),
  },
});

adminReindex.openapi(cleanupAuthorsRoute, async (c) => {
  const db = createDb(c.env.DB);
  const t0 = Date.now();
  const rows = await db
    .select({ id: readingItems.id, author: readingItems.author })
    .from(readingItems)
    .where(sql`${readingItems.author} LIKE 'http%'`);

  let updated = 0;
  for (const row of rows) {
    const raw = row.author;
    if (!raw) continue;
    const slug = raw.replace(/\/+$/, '').split('/').pop();
    if (!slug) continue;
    const titled = slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    if (titled && titled !== raw) {
      await db
        .update(readingItems)
        .set({ author: titled })
        .where(eq(readingItems.id, row.id));
      updated++;
    }
  }

  return c.json({
    scanned: rows.length,
    updated,
    took_ms: Date.now() - t0,
  });
});

adminReindex.openapi(clearPlaceholdersRoute, async (c) => {
  const db = createDb(c.env.DB);
  const t0 = Date.now();
  const result = await db.run(sql`
    DELETE FROM images
    WHERE domain = 'reading'
      AND entity_type = 'articles'
      AND source = 'none'
      AND CAST(entity_id AS INTEGER) IN (
        SELECT id FROM reading_items
        WHERE og_image_url IS NOT NULL
      )
  `);
  return c.json({
    cleared: Number(
      (result as { meta?: { changes?: number } }).meta?.changes ?? 0
    ),
    took_ms: Date.now() - t0,
  });
});

export default adminReindex;
