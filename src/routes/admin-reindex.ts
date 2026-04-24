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
  error: z.string().optional(),
});

const ReindexResponseSchema = z.object({
  domains: z.record(z.string(), DomainResultSchema),
});

const ReindexBodySchema = z
  .object({
    domains: z.array(z.enum(ALL_DOMAINS)).optional(),
  })
  .optional();

const reindexRoute = createRoute({
  method: 'post',
  path: '/reindex-search',
  operationId: 'reindexSearch',
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

adminReindex.openapi(reindexRoute, async (c) => {
  const db = createDb(c.env.DB);
  const body = (await c.req.json().catch(() => undefined)) as
    | { domains?: Domain[] }
    | undefined;
  const selected: readonly Domain[] =
    body?.domains && body.domains.length > 0 ? body.domains : ALL_DOMAINS;

  const results: Record<string, z.infer<typeof DomainResultSchema>> = {};

  for (const domain of selected) {
    const t0 = Date.now();
    try {
      // Clear existing rows for this domain before inserting
      await db.run(sql`DELETE FROM search_index WHERE domain = ${domain}`);

      const items = await buildSearchItemsForDomain(db, domain);
      await upsertSearchIndexBatch(db, items);
      results[domain] = { indexed: items.length, took_ms: Date.now() - t0 };
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
  tags: ['Admin'],
  summary: 'Populate reading_items.body_excerpt from existing content column',
  description:
    'Iterates reading_items WHERE body_excerpt IS NULL AND content IS NOT NULL and applies htmlToText to derive the excerpt. Idempotent: re-running touches nothing already populated.',
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
    | { limit?: number }
    | undefined;
  const limit = body?.limit ?? 2000;

  const t0 = Date.now();
  const rows = await db
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
    const excerpt = htmlToText(row.content, { maxChars: 3000 });
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
    | { limit?: number; batchSize?: number; onlyMissing?: boolean }
    | undefined;
  const limit = body?.limit ?? 2000;
  const batchSize = body?.batchSize ?? 10;

  const t0 = Date.now();

  // Select candidates: anything with *some* indexable text. We skip the
  // `onlyMissing` filter for now since Vectorize doesn't expose a cheap
  // "does vector exist" predicate; re-running is idempotent (upsert).
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
    .limit(limit);

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

async function buildSearchItemsForDomain(
  db: ReturnType<typeof createDb>,
  domain: Domain
): Promise<SearchIndexItem[]> {
  switch (domain) {
    case 'reading':
      return buildReading(db);
    case 'watching':
      return buildWatching(db);
    case 'listening':
      return buildListening(db);
    case 'running':
      return buildRunning(db);
    case 'collecting':
      return buildCollecting(db);
  }
}

async function buildReading(
  db: ReturnType<typeof createDb>
): Promise<SearchIndexItem[]> {
  const rows = await db
    .select({
      id: readingItems.id,
      title: readingItems.title,
      description: readingItems.description,
      bodyExcerpt: readingItems.bodyExcerpt,
    })
    .from(readingItems)
    .where(eq(readingItems.userId, 1));

  const items: SearchIndexItem[] = rows.map((r) => ({
    domain: 'reading',
    entityType: 'article',
    entityId: String(r.id),
    title: r.title,
    subtitle: r.description ?? undefined,
    body: r.bodyExcerpt ?? undefined,
  }));

  // Highlights: one FTS row per saved highlight. Title = first 80 chars of
  // the highlight text, subtitle = parent article title, body = the full
  // highlight text + optional note so long highlights still match on body.
  const highlightRows = await db
    .select({
      id: readingHighlights.id,
      text: readingHighlights.text,
      note: readingHighlights.note,
      parentTitle: readingItems.title,
    })
    .from(readingHighlights)
    .innerJoin(readingItems, eq(readingHighlights.itemId, readingItems.id))
    .where(eq(readingHighlights.userId, 1));

  for (const h of highlightRows) {
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

  return items;
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

async function buildListening(
  db: ReturnType<typeof createDb>
): Promise<SearchIndexItem[]> {
  const items: SearchIndexItem[] = [];

  const artists = await db
    .select({ id: lastfmArtists.id, name: lastfmArtists.name })
    .from(lastfmArtists)
    .where(eq(lastfmArtists.userId, 1));
  const artistNameById = new Map<number, string>();
  for (const a of artists) {
    artistNameById.set(a.id, a.name);
    items.push({
      domain: 'listening',
      entityType: 'artist',
      entityId: String(a.id),
      title: a.name,
    });
  }

  const albums = await db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      artistId: lastfmAlbums.artistId,
    })
    .from(lastfmAlbums)
    .where(eq(lastfmAlbums.userId, 1));
  for (const al of albums) {
    items.push({
      domain: 'listening',
      entityType: 'album',
      entityId: String(al.id),
      title: al.name,
      subtitle: artistNameById.get(al.artistId),
    });
  }

  const tracks = await db
    .select({
      id: lastfmTracks.id,
      name: lastfmTracks.name,
      artistId: lastfmTracks.artistId,
    })
    .from(lastfmTracks)
    .where(eq(lastfmTracks.userId, 1));
  for (const t of tracks) {
    items.push({
      domain: 'listening',
      entityType: 'track',
      entityId: String(t.id),
      title: t.name,
      subtitle: artistNameById.get(t.artistId),
    });
  }

  return items;
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
  tags: ['Admin'],
  summary:
    "Titlecase URL-shaped authors (e.g. 'https://.../by/mike-isaac' → 'Mike Isaac')",
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
