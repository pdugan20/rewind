import { createRoute, z } from '@hono/zod-openapi';
import { eq, and, desc, sql, gte, lte, asc, count } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { readingItems, readingHighlights } from '../db/schema/reading.js';
import { setCache } from '../lib/cache.js';
import { DateFilterQuery, buildDateCondition } from '../lib/date-filters.js';
import { notFound, badRequest } from '../lib/errors.js';
import { getImageAttachment, getImageAttachmentBatch } from '../lib/images.js';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses, PaginationMeta } from '../lib/schemas/common.js';

const reading = createOpenAPIApp();

// ─── Helper functions ────────────────────────────────────────────────

function paginate(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    total_pages: Math.ceil(total / limit),
  };
}

function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson) return [];
  try {
    return JSON.parse(tagsJson);
  } catch {
    return [];
  }
}

// ─── Schemas ─────────────────────────────────────────────────────────

const ArticleSchema = z.object({
  id: z.number(),
  title: z.string(),
  author: z.string().nullable(),
  url: z.string().nullable(),
  domain: z.string().nullable(),
  site_name: z.string().nullable(),
  description: z.string().nullable(),
  word_count: z.number().nullable(),
  estimated_read_min: z.number().nullable(),
  status: z.string(),
  progress: z.number(),
  starred: z.boolean(),
  rating: z.number().nullable(),
  tags: z.array(z.string()),
  source: z.string(),
  image: z.any().nullable(),
  saved_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});

const HighlightSchema = z.object({
  id: z.number(),
  text: z.string(),
  note: z.string().nullable(),
  position: z.number().nullable(),
  chapter: z.string().nullable(),
  page: z.number().nullable(),
  created_at: z.string(),
});

const ArticleDetailSchema = ArticleSchema.extend({
  highlights: z.array(HighlightSchema),
});

const HighlightWithArticleSchema = HighlightSchema.extend({
  article: z.object({
    id: z.number(),
    title: z.string(),
    author: z.string().nullable(),
    domain: z.string().nullable(),
    url: z.string().nullable(),
  }),
});

const ReadingStatsSchema = z.object({
  total_articles: z.number(),
  finished_count: z.number(),
  currently_reading_count: z.number(),
  total_highlights: z.number(),
  total_word_count: z.number(),
  avg_estimated_read_min: z.number(),
});

const CalendarDaySchema = z.object({
  date: z.string(),
  saved: z.number(),
  finished: z.number(),
});

const CalendarSchema = z.object({
  year: z.number(),
  days: z.array(CalendarDaySchema),
  total_saved: z.number(),
  total_finished: z.number(),
});

const StreaksSchema = z.object({
  current: z.object({
    days: z.number(),
    start_date: z.string().nullable(),
    total_finished: z.number(),
  }),
  longest: z.object({
    days: z.number(),
    start_date: z.string().nullable(),
    end_date: z.string().nullable(),
    total_finished: z.number(),
  }),
});

const TagCountSchema = z.object({
  tag: z.string(),
  count: z.number(),
});

const DomainCountSchema = z.object({
  domain: z.string(),
  count: z.number(),
});

const YearParamSchema = z.object({
  year: z.string().openapi({ example: '2025' }),
});

const YearInReviewSchema = z.object({
  year: z.number(),
  total_articles: z.number(),
  finished_count: z.number(),
  total_highlights: z.number(),
  total_word_count: z.number(),
  top_domains: z.array(DomainCountSchema),
  top_tags: z.array(TagCountSchema),
  monthly: z.array(
    z.object({
      month: z.string(),
      saved: z.number(),
      finished: z.number(),
    })
  ),
});

// ─── Routes ──────────────────────────────────────────────────────────

// 1. GET /recent
const recentRoute = createRoute({
  method: 'get',
  path: '/recent',
  operationId: 'getReadingRecent',
  tags: ['Reading'],
  summary: 'Recent articles',
  description:
    'Returns recently saved or finished articles, ordered by most recent activity.',
  request: {
    query: z
      .object({
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .openapi({ example: 10 }),
      })
      .merge(DateFilterQuery),
  },
  responses: {
    200: {
      description: 'Recent articles',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(ArticleSchema) }),
          example: {
            data: [
              {
                id: 42,
                title: 'The Age of AI',
                author: 'Derek Thompson',
                url: 'https://www.theatlantic.com/technology/archive/2025/the-age-of-ai',
                domain: 'theatlantic.com',
                site_name: 'The Atlantic',
                description:
                  'How artificial intelligence is reshaping every industry.',
                word_count: 3200,
                estimated_read_min: 13,
                status: 'finished',
                progress: 1.0,
                starred: true,
                rating: null,
                tags: ['technology', 'ai'],
                source: 'instapaper',
                image: null,
                saved_at: '2026-03-18T14:30:00.000Z',
                started_at: '2026-03-19T08:00:00.000Z',
                finished_at: '2026-03-19T08:15:00.000Z',
              },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

// 2. GET /currently-reading
const currentlyReadingRoute = createRoute({
  method: 'get',
  path: '/currently-reading',
  operationId: 'getReadingCurrentlyReading',
  tags: ['Reading'],
  summary: 'Currently reading',
  description:
    'Returns articles currently being read (progress > 0 and < 0.75).',
  responses: {
    200: {
      description: 'Currently reading articles',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(ArticleSchema) }),
          example: {
            data: [
              {
                id: 87,
                title: "Why the Internet Isn't Working",
                author: 'Maxwell Zeff',
                url: 'https://www.wired.com/story/why-the-internet-isnt-working',
                domain: 'wired.com',
                site_name: 'Wired',
                description:
                  'The web was supposed to connect us. What went wrong?',
                word_count: 4500,
                estimated_read_min: 18,
                status: 'reading',
                progress: 0.45,
                starred: false,
                rating: null,
                tags: ['technology', 'internet'],
                source: 'instapaper',
                image: null,
                saved_at: '2026-03-20T10:00:00.000Z',
                started_at: '2026-03-21T07:30:00.000Z',
                finished_at: null,
              },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

// 3. GET /articles
const articlesRoute = createRoute({
  method: 'get',
  path: '/articles',
  operationId: 'listReadingArticles',
  tags: ['Reading'],
  summary: 'List articles',
  description:
    'Returns a paginated list of articles, filterable by status, tag, domain, and starred.',
  request: {
    query: z
      .object({
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
          .max(50)
          .optional()
          .default(20)
          .openapi({ example: 20 }),
        status: z
          .enum(['unread', 'reading', 'finished'])
          .optional()
          .openapi({ example: 'finished' }),
        tag: z.string().optional().openapi({ example: 'technology' }),
        domain: z.string().optional().openapi({ example: 'theatlantic.com' }),
        starred: z.coerce.number().int().min(0).max(1).optional().openapi({
          example: 1,
          description: '1 for starred only, 0 for unstarred only',
        }),
        sort: z
          .enum(['saved_at', 'finished_at', 'title'])
          .optional()
          .default('saved_at')
          .openapi({ example: 'saved_at' }),
        order: z
          .enum(['asc', 'desc'])
          .optional()
          .default('desc')
          .openapi({ example: 'desc' }),
      })
      .merge(DateFilterQuery),
  },
  responses: {
    200: {
      description: 'Paginated articles',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(ArticleSchema),
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                id: 42,
                title: 'The Age of AI',
                author: 'Derek Thompson',
                url: 'https://www.theatlantic.com/technology/archive/2025/the-age-of-ai',
                domain: 'theatlantic.com',
                site_name: 'The Atlantic',
                description:
                  'How artificial intelligence is reshaping every industry.',
                word_count: 3200,
                estimated_read_min: 13,
                status: 'finished',
                progress: 1.0,
                starred: true,
                rating: null,
                tags: ['technology', 'ai'],
                source: 'instapaper',
                image: null,
                saved_at: '2026-03-18T14:30:00.000Z',
                started_at: '2026-03-19T08:00:00.000Z',
                finished_at: '2026-03-19T08:15:00.000Z',
              },
            ],
            pagination: { page: 1, limit: 20, total: 1523, total_pages: 77 },
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

// 4. GET /articles/:id
const articleDetailRoute = createRoute({
  method: 'get',
  path: '/articles/{id}',
  operationId: 'getReadingArticle',
  tags: ['Reading'],
  summary: 'Article detail',
  description: 'Returns a single article with its embedded highlights.',
  request: {
    params: z.object({
      id: z.string().openapi({ example: '42' }),
    }),
  },
  responses: {
    200: {
      description: 'Article detail',
      content: {
        'application/json': {
          schema: ArticleDetailSchema,
          example: {
            id: 42,
            title: 'The Age of AI',
            author: 'Derek Thompson',
            url: 'https://www.theatlantic.com/technology/archive/2025/the-age-of-ai',
            domain: 'theatlantic.com',
            site_name: 'The Atlantic',
            description:
              'How artificial intelligence is reshaping every industry.',
            word_count: 3200,
            estimated_read_min: 13,
            status: 'finished',
            progress: 1.0,
            starred: true,
            rating: null,
            tags: ['technology', 'ai'],
            source: 'instapaper',
            image: null,
            saved_at: '2026-03-18T14:30:00.000Z',
            started_at: '2026-03-19T08:00:00.000Z',
            finished_at: '2026-03-19T08:15:00.000Z',
            highlights: [
              {
                id: 1,
                text: 'The question is not whether AI will transform society, but how quickly institutions can adapt.',
                note: 'Key thesis',
                position: 1,
                chapter: null,
                page: null,
                created_at: '2026-03-19T08:10:00.000Z',
              },
            ],
          },
        },
      },
    },
    ...errorResponses(401, 404),
  },
});

// 5. GET /archive
const archiveRoute = createRoute({
  method: 'get',
  path: '/archive',
  operationId: 'getReadingArchive',
  tags: ['Reading'],
  summary: 'Archived articles',
  description: 'Returns finished articles, paginated.',
  request: {
    query: z
      .object({
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
          .max(50)
          .optional()
          .default(20)
          .openapi({ example: 20 }),
      })
      .merge(DateFilterQuery),
  },
  responses: {
    200: {
      description: 'Archived articles',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(ArticleSchema),
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                id: 42,
                title: 'The Age of AI',
                author: 'Derek Thompson',
                url: 'https://www.theatlantic.com/technology/archive/2025/the-age-of-ai',
                domain: 'theatlantic.com',
                site_name: 'The Atlantic',
                description:
                  'How artificial intelligence is reshaping every industry.',
                word_count: 3200,
                estimated_read_min: 13,
                status: 'finished',
                progress: 1.0,
                starred: true,
                rating: null,
                tags: ['technology', 'ai'],
                source: 'instapaper',
                image: null,
                saved_at: '2026-03-18T14:30:00.000Z',
                started_at: '2026-03-19T08:00:00.000Z',
                finished_at: '2026-03-19T08:15:00.000Z',
              },
            ],
            pagination: { page: 1, limit: 20, total: 890, total_pages: 45 },
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

// 6. GET /highlights
const highlightsRoute = createRoute({
  method: 'get',
  path: '/highlights',
  operationId: 'listReadingHighlights',
  tags: ['Reading'],
  summary: 'List highlights',
  description:
    'Returns all highlights newest first, with parent article context.',
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
        .max(50)
        .optional()
        .default(20)
        .openapi({ example: 20 }),
    }),
  },
  responses: {
    200: {
      description: 'Paginated highlights',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(HighlightWithArticleSchema),
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                id: 1,
                text: 'The question is not whether AI will transform society, but how quickly institutions can adapt.',
                note: 'Key thesis',
                position: 1,
                chapter: null,
                page: null,
                created_at: '2026-03-19T08:10:00.000Z',
                article: {
                  id: 42,
                  title: 'The Age of AI',
                  author: 'Derek Thompson',
                  domain: 'theatlantic.com',
                  url: 'https://www.theatlantic.com/technology/archive/2025/the-age-of-ai',
                },
              },
            ],
            pagination: { page: 1, limit: 20, total: 312, total_pages: 16 },
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

// 7. GET /highlights/random
const highlightRandomRoute = createRoute({
  method: 'get',
  path: '/highlights/random',
  operationId: 'getReadingHighlightRandom',
  tags: ['Reading'],
  summary: 'Random highlight',
  description: 'Returns a single random highlight with article context.',
  responses: {
    200: {
      description: 'Random highlight',
      content: {
        'application/json': {
          schema: HighlightWithArticleSchema,
          example: {
            id: 77,
            text: 'We have built a world where distraction is the default and attention is the exception.',
            note: null,
            position: 3,
            chapter: null,
            page: null,
            created_at: '2026-02-14T12:30:00.000Z',
            article: {
              id: 87,
              title: "Why the Internet Isn't Working",
              author: 'Maxwell Zeff',
              domain: 'wired.com',
              url: 'https://www.wired.com/story/why-the-internet-isnt-working',
            },
          },
        },
      },
    },
    ...errorResponses(401, 404),
  },
});

// 8. GET /stats
const statsRoute = createRoute({
  method: 'get',
  path: '/stats',
  operationId: 'getReadingStats',
  tags: ['Reading'],
  summary: 'Reading stats',
  description:
    'Returns aggregate reading statistics: total articles, finished count, currently reading, total highlights, word count, and average read time.',
  responses: {
    200: {
      description: 'Reading statistics',
      content: {
        'application/json': {
          schema: ReadingStatsSchema,
          example: {
            total_articles: 1523,
            finished_count: 891,
            currently_reading_count: 3,
            total_highlights: 312,
            total_word_count: 4892000,
            avg_estimated_read_min: 11,
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

// 9. GET /calendar
const calendarRoute = createRoute({
  method: 'get',
  path: '/calendar',
  operationId: 'getReadingCalendar',
  tags: ['Reading'],
  summary: 'Reading calendar',
  description:
    'Returns daily counts of saved and finished articles for a given year.',
  request: {
    query: z.object({
      year: z.coerce.number().int().optional().openapi({ example: 2025 }),
    }),
  },
  responses: {
    200: {
      description: 'Calendar data',
      content: {
        'application/json': {
          schema: CalendarSchema,
          example: {
            year: 2026,
            days: [
              { date: '2026-03-01', saved: 3, finished: 1 },
              { date: '2026-03-02', saved: 5, finished: 2 },
              { date: '2026-03-03', saved: 1, finished: 0 },
            ],
            total_saved: 9,
            total_finished: 3,
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

// 10. GET /streaks
const streaksRoute = createRoute({
  method: 'get',
  path: '/streaks',
  operationId: 'getReadingStreaks',
  tags: ['Reading'],
  summary: 'Reading streaks',
  description:
    'Returns current and longest reading streaks (consecutive days with a finished article).',
  responses: {
    200: {
      description: 'Streak data',
      content: {
        'application/json': {
          schema: StreaksSchema,
          example: {
            current: {
              days: 5,
              start_date: '2026-03-18',
              total_finished: 8,
            },
            longest: {
              days: 21,
              start_date: '2025-12-01',
              end_date: '2025-12-21',
              total_finished: 34,
            },
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

// 11. GET /tags
const tagsRoute = createRoute({
  method: 'get',
  path: '/tags',
  operationId: 'listReadingTags',
  tags: ['Reading'],
  summary: 'Tag breakdown',
  description: 'Returns tags with article counts, sorted by count descending.',
  responses: {
    200: {
      description: 'Tag list',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(TagCountSchema) }),
          example: {
            data: [
              { tag: 'technology', count: 312 },
              { tag: 'culture', count: 187 },
              { tag: 'science', count: 145 },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

// 12. GET /domains
const domainsRoute = createRoute({
  method: 'get',
  path: '/domains',
  operationId: 'listReadingDomains',
  tags: ['Reading'],
  summary: 'Top domains',
  description:
    'Returns top source domains with article counts, sorted by count descending.',
  request: {
    query: z.object({
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .openapi({ example: 20 }),
    }),
  },
  responses: {
    200: {
      description: 'Domain list',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(DomainCountSchema) }),
          example: {
            data: [
              { domain: 'theatlantic.com', count: 98 },
              { domain: 'wired.com', count: 76 },
              { domain: 'nytimes.com', count: 65 },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

// 13. GET /year/:year
const yearRoute = createRoute({
  method: 'get',
  path: '/year/{year}',
  operationId: 'getReadingYearInReview',
  tags: ['Reading'],
  summary: 'Year in review',
  description: 'Returns year-in-review reading data.',
  request: { params: YearParamSchema },
  responses: {
    200: {
      description: 'Year in review data',
      content: {
        'application/json': {
          schema: YearInReviewSchema,
          example: {
            year: 2025,
            total_articles: 482,
            finished_count: 301,
            total_highlights: 128,
            total_word_count: 1540000,
            top_domains: [
              { domain: 'theatlantic.com', count: 32 },
              { domain: 'wired.com', count: 28 },
            ],
            top_tags: [
              { tag: 'technology', count: 89 },
              { tag: 'culture', count: 54 },
            ],
            monthly: [
              { month: '2025-01', saved: 45, finished: 28 },
              { month: '2025-02', saved: 38, finished: 22 },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

// ─── Handlers ────────────────────────────────────────────────────────

function formatArticle(
  row: typeof readingItems.$inferSelect,
  image: import('../lib/images.js').ImageAttachment | null = null
) {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    url: row.url,
    domain: row.domain,
    site_name: row.siteName,
    description: row.description,
    word_count: row.wordCount,
    estimated_read_min: row.estimatedReadMin,
    status: row.status,
    progress: row.progress,
    starred: row.starred === 1,
    rating: row.rating,
    tags: parseTags(row.tags),
    source: row.source,
    image,
    saved_at: row.savedAt,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
  };
}

// 1. GET /recent
reading.openapi(recentRoute, async (c) => {
  setCache(c, 'short');
  const db = createDb(c.env.DB);
  const { limit, date, from, to } = c.req.valid('query');

  const conditions = [eq(readingItems.userId, 1)];
  const dateCondition = buildDateCondition(readingItems.savedAt, {
    date,
    from,
    to,
  });
  if (dateCondition) conditions.push(dateCondition);

  const rows = await db
    .select()
    .from(readingItems)
    .where(and(...conditions))
    .orderBy(desc(readingItems.savedAt))
    .limit(limit);

  const imageMap = await getImageAttachmentBatch(
    db,
    'reading',
    'articles',
    rows.map((r) => String(r.id))
  );

  return c.json({
    data: rows.map((r) => formatArticle(r, imageMap.get(String(r.id)) ?? null)),
  });
});

// 2. GET /currently-reading
reading.openapi(currentlyReadingRoute, async (c) => {
  setCache(c, 'short');
  const db = createDb(c.env.DB);

  const rows = await db
    .select()
    .from(readingItems)
    .where(
      and(
        eq(readingItems.userId, 1),
        eq(readingItems.status, 'reading'),
        gte(readingItems.progress, 0),
        lte(readingItems.progress, 0.75)
      )
    )
    .orderBy(desc(readingItems.progressUpdatedAt));

  const imageMap = await getImageAttachmentBatch(
    db,
    'reading',
    'articles',
    rows.map((r) => String(r.id))
  );

  return c.json({
    data: rows.map((r) => formatArticle(r, imageMap.get(String(r.id)) ?? null)),
  });
});

// 3. GET /articles
reading.openapi(articlesRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const {
    page,
    limit,
    status,
    tag,
    domain,
    starred,
    sort,
    order,
    date,
    from,
    to,
  } = c.req.valid('query');

  const conditions = [eq(readingItems.userId, 1)];

  if (status) conditions.push(eq(readingItems.status, status));
  if (domain) conditions.push(eq(readingItems.domain, domain));
  if (starred !== undefined) conditions.push(eq(readingItems.starred, starred));
  if (tag) conditions.push(sql`${readingItems.tags} LIKE ${'%"' + tag + '"%'}`);

  const dateCondition = buildDateCondition(readingItems.savedAt, {
    date,
    from,
    to,
  });
  if (dateCondition) conditions.push(dateCondition);

  const whereClause = and(...conditions);

  const [totalRow] = await db
    .select({ count: count() })
    .from(readingItems)
    .where(whereClause);
  const total = totalRow?.count ?? 0;

  const sortColumn =
    sort === 'finished_at'
      ? readingItems.finishedAt
      : sort === 'title'
        ? readingItems.title
        : readingItems.savedAt;
  const orderFn = order === 'asc' ? asc : desc;

  const rows = await db
    .select()
    .from(readingItems)
    .where(whereClause)
    .orderBy(orderFn(sortColumn))
    .limit(limit)
    .offset((page - 1) * limit);

  const imageMap = await getImageAttachmentBatch(
    db,
    'reading',
    'articles',
    rows.map((r) => String(r.id))
  );

  return c.json({
    data: rows.map((r) => formatArticle(r, imageMap.get(String(r.id)) ?? null)),
    pagination: paginate(page, limit, total),
  });
});

// 4. GET /articles/:id
reading.openapi(articleDetailRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) return badRequest(c, 'Invalid article ID') as any;

  const [article] = await db
    .select()
    .from(readingItems)
    .where(and(eq(readingItems.id, id), eq(readingItems.userId, 1)))
    .limit(1);

  if (!article) return notFound(c, 'Article not found') as any;

  const highlights = await db
    .select()
    .from(readingHighlights)
    .where(eq(readingHighlights.itemId, id))
    .orderBy(asc(readingHighlights.position));

  const image = await getImageAttachment(db, 'reading', 'articles', String(id));

  return c.json({
    ...formatArticle(article, image),
    highlights: highlights.map((h) => ({
      id: h.id,
      text: h.text,
      note: h.note,
      position: h.position,
      chapter: h.chapter,
      page: h.page,
      created_at: h.createdAt,
    })),
  });
});

// 5. GET /archive
reading.openapi(archiveRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const { page, limit, date, from, to } = c.req.valid('query');

  const conditions = [
    eq(readingItems.userId, 1),
    eq(readingItems.status, 'finished'),
  ];

  const dateCondition = buildDateCondition(readingItems.finishedAt, {
    date,
    from,
    to,
  });
  if (dateCondition) conditions.push(dateCondition);

  const whereClause = and(...conditions);

  const [totalRow] = await db
    .select({ count: count() })
    .from(readingItems)
    .where(whereClause);
  const total = totalRow?.count ?? 0;

  const rows = await db
    .select()
    .from(readingItems)
    .where(whereClause)
    .orderBy(desc(readingItems.finishedAt))
    .limit(limit)
    .offset((page - 1) * limit);

  const imageMap = await getImageAttachmentBatch(
    db,
    'reading',
    'articles',
    rows.map((r) => String(r.id))
  );

  return c.json({
    data: rows.map((r) => formatArticle(r, imageMap.get(String(r.id)) ?? null)),
    pagination: paginate(page, limit, total),
  });
});

// 6. GET /highlights
reading.openapi(highlightsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const { page, limit } = c.req.valid('query');

  const [totalRow] = await db
    .select({ count: count() })
    .from(readingHighlights)
    .where(eq(readingHighlights.userId, 1));
  const total = totalRow?.count ?? 0;

  const rows = await db
    .select({
      id: readingHighlights.id,
      text: readingHighlights.text,
      note: readingHighlights.note,
      position: readingHighlights.position,
      chapter: readingHighlights.chapter,
      page: readingHighlights.page,
      createdAt: readingHighlights.createdAt,
      articleId: readingItems.id,
      articleTitle: readingItems.title,
      articleAuthor: readingItems.author,
      articleDomain: readingItems.domain,
      articleUrl: readingItems.url,
    })
    .from(readingHighlights)
    .innerJoin(readingItems, eq(readingHighlights.itemId, readingItems.id))
    .where(eq(readingHighlights.userId, 1))
    .orderBy(desc(readingHighlights.createdAt))
    .limit(limit)
    .offset((page - 1) * limit);

  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      text: r.text,
      note: r.note,
      position: r.position,
      chapter: r.chapter,
      page: r.page,
      created_at: r.createdAt,
      article: {
        id: r.articleId,
        title: r.articleTitle,
        author: r.articleAuthor,
        domain: r.articleDomain,
        url: r.articleUrl,
      },
    })),
    pagination: paginate(page, limit, total),
  });
});

// 7. GET /highlights/random
reading.openapi(highlightRandomRoute, async (c) => {
  setCache(c, 'short');
  const db = createDb(c.env.DB);

  const [row] = await db
    .select({
      id: readingHighlights.id,
      text: readingHighlights.text,
      note: readingHighlights.note,
      position: readingHighlights.position,
      chapter: readingHighlights.chapter,
      page: readingHighlights.page,
      createdAt: readingHighlights.createdAt,
      articleId: readingItems.id,
      articleTitle: readingItems.title,
      articleAuthor: readingItems.author,
      articleDomain: readingItems.domain,
      articleUrl: readingItems.url,
    })
    .from(readingHighlights)
    .innerJoin(readingItems, eq(readingHighlights.itemId, readingItems.id))
    .where(eq(readingHighlights.userId, 1))
    .orderBy(sql`RANDOM()`)
    .limit(1);

  if (!row) return notFound(c, 'No highlights found') as any;

  return c.json({
    id: row.id,
    text: row.text,
    note: row.note,
    position: row.position,
    chapter: row.chapter,
    page: row.page,
    created_at: row.createdAt,
    article: {
      id: row.articleId,
      title: row.articleTitle,
      author: row.articleAuthor,
      domain: row.articleDomain,
      url: row.articleUrl,
    },
  });
});

// 8. GET /stats
reading.openapi(statsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const [totals] = await db
    .select({
      total: count(),
      finishedCount: sql<number>`sum(case when ${readingItems.status} = 'finished' then 1 else 0 end)`,
      currentlyReadingCount: sql<number>`sum(case when ${readingItems.status} = 'reading' then 1 else 0 end)`,
      totalWordCount: sql<number>`coalesce(sum(${readingItems.wordCount}), 0)`,
      avgReadMin: sql<number>`coalesce(avg(${readingItems.estimatedReadMin}), 0)`,
    })
    .from(readingItems)
    .where(eq(readingItems.userId, 1));

  const [highlightCount] = await db
    .select({ count: count() })
    .from(readingHighlights)
    .where(eq(readingHighlights.userId, 1));

  return c.json({
    total_articles: totals?.total ?? 0,
    finished_count: totals?.finishedCount ?? 0,
    currently_reading_count: totals?.currentlyReadingCount ?? 0,
    total_highlights: highlightCount?.count ?? 0,
    total_word_count: totals?.totalWordCount ?? 0,
    avg_estimated_read_min: Math.round(totals?.avgReadMin ?? 0),
  });
});

// 9. GET /calendar
reading.openapi(calendarRoute, async (c) => {
  const db = createDb(c.env.DB);
  const currentYear = new Date().getFullYear();
  const yearParam = parseInt(c.req.query('year') ?? String(currentYear));

  if (isNaN(yearParam) || yearParam < 2000 || yearParam > currentYear + 1) {
    return badRequest(c, 'Invalid year') as any;
  }

  if (yearParam < currentYear) {
    setCache(c, 'long');
  } else {
    setCache(c, 'medium');
  }

  const startDate = `${yearParam}-01-01T00:00:00.000Z`;
  const endDate = `${yearParam + 1}-01-01T00:00:00.000Z`;

  const savedDays = await db
    .select({
      date: sql<string>`date(${readingItems.savedAt})`,
      count: sql<number>`count(*)`,
    })
    .from(readingItems)
    .where(
      and(
        eq(readingItems.userId, 1),
        gte(readingItems.savedAt, startDate),
        lte(readingItems.savedAt, endDate)
      )
    )
    .groupBy(sql`date(${readingItems.savedAt})`);

  const finishedDays = await db
    .select({
      date: sql<string>`date(${readingItems.finishedAt})`,
      count: sql<number>`count(*)`,
    })
    .from(readingItems)
    .where(
      and(
        eq(readingItems.userId, 1),
        eq(readingItems.status, 'finished'),
        gte(readingItems.finishedAt, startDate),
        lte(readingItems.finishedAt, endDate)
      )
    )
    .groupBy(sql`date(${readingItems.finishedAt})`);

  const savedMap = new Map(savedDays.map((d) => [d.date, d.count]));
  const finishedMap = new Map(finishedDays.map((d) => [d.date, d.count]));

  const allDates = new Set([...savedMap.keys(), ...finishedMap.keys()]);
  const days = Array.from(allDates)
    .sort()
    .map((date) => ({
      date,
      saved: savedMap.get(date) ?? 0,
      finished: finishedMap.get(date) ?? 0,
    }));

  const totalSaved = days.reduce((sum, d) => sum + d.saved, 0);
  const totalFinished = days.reduce((sum, d) => sum + d.finished, 0);

  return c.json({
    year: yearParam,
    days,
    total_saved: totalSaved,
    total_finished: totalFinished,
  });
});

// 10. GET /streaks
reading.openapi(streaksRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const dates = await db
    .select({
      date: sql<string>`date(${readingItems.finishedAt})`,
      count: sql<number>`count(*)`,
    })
    .from(readingItems)
    .where(and(eq(readingItems.userId, 1), eq(readingItems.status, 'finished')))
    .groupBy(sql`date(${readingItems.finishedAt})`)
    .orderBy(asc(sql`date(${readingItems.finishedAt})`));

  if (dates.length === 0) {
    return c.json({
      current: { days: 0, start_date: null, total_finished: 0 },
      longest: {
        days: 0,
        start_date: null,
        end_date: null,
        total_finished: 0,
      },
    });
  }

  let longestStreak = { days: 1, startIdx: 0, endIdx: 0, finished: 0 };
  let tempStreak = {
    days: 1,
    startIdx: 0,
    endIdx: 0,
    finished: dates[0].count,
  };

  for (let i = 1; i < dates.length; i++) {
    const prevDate = new Date(dates[i - 1].date + 'T00:00:00Z');
    const currDate = new Date(dates[i].date + 'T00:00:00Z');
    const diffDays = Math.round(
      (currDate.getTime() - prevDate.getTime()) / 86400000
    );

    if (diffDays === 1) {
      tempStreak.days++;
      tempStreak.endIdx = i;
      tempStreak.finished += dates[i].count;
    } else {
      if (tempStreak.days > longestStreak.days) {
        longestStreak = { ...tempStreak };
      }
      tempStreak = {
        days: 1,
        startIdx: i,
        endIdx: i,
        finished: dates[i].count,
      };
    }
  }

  if (tempStreak.days > longestStreak.days) {
    longestStreak = { ...tempStreak };
  }

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const lastDate = dates[dates.length - 1].date;

  const currentStreak =
    lastDate === today || lastDate === yesterday
      ? { ...tempStreak }
      : { days: 0, startIdx: 0, endIdx: 0, finished: 0 };

  return c.json({
    current: {
      days: currentStreak.days,
      start_date:
        currentStreak.days > 0 ? dates[currentStreak.startIdx].date : null,
      total_finished: currentStreak.finished,
    },
    longest: {
      days: longestStreak.days,
      start_date: dates[longestStreak.startIdx].date,
      end_date: dates[longestStreak.endIdx].date,
      total_finished: longestStreak.finished,
    },
  });
});

// 11. GET /tags
reading.openapi(tagsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const rows = await db
    .select({ tags: readingItems.tags })
    .from(readingItems)
    .where(eq(readingItems.userId, 1));

  const tagCounts = new Map<string, number>();
  for (const row of rows) {
    const tags = parseTags(row.tags);
    for (const tag of tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const sorted = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  return c.json({ data: sorted });
});

// 12. GET /domains
reading.openapi(domainsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const { limit } = c.req.valid('query');

  const rows = await db
    .select({
      domain: readingItems.domain,
      count: sql<number>`count(*)`,
    })
    .from(readingItems)
    .where(
      and(eq(readingItems.userId, 1), sql`${readingItems.domain} IS NOT NULL`)
    )
    .groupBy(readingItems.domain)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  return c.json({
    data: rows.map((r) => ({ domain: r.domain!, count: r.count })),
  });
});

// 13. GET /year/:year
reading.openapi(yearRoute, async (c) => {
  const db = createDb(c.env.DB);
  const currentYear = new Date().getFullYear();
  const year = parseInt(c.req.param('year'));

  if (isNaN(year) || year < 2000 || year > currentYear + 1) {
    return badRequest(c, 'Invalid year') as any;
  }

  if (year < currentYear) {
    setCache(c, 'long');
  } else {
    setCache(c, 'medium');
  }

  const startDate = `${year}-01-01T00:00:00.000Z`;
  const endDate = `${year + 1}-01-01T00:00:00.000Z`;
  const yearCondition = and(
    eq(readingItems.userId, 1),
    gte(readingItems.savedAt, startDate),
    lte(readingItems.savedAt, endDate)
  );

  // Total articles saved this year
  const [articleCounts] = await db
    .select({
      total: count(),
      finishedCount: sql<number>`sum(case when ${readingItems.status} = 'finished' then 1 else 0 end)`,
      totalWordCount: sql<number>`coalesce(sum(${readingItems.wordCount}), 0)`,
    })
    .from(readingItems)
    .where(yearCondition);

  // Highlights for articles saved this year
  const [highlightCount] = await db
    .select({ count: count() })
    .from(readingHighlights)
    .innerJoin(readingItems, eq(readingHighlights.itemId, readingItems.id))
    .where(
      and(
        eq(readingHighlights.userId, 1),
        gte(readingItems.savedAt, startDate),
        lte(readingItems.savedAt, endDate)
      )
    );

  // Top domains
  const topDomains = await db
    .select({
      domain: readingItems.domain,
      count: sql<number>`count(*)`,
    })
    .from(readingItems)
    .where(and(yearCondition, sql`${readingItems.domain} IS NOT NULL`))
    .groupBy(readingItems.domain)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  // Top tags (manual aggregation since tags are JSON)
  const tagRows = await db
    .select({ tags: readingItems.tags })
    .from(readingItems)
    .where(yearCondition);

  const tagCounts = new Map<string, number>();
  for (const row of tagRows) {
    for (const tag of parseTags(row.tags)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  const topTags = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Monthly breakdown
  const monthlySaved = await db
    .select({
      month: sql<string>`strftime('%Y-%m', ${readingItems.savedAt})`,
      count: sql<number>`count(*)`,
    })
    .from(readingItems)
    .where(yearCondition)
    .groupBy(sql`strftime('%Y-%m', ${readingItems.savedAt})`)
    .orderBy(asc(sql`strftime('%Y-%m', ${readingItems.savedAt})`));

  const monthlyFinished = await db
    .select({
      month: sql<string>`strftime('%Y-%m', ${readingItems.finishedAt})`,
      count: sql<number>`count(*)`,
    })
    .from(readingItems)
    .where(
      and(
        yearCondition,
        eq(readingItems.status, 'finished'),
        gte(readingItems.finishedAt, startDate),
        lte(readingItems.finishedAt, endDate)
      )
    )
    .groupBy(sql`strftime('%Y-%m', ${readingItems.finishedAt})`)
    .orderBy(asc(sql`strftime('%Y-%m', ${readingItems.finishedAt})`));

  const savedByMonth = new Map(monthlySaved.map((m) => [m.month, m.count]));
  const finishedByMonth = new Map(
    monthlyFinished.map((m) => [m.month, m.count])
  );
  const allMonths = new Set([
    ...savedByMonth.keys(),
    ...finishedByMonth.keys(),
  ]);
  const monthly = Array.from(allMonths)
    .sort()
    .map((month) => ({
      month,
      saved: savedByMonth.get(month) ?? 0,
      finished: finishedByMonth.get(month) ?? 0,
    }));

  return c.json({
    year,
    total_articles: articleCounts?.total ?? 0,
    finished_count: articleCounts?.finishedCount ?? 0,
    total_highlights: highlightCount?.count ?? 0,
    total_word_count: articleCounts?.totalWordCount ?? 0,
    top_domains: topDomains.map((d) => ({
      domain: d.domain!,
      count: d.count,
    })),
    top_tags: topTags,
    monthly,
  });
});

// ─── Admin: Backfill images ─────────────────────────────────────────

import { processReadingImages } from '../services/images/sync-images.js';
import { requireAuth } from '../lib/auth.js';

const backfillImagesRoute = createRoute({
  method: 'post',
  path: '/admin/backfill-images',
  operationId: 'backfillReadingImages',
  'x-hidden': true,
  tags: ['Reading', 'Admin'],
  summary: 'Backfill article images',
  description: 'Process missing article thumbnail images from OG metadata.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            limit: z.number().optional(),
          }),
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      description: 'Backfill results',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            results: z.record(z.string(), z.unknown()),
          }),
        },
      },
    },
    ...errorResponses(401, 500),
  },
});

reading.use('/admin/*', requireAuth('admin'));

reading.openapi(backfillImagesRoute, async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req
    .json<{ limit?: number }>()
    .catch(() => ({ limit: undefined }));
  const limit = body.limit ?? 50;

  try {
    const results = await processReadingImages(db, c.env, limit);
    return c.json({
      success: true,
      results: {
        articles: results[0] ?? { total: 0, processed: 0 },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

export default reading;
