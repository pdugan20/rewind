import { createRoute, z } from '@hono/zod-openapi';
import {
  eq,
  and,
  sql,
  desc,
  asc,
  like,
  or,
  inArray,
  gte,
  lte,
  count,
} from 'drizzle-orm';
import { createDb } from '../db/client.js';
import {
  discogsReleases,
  discogsArtists,
  discogsCollection,
  discogsReleaseArtists,
  discogsWantlist,
  discogsCollectionStats,
  collectionListeningXref,
} from '../db/schema/discogs.js';
import { traktCollection, traktCollectionStats } from '../db/schema/trakt.js';
import { movies } from '../db/schema/watching.js';
import { watchHistory } from '../db/schema/watching.js';
import { images } from '../db/schema/system.js';
import { setCache } from '../lib/cache.js';
import { DateFilterQuery, buildDateCondition } from '../lib/date-filters.js';
import { notFound, badRequest, serverError } from '../lib/errors.js';
import { syncCollecting } from '../services/discogs/sync.js';
import { syncTraktCollection } from '../services/trakt/sync.js';
import { TraktClient } from '../services/trakt/client.js';
import { getAccessToken } from '../services/trakt/auth.js';
import { TmdbClient } from '../services/watching/tmdb.js';
import { backfillImages } from '../services/images/backfill.js';
import type { BackfillItem } from '../services/images/backfill.js';
import { runPipeline } from '../services/images/pipeline.js';
import type { SourceSearchParams } from '../services/images/sources/types.js';
import { getImageAttachment, getImageAttachmentBatch } from '../lib/images.js';
import { createOpenAPIApp } from '../lib/openapi.js';
import {
  errorResponses,
  PaginationMeta,
  ImageAttachment,
} from '../lib/schemas/common.js';

const collecting = createOpenAPIApp();

// ─── Shared Schemas ─────────────────────────────────────────────────

const CollectionItemSchema = z.object({
  id: z.number(),
  discogs_id: z.number(),
  title: z.string(),
  artists: z.array(z.string()),
  year: z.number().nullable(),
  format: z.string(),
  format_detail: z.string(),
  label: z.string(),
  genres: z.array(z.string()),
  styles: z.array(z.string()),
  image: ImageAttachment,
  date_added: z.string().nullable(),
  rating: z.number().nullable(),
  discogs_url: z.string().nullable(),
});

const CollectionDetailSchema = CollectionItemSchema.extend({
  tracklist: z.array(z.any()),
  country: z.string().nullable(),
  community_have: z.number().nullable(),
  community_want: z.number().nullable(),
  lowest_price: z.number().nullable(),
  num_for_sale: z.number().nullable(),
  notes: z.any().nullable(),
});

const WantlistItemSchema = z.object({
  id: z.number(),
  discogs_id: z.number(),
  title: z.string(),
  artists: z.array(z.string()),
  year: z.number().nullable(),
  formats: z.array(z.string()),
  genres: z.array(z.string()),
  image: z.null(),
  discogs_url: z.string().nullable(),
  notes: z.string().nullable(),
  rating: z.number().nullable(),
  date_added: z.string().nullable(),
});

const NameCountSchema = z.object({
  name: z.string(),
  count: z.number(),
});

const ArtistItemSchema = z.object({
  name: z.string(),
  discogs_id: z.number(),
  image_url: z.string().nullable(),
  release_count: z.number(),
});

const CollectionStatsSchema = z.object({
  total_items: z.number(),
  by_format: z.any(),
  wantlist_count: z.number().nullable(),
  unique_artists: z.number().nullable(),
  estimated_value: z.number().nullable(),
  top_genre: z.string().nullable(),
  oldest_release_year: z.number().nullable(),
  newest_release_year: z.number().nullable(),
  most_collected_artist: z.any().nullable(),
  added_this_year: z.number().nullable(),
});

const CrossReferenceItemSchema = z.object({
  collection: z.object({
    id: z.number(),
    discogs_id: z.number(),
    title: z.string(),
    artists: z.array(z.string()),
    year: z.number().nullable(),
    format: z.string(),
    genres: z.array(z.string()),
    styles: z.array(z.string()),
    image: ImageAttachment,
    date_added: z.string().nullable(),
    rating: z.number().nullable(),
    discogs_url: z.string().nullable(),
  }),
  listening: z.object({
    album_name: z.string().nullable(),
    artist_name: z.string().nullable(),
    play_count: z.number().nullable(),
    last_played: z.string().nullable(),
    match_type: z.string().nullable(),
    match_confidence: z.number().nullable(),
  }),
});

const CrossReferenceSummarySchema = z.object({
  total_matches: z.number(),
  listen_rate: z.number(),
  unlistened_count: z.number(),
});

// ─── Media (Trakt) Schemas ──────────────────────────────────────────

const MediaItemSchema = z.object({
  id: z.number(),
  title: z.string(),
  year: z.number().nullable(),
  tmdb_id: z.number().nullable(),
  imdb_id: z.string().nullable(),
  image: ImageAttachment,
  runtime: z.number().nullable(),
  tmdb_rating: z.number().nullable(),
  media_type: z.string(),
  resolution: z.string().nullable(),
  hdr: z.string().nullable(),
  audio: z.string().nullable(),
  audio_channels: z.string().nullable(),
  collected_at: z.string().nullable(),
});

const MediaRecentItemSchema = MediaItemSchema.omit({
  imdb_id: true,
  runtime: true,
});

const MediaDetailSchema = z.object({
  id: z.number(),
  title: z.string(),
  year: z.number().nullable(),
  tmdb_id: z.number().nullable(),
  imdb_id: z.string().nullable(),
  tagline: z.string().nullable(),
  summary: z.string().nullable(),
  image: ImageAttachment,
  runtime: z.number().nullable(),
  tmdb_rating: z.number().nullable(),
  content_rating: z.string().nullable(),
  media_type: z.string(),
  resolution: z.string().nullable(),
  hdr: z.string().nullable(),
  audio: z.string().nullable(),
  audio_channels: z.string().nullable(),
  collected_at: z.string().nullable(),
  watch_history: z.array(
    z.object({
      watched_at: z.string().nullable(),
      source: z.string().nullable(),
      user_rating: z.number().nullable(),
    })
  ),
});

const MediaStatsSchema = z.object({
  total_items: z.number(),
  by_format: z.any(),
  by_resolution: z.any(),
  by_hdr: z.any(),
  by_genre: z.any(),
  by_decade: z.any(),
  added_this_year: z.number().nullable(),
});

const MediaCrossRefItemSchema = z.object({
  collection: z.object({
    id: z.number(),
    title: z.string(),
    year: z.number().nullable(),
    tmdb_id: z.number().nullable(),
    image: z.null(),
    media_type: z.string(),
    resolution: z.string().nullable(),
    collected_at: z.string().nullable(),
  }),
  watching: z.object({
    watched: z.boolean(),
    watch_count: z.number(),
    last_watched: z.string().nullable(),
  }),
});

const MediaCrossRefSummarySchema = z.object({
  total_owned: z.number(),
  total_watched: z.number(),
  total_unwatched: z.number(),
  watch_rate: z.number(),
});

const SyncResponseSchema = z.object({
  status: z.string(),
  message: z.string(),
});

const BackfillResponseSchema = z.object({
  success: z.boolean(),
  results: z.any(),
});

const AddMediaBodySchema = z.object({
  tmdb_id: z.number().optional(),
  imdb_id: z.string().optional(),
  title: z.string().optional(),
  year: z.number().optional(),
  media_type: z.string(),
  resolution: z.string().optional(),
  hdr: z.string().optional(),
  audio: z.string().optional(),
  audio_channels: z.string().optional(),
});

const AddMediaResponseSchema = z.object({
  status: z.string(),
  movie: z.object({
    title: z.string(),
    year: z.number().nullable(),
    tmdb_id: z.number(),
  }),
  media_type: z.string(),
  trakt: z.object({
    added: z.number(),
    existing: z.number(),
  }),
  image_processed: z.boolean(),
});

const RemoveMediaResponseSchema = z.object({
  status: z.string(),
  message: z.string(),
});

const BackfillLimitBodySchema = z.object({
  limit: z.number().optional(),
});

const IdParamSchema = z.object({
  id: z.string(),
});

// Query schemas
const CollectionQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    format: z.string().optional(),
    genre: z.string().optional(),
    artist: z.string().optional(),
    sort: z.string().optional().default('date_added'),
    order: z.string().optional().default('desc'),
    q: z.string().optional(),
  })
  .merge(DateFilterQuery);

const WantlistQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  sort: z.string().optional().default('date_added'),
  order: z.string().optional().default('desc'),
});

const LimitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional().default(5),
});

const ArtistLimitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

const CrossRefQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  sort: z.string().optional().default('plays'),
  filter: z.string().optional().default('all'),
});

const MediaQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    format: z.string().optional(),
    genre: z.string().optional(),
    sort: z.string().optional().default('collected_at'),
    order: z.string().optional().default('desc'),
    q: z.string().optional(),
  })
  .merge(DateFilterQuery);

const MediaCrossRefQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  filter: z.string().optional().default('all'),
});

// ─── Route Definitions ──────────────────────────────────────────────

// GET /collecting/collection
const collectionListRoute = createRoute({
  method: 'get',
  path: '/collecting/collection',
  operationId: 'listCollection',
  tags: ['Collecting'],
  summary: 'List vinyl collection',
  description:
    'Paginated, filterable, searchable Discogs vinyl collection with artist and image data.',
  request: {
    query: CollectionQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(CollectionItemSchema),
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                id: 1,
                discogs_id: 6872464,
                title: 'Nevermind',
                artists: ['Nirvana'],
                year: 1991,
                format: 'Vinyl',
                format_detail: '["LP","Album","Stereo"]',
                label: '[{"name":"IAmSound Records","catno":"IAM066L"}]',
                genres: ['Rock'],
                styles: ['Folk Rock', 'Rock & Roll'],
                image: {
                  url: 'https://cdn.rewind.rest/collecting/releases/6872464/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
                  thumbhash: 'GncKRwaU9niFd3dShlaJSFeJlYCYhGYA',
                  dominant_color: '#222229',
                  accent_color: '#9b31ed',
                },
                date_added: '2026-03-11T16:05:58-07:00',
                rating: 0,
                discogs_url: 'https://www.discogs.com/release/6872464',
              },
            ],
            pagination: { page: 1, limit: 20, total: 284, total_pages: 15 },
          },
        },
      },
      description: 'Paginated collection items',
    },
    ...errorResponses(401, 500),
  },
});

// GET /collecting/stats
const collectionStatsRoute = createRoute({
  method: 'get',
  path: '/collecting/stats',
  operationId: 'getCollectingStats',
  tags: ['Collecting'],
  summary: 'Collection statistics',
  description:
    'Aggregate statistics for the vinyl collection. Supports optional date filtering to scope stats to items added within a time period.',
  request: {
    query: DateFilterQuery,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: CollectionStatsSchema,
          example: {
            total_items: 284,
            by_format: { vinyl: 253, cd: 29, cassette: 0, other: 2 },
            wantlist_count: 1,
            unique_artists: 107,
            estimated_value: 7394.51,
            top_genre: 'Rock',
            oldest_release_year: 1957,
            newest_release_year: 2025,
            most_collected_artist: { name: 'Taylor Swift', count: 24 },
            added_this_year: 139,
          },
        },
      },
      description: 'Collection statistics',
    },
    ...errorResponses(401, 500),
  },
});

// GET /collecting/recent
const collectionRecentRoute = createRoute({
  method: 'get',
  path: '/collecting/recent',
  operationId: 'getCollectingRecent',
  tags: ['Collecting'],
  summary: 'Recent additions',
  description:
    'Most recently added items to the vinyl collection. Supports date filtering via date, from, and to params.',
  request: {
    query: LimitQuerySchema.merge(DateFilterQuery),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ data: z.array(CollectionItemSchema) }),
          example: {
            data: [
              {
                id: 1,
                discogs_id: 6872464,
                title: 'Nevermind',
                artists: ['Nirvana'],
                year: 1991,
                format: 'Vinyl',
                format_detail: '["LP","Album"]',
                label: '[{"name":"DGC","catno":"DGC-24425"}]',
                genres: ['Rock'],
                styles: ['Grunge'],
                image: {
                  url: 'https://cdn.rewind.rest/collecting/releases/6872464/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
                  thumbhash: 'GncKRwaU9niFd3dShlaJSFeJlYCYhGYA',
                  dominant_color: '#222229',
                  accent_color: '#9b31ed',
                },
                date_added: '2026-03-11T16:05:58-07:00',
                rating: 0,
                discogs_url: 'https://www.discogs.com/release/6872464',
              },
            ],
            pagination: { page: 1, limit: 20, total: 284, total_pages: 15 },
          },
        },
      },
      description: 'Recent collection items',
    },
    ...errorResponses(401, 500),
  },
});

// GET /collecting/collection/:id
const collectionDetailRoute = createRoute({
  method: 'get',
  path: '/collecting/collection/{id}',
  operationId: 'getCollectionRecord',
  tags: ['Collecting'],
  summary: 'Collection item detail',
  description:
    'Full detail for a single collection item including tracklist, country, and marketplace data.',
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: CollectionDetailSchema,
          example: {
            id: 1,
            discogs_id: 6872464,
            title: 'Nevermind',
            artists: ['Nirvana'],
            year: 1991,
            format: 'Vinyl',
            format_detail: '["LP","Album"]',
            label: '[{"name":"DGC","catno":"DGC-24425"}]',
            genres: ['Rock'],
            styles: ['Grunge'],
            image: {
              url: 'https://cdn.rewind.rest/collecting/releases/6872464/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
              thumbhash: 'GncKRwaU9niFd3dShlaJSFeJlYCYhGYA',
              dominant_color: '#222229',
              accent_color: '#9b31ed',
            },
            date_added: '2026-03-11T16:05:58-07:00',
            rating: 0,
            discogs_url: 'https://www.discogs.com/release/6872464',
            tracklist: [
              {
                position: '1',
                title: 'Smells Like Teen Spirit',
                duration: '5:01',
              },
            ],
            country: 'US',
            community_have: 45000,
            community_want: 12000,
            lowest_price: 25.99,
            num_for_sale: 350,
            notes: null,
          },
        },
      },
      description: 'Collection item detail',
    },
    ...errorResponses(400, 401, 404, 500),
  },
});

// GET /collecting/wantlist
const wantlistRoute = createRoute({
  method: 'get',
  path: '/collecting/wantlist',
  operationId: 'listCollectingWantlist',
  tags: ['Collecting'],
  summary: 'Wantlist',
  description: 'Paginated Discogs wantlist with sorting.',
  request: {
    query: WantlistQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(WantlistItemSchema),
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                id: 100,
                discogs_id: 9999999,
                title: 'In Utero',
                artists: ['Nirvana'],
                year: 1993,
                formats: ['Vinyl'],
                genres: ['Rock'],
                image: null,
                discogs_url: 'https://www.discogs.com/release/9999999',
                notes: null,
                rating: null,
                date_added: '2026-01-10T12:00:00Z',
              },
            ],
            pagination: { page: 1, limit: 20, total: 1, total_pages: 1 },
          },
        },
      },
      description: 'Paginated wantlist items',
    },
    ...errorResponses(401, 500),
  },
});

// GET /collecting/formats
const formatsRoute = createRoute({
  method: 'get',
  path: '/collecting/formats',
  operationId: 'listCollectingFormats',
  tags: ['Collecting'],
  summary: 'Format breakdown',
  description:
    'Count of collection items grouped by primary format (Vinyl, CD, Cassette, etc).',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ data: z.array(NameCountSchema) }),
          example: {
            data: [
              { name: 'Vinyl', count: 253 },
              { name: 'CD', count: 29 },
              { name: 'Other', count: 2 },
            ],
          },
        },
      },
      description: 'Format counts',
    },
    ...errorResponses(401, 500),
  },
});

// GET /collecting/genres
const genresRoute = createRoute({
  method: 'get',
  path: '/collecting/genres',
  operationId: 'listCollectingGenres',
  tags: ['Collecting'],
  summary: 'Genre breakdown',
  description: 'Count of collection items grouped by genre.',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ data: z.array(NameCountSchema) }),
          example: {
            data: [
              { name: 'Rock', count: 120 },
              { name: 'Pop', count: 45 },
              { name: 'Hip Hop', count: 38 },
            ],
          },
        },
      },
      description: 'Genre counts',
    },
    ...errorResponses(401, 500),
  },
});

// GET /collecting/artists
const artistsRoute = createRoute({
  method: 'get',
  path: '/collecting/artists',
  operationId: 'listCollectingArtists',
  tags: ['Collecting'],
  summary: 'Top artists',
  description: 'Artists ranked by number of releases in the collection.',
  request: {
    query: ArtistLimitQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ data: z.array(ArtistItemSchema) }),
          example: {
            data: [
              {
                name: 'Taylor Swift',
                discogs_id: 123456,
                image_url: null,
                release_count: 24,
              },
              {
                name: 'Nirvana',
                discogs_id: 125246,
                image_url: null,
                release_count: 5,
              },
              {
                name: 'Beastie Boys',
                discogs_id: 19943,
                image_url: null,
                release_count: 3,
              },
            ],
          },
        },
      },
      description: 'Artist list with release counts',
    },
    ...errorResponses(401, 500),
  },
});

// GET /collecting/cross-reference
const crossRefRoute = createRoute({
  method: 'get',
  path: '/collecting/cross-reference',
  operationId: 'getCollectingCrossReference',
  tags: ['Collecting'],
  summary: 'Collection-listening cross-reference',
  description:
    'Cross-references vinyl collection with Last.fm listening data showing play counts and match confidence.',
  request: {
    query: CrossRefQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(CrossReferenceItemSchema),
            summary: CrossReferenceSummarySchema,
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                collection: {
                  id: 1,
                  discogs_id: 6872464,
                  title: 'Nevermind',
                  artists: ['Nirvana'],
                  year: 1991,
                  format: 'Vinyl',
                  genres: ['Rock'],
                  styles: ['Grunge'],
                  image: null,
                  date_added: '2026-03-11T16:05:58-07:00',
                  rating: 0,
                  discogs_url: 'https://www.discogs.com/release/6872464',
                },
                listening: {
                  album_name: 'Nevermind',
                  artist_name: 'Nirvana',
                  play_count: 333,
                  last_played: '2026-02-15T20:00:00Z',
                  match_type: 'exact',
                  match_confidence: 1.0,
                },
              },
            ],
            summary: {
              total_matches: 50,
              listen_rate: 0.72,
              unlistened_count: 14,
            },
            pagination: { page: 1, limit: 20, total: 50, total_pages: 3 },
          },
        },
      },
      description: 'Cross-reference data with summary stats',
    },
    ...errorResponses(401, 500),
  },
});

// GET /collecting/calendar
const calendarRoute = createRoute({
  method: 'get',
  path: '/collecting/calendar',
  operationId: 'getCollectingCalendar',
  tags: ['Collecting'],
  summary: 'Collection calendar',
  description:
    'Returns daily addition counts for a given year (vinyl and media combined).',
  request: {
    query: z.object({
      year: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            year: z.number(),
            days: z.array(
              z.object({
                date: z.string(),
                count: z.number(),
              })
            ),
            total: z.number(),
            max_day: z.object({
              date: z.string(),
              count: z.number(),
            }),
          }),
          example: {
            year: 2026,
            days: [
              { date: '2026-01-15', count: 3 },
              { date: '2026-02-01', count: 5 },
            ],
            total: 139,
            max_day: { date: '2026-02-01', count: 5 },
          },
        },
      },
      description: 'Calendar data with daily counts',
    },
    ...errorResponses(401, 500),
  },
});

// POST /admin/sync/collecting
const syncCollectingRoute = createRoute({
  method: 'post',
  path: '/admin/sync/collecting',
  operationId: 'adminSyncCollecting',
  'x-hidden': true,
  tags: ['Collecting', 'Admin'],
  summary: 'Sync Discogs collection',
  description: 'Trigger a manual sync of the Discogs vinyl collection.',
  responses: {
    200: {
      content: {
        'application/json': { schema: SyncResponseSchema },
      },
      description: 'Sync completed',
    },
    ...errorResponses(401, 500),
  },
});

// POST /admin/collecting/backfill-images
const backfillImagesRoute = createRoute({
  method: 'post',
  path: '/admin/collecting/backfill-images',
  operationId: 'adminCollectingBackfillImages',
  'x-hidden': true,
  tags: ['Collecting', 'Admin'],
  summary: 'Backfill collection images',
  description:
    'Process images for Discogs releases that are missing image metadata.',
  request: {
    body: {
      content: {
        'application/json': { schema: BackfillLimitBodySchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: BackfillResponseSchema },
      },
      description: 'Backfill results',
    },
    ...errorResponses(401, 500),
  },
});

// GET /collecting/media
const mediaListRoute = createRoute({
  method: 'get',
  path: '/collecting/media',
  operationId: 'listCollectingMedia',
  tags: ['Collecting'],
  summary: 'List physical media collection',
  description:
    'Paginated, filterable Trakt physical media collection (Blu-ray, DVD, etc) with movie metadata.',
  request: {
    query: MediaQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(MediaItemSchema),
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                id: 1,
                title: 'Top Gun: Maverick',
                year: 2022,
                tmdb_id: 361743,
                imdb_id: 'tt1745960',
                image: {
                  url: 'https://cdn.rewind.rest/collecting/media/1/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
                  thumbhash: 'YRcKDQKadZh4d3Z4d3aHeAeAh4B3',
                  dominant_color: '#2a2a2a',
                  accent_color: '#c8a882',
                },
                runtime: 131,
                tmdb_rating: 8.2,
                media_type: 'bluray',
                resolution: '1080p',
                hdr: null,
                audio: 'Dolby Atmos',
                audio_channels: '7.1',
                collected_at: '2026-01-15T00:00:00Z',
              },
              {
                id: 2,
                title: 'The Great Escape',
                year: 1963,
                tmdb_id: 5925,
                imdb_id: 'tt0057115',
                image: null,
                runtime: 172,
                tmdb_rating: 8.0,
                media_type: 'bluray_4k',
                resolution: '2160p',
                hdr: 'HDR10',
                audio: 'DTS-HD MA',
                audio_channels: '5.1',
                collected_at: '2025-12-25T00:00:00Z',
              },
              {
                id: 3,
                title: 'Interstellar',
                year: 2014,
                tmdb_id: 157336,
                imdb_id: 'tt0816692',
                image: null,
                runtime: 169,
                tmdb_rating: 8.4,
                media_type: 'bluray_4k',
                resolution: '2160p',
                hdr: 'HDR10',
                audio: 'DTS-HD MA',
                audio_channels: '5.1',
                collected_at: '2025-11-10T00:00:00Z',
              },
            ],
            pagination: { page: 1, limit: 20, total: 45, total_pages: 3 },
          },
        },
      },
      description: 'Paginated media items',
    },
    ...errorResponses(401, 500),
  },
});

// GET /collecting/media/stats
const mediaStatsRoute = createRoute({
  method: 'get',
  path: '/collecting/media/stats',
  operationId: 'getCollectingMediaStats',
  tags: ['Collecting'],
  summary: 'Physical media statistics',
  description:
    'Aggregate statistics for the physical media collection by format, resolution, HDR, genre, and decade.',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: MediaStatsSchema,
          example: {
            total_items: 45,
            by_format: { 'Blu-ray': 25, '4K UHD': 15, DVD: 5 },
            by_resolution: { '1080p': 25, '2160p': 15, '480p': 5 },
            by_hdr: { HDR10: 10, 'Dolby Vision': 5, none: 30 },
            by_genre: { Action: 15, Drama: 12, 'Science Fiction': 8 },
            by_decade: { '2020s': 10, '2010s': 15, '2000s': 8 },
            added_this_year: 12,
          },
        },
      },
      description: 'Media collection statistics',
    },
    ...errorResponses(401, 500),
  },
});

// GET /collecting/media/recent
const mediaRecentRoute = createRoute({
  method: 'get',
  path: '/collecting/media/recent',
  operationId: 'getCollectingMediaRecent',
  tags: ['Collecting'],
  summary: 'Recently added physical media',
  description:
    'Most recently added items to the physical media collection. Supports date filtering via date, from, and to params.',
  request: {
    query: LimitQuerySchema.merge(DateFilterQuery),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ data: z.array(MediaRecentItemSchema) }),
          example: {
            data: [
              {
                id: 1,
                title: 'Top Gun: Maverick',
                year: 2022,
                tmdb_id: 361743,
                image: null,
                tmdb_rating: 8.2,
                media_type: 'bluray',
                resolution: '1080p',
                hdr: null,
                audio: 'Dolby Atmos',
                audio_channels: '7.1',
                collected_at: '2026-01-15T00:00:00Z',
              },
            ],
          },
        },
      },
      description: 'Recent media items',
    },
    ...errorResponses(401, 500),
  },
});

// GET /collecting/media/formats
const mediaFormatsRoute = createRoute({
  method: 'get',
  path: '/collecting/media/formats',
  operationId: 'listCollectingMediaFormats',
  tags: ['Collecting'],
  summary: 'Media format breakdown',
  description:
    'Count of physical media items grouped by format type (bluray, dvd, etc).',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ data: z.array(NameCountSchema) }),
          example: {
            data: [
              { name: 'Blu-ray', count: 25 },
              { name: '4K UHD', count: 15 },
              { name: 'DVD', count: 5 },
            ],
          },
        },
      },
      description: 'Format counts',
    },
    ...errorResponses(401, 500),
  },
});

// GET /collecting/media/cross-reference
const mediaCrossRefRoute = createRoute({
  method: 'get',
  path: '/collecting/media/cross-reference',
  operationId: 'getCollectingMediaCrossReference',
  tags: ['Collecting'],
  summary: 'Owned vs watched cross-reference',
  description:
    'Cross-references physical media collection with watch history showing watched/unwatched status.',
  request: {
    query: MediaCrossRefQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(MediaCrossRefItemSchema),
            summary: MediaCrossRefSummarySchema,
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                collection: {
                  id: 2,
                  title: 'The Great Escape',
                  year: 1963,
                  tmdb_id: 5925,
                  image: null,
                  media_type: 'bluray_4k',
                  resolution: '2160p',
                  collected_at: '2025-12-25T00:00:00Z',
                },
                watching: {
                  watched: true,
                  watch_count: 3,
                  last_watched: '2025-08-10T20:00:00Z',
                },
              },
            ],
            summary: {
              total_owned: 45,
              total_watched: 30,
              total_unwatched: 15,
              watch_rate: 0.67,
            },
            pagination: { page: 1, limit: 20, total: 30, total_pages: 2 },
          },
        },
      },
      description: 'Cross-reference data with summary stats',
    },
    ...errorResponses(401, 500),
  },
});

// GET /collecting/media/:id
const mediaDetailRoute = createRoute({
  method: 'get',
  path: '/collecting/media/{id}',
  operationId: 'getCollectingMediaItem',
  tags: ['Collecting'],
  summary: 'Physical media item detail',
  description:
    'Full detail for a single physical media item including movie metadata and watch history.',
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: MediaDetailSchema,
          example: {
            id: 2,
            title: 'The Great Escape',
            year: 1963,
            tmdb_id: 5925,
            imdb_id: 'tt0057115',
            tagline: 'No prison can hold them!',
            summary:
              'Allied prisoners of war plan for several hundred of their number to escape from a German camp during World War II.',
            image: null,
            runtime: 172,
            tmdb_rating: 8.0,
            content_rating: 'NR',
            media_type: 'bluray_4k',
            resolution: '2160p',
            hdr: 'HDR10',
            audio: 'DTS-HD MA',
            audio_channels: '5.1',
            collected_at: '2025-12-25T00:00:00Z',
            watch_history: [
              {
                watched_at: '2025-08-10T20:00:00Z',
                source: 'plex',
                user_rating: null,
              },
            ],
          },
        },
      },
      description: 'Media item detail',
    },
    ...errorResponses(400, 401, 404, 500),
  },
});

// POST /admin/collecting/media
const addMediaRoute = createRoute({
  method: 'post',
  path: '/admin/collecting/media',
  operationId: 'adminAddCollectingMedia',
  'x-hidden': true,
  tags: ['Collecting', 'Admin'],
  summary: 'Add physical media',
  description:
    'Add a movie to the physical media collection. Resolves via TMDb, pushes to Trakt, stores locally.',
  request: {
    body: {
      content: {
        'application/json': { schema: AddMediaBodySchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: AddMediaResponseSchema },
      },
      description: 'Media added successfully',
    },
    ...errorResponses(400, 401, 404, 500),
  },
});

// POST /admin/collecting/media/:id/remove
const removeMediaRoute = createRoute({
  method: 'post',
  path: '/admin/collecting/media/{id}/remove',
  operationId: 'adminRemoveCollectingMedia',
  'x-hidden': true,
  tags: ['Collecting', 'Admin'],
  summary: 'Remove physical media',
  description:
    'Remove a movie from the physical media collection. Removes from both Trakt and local database.',
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: RemoveMediaResponseSchema },
      },
      description: 'Media removed',
    },
    ...errorResponses(400, 401, 404, 500),
  },
});

// POST /admin/sync/trakt
const syncTraktRoute = createRoute({
  method: 'post',
  path: '/admin/sync/trakt',
  operationId: 'adminSyncTrakt',
  'x-hidden': true,
  tags: ['Collecting', 'Admin'],
  summary: 'Sync Trakt collection',
  description: 'Trigger a manual sync of the Trakt physical media collection.',
  responses: {
    200: {
      content: {
        'application/json': { schema: SyncResponseSchema },
      },
      description: 'Sync completed',
    },
    ...errorResponses(401, 500),
  },
});

// POST /admin/collecting/media/backfill-images
const mediaBackfillImagesRoute = createRoute({
  method: 'post',
  path: '/admin/collecting/media/backfill-images',
  operationId: 'adminCollectingMediaBackfillImages',
  'x-hidden': true,
  tags: ['Collecting', 'Admin'],
  summary: 'Backfill media poster images',
  description:
    'Process poster images for movies in the physical media collection that are missing image metadata.',
  request: {
    body: {
      content: {
        'application/json': { schema: BackfillLimitBodySchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: BackfillResponseSchema },
      },
      description: 'Backfill results',
    },
    ...errorResponses(401, 500),
  },
});

// ─── Handlers ───────────────────────────────────────────────────────

// GET /collecting/collection - paginated, filterable, searchable
collecting.openapi(collectionListRoute, async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(c.req.query('limit') || '20', 10))
    );
    const format = c.req.query('format');
    const genre = c.req.query('genre');
    const artist = c.req.query('artist');
    const sort = c.req.query('sort') || 'date_added';
    const order = c.req.query('order') || 'desc';
    const q = c.req.query('q');

    const db = createDb(c.env.DB);
    const offset = (page - 1) * limit;

    const conditions = [eq(discogsCollection.userId, 1)];

    const dateConditionList = buildDateCondition(discogsCollection.dateAdded, {
      date: c.req.query('date'),
      from: c.req.query('from'),
      to: c.req.query('to'),
    });
    if (dateConditionList) {
      conditions.push(dateConditionList);
    }

    if (format) {
      conditions.push(
        sql`json_extract(${discogsReleases.formats}, '$[0]') = ${format}`
      );
    }
    if (genre) {
      conditions.push(sql`${discogsReleases.genres} like ${`%${genre}%`}`);
    }
    if (q) {
      conditions.push(
        or(
          like(discogsReleases.title, `%${q}%`),
          sql`exists (
            select 1 from discogs_release_artists dra
            inner join discogs_artists da on dra.artist_id = da.id
            where dra.release_id = discogs_releases.id
            and da.name like ${`%${q}%`}
          )`
        )!
      );
    }
    if (artist) {
      conditions.push(
        sql`exists (
          select 1 from discogs_release_artists dra
          inner join discogs_artists da on dra.artist_id = da.id
          where dra.release_id = discogs_releases.id
          and da.name like ${`%${artist}%`}
        )`
      );
    }

    const whereClause = and(...conditions);

    // Count total
    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(discogsCollection)
      .innerJoin(
        discogsReleases,
        eq(discogsCollection.releaseId, discogsReleases.id)
      )
      .where(whereClause);

    // Determine sort column
    let orderBy;
    const direction = order === 'asc' ? asc : desc;
    switch (sort) {
      case 'title':
        orderBy = direction(discogsReleases.title);
        break;
      case 'year':
        orderBy = direction(discogsReleases.year);
        break;
      case 'rating':
        orderBy = direction(discogsCollection.rating);
        break;
      case 'date_added':
      default:
        orderBy = direction(discogsCollection.dateAdded);
        break;
    }

    const rows = await db
      .select({
        id: discogsCollection.id,
        discogsId: discogsReleases.discogsId,
        title: discogsReleases.title,
        year: discogsReleases.year,
        format: discogsReleases.formats,
        formatDetail: discogsReleases.formatDetails,
        label: discogsReleases.labels,
        genres: discogsReleases.genres,
        styles: discogsReleases.styles,
        coverUrl: discogsReleases.coverUrl,
        dateAdded: discogsCollection.dateAdded,
        rating: discogsCollection.rating,
        discogsUrl: discogsReleases.discogsUrl,
      })
      .from(discogsCollection)
      .innerJoin(
        discogsReleases,
        eq(discogsCollection.releaseId, discogsReleases.id)
      )
      .where(whereClause)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    // Get artists and image metadata for each release
    const releaseIds = rows.map((r) => String(r.discogsId));
    const imageMap = await getImageAttachmentBatch(
      db,
      'collecting',
      'releases',
      releaseIds
    );

    const data = await Promise.all(
      rows.map(async (row) => {
        const artistRows = await db
          .select({ name: discogsArtists.name })
          .from(discogsReleaseArtists)
          .innerJoin(
            discogsArtists,
            eq(discogsReleaseArtists.artistId, discogsArtists.id)
          )
          .innerJoin(
            discogsReleases,
            eq(discogsReleaseArtists.releaseId, discogsReleases.id)
          )
          .where(eq(discogsReleases.discogsId, row.discogsId));

        const formats: string[] = row.format ? JSON.parse(row.format) : [];
        return {
          id: row.id,
          discogs_id: row.discogsId,
          title: row.title,
          artists: artistRows.map((a) => a.name),
          year: row.year,
          format: formats[0] || 'Unknown',
          format_detail: row.formatDetail || '[]',
          label: row.label || '[]',
          genres: row.genres ? JSON.parse(row.genres) : [],
          styles: row.styles ? JSON.parse(row.styles) : [],
          image: imageMap.get(String(row.discogsId)) ?? null,
          date_added: row.dateAdded,
          rating: row.rating,
          discogs_url: row.discogsUrl,
        };
      })
    );

    setCache(c, 'long');
    return c.json({
      data,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/collection: ${err}`);
    return serverError(c) as any;
  }
});

// GET /collecting/stats
collecting.openapi(collectionStatsRoute, async (c) => {
  try {
    const db = createDb(c.env.DB);

    const dateCondition = buildDateCondition(discogsCollection.dateAdded, {
      date: c.req.query('date'),
      from: c.req.query('from'),
      to: c.req.query('to'),
    });

    // Date-scoped: compute live from collection data
    if (dateCondition) {
      const scopedCondition = and(
        eq(discogsCollection.userId, 1),
        dateCondition
      );

      const [totals] = await db
        .select({
          totalItems: count(),
          uniqueArtists: sql<number>`count(distinct ${discogsReleases.id})`,
        })
        .from(discogsCollection)
        .innerJoin(
          discogsReleases,
          eq(discogsCollection.releaseId, discogsReleases.id)
        )
        .where(scopedCondition);

      // Top genre within range
      const [topGenre] = await db
        .select({
          genre: sql<string>`json_each.value`,
          total: count(),
        })
        .from(discogsCollection)
        .innerJoin(
          discogsReleases,
          eq(discogsCollection.releaseId, discogsReleases.id)
        )
        .where(and(scopedCondition, sql`${discogsReleases.genres} IS NOT NULL`))
        .innerJoin(sql`json_each(${discogsReleases.genres})`, sql`1=1`)
        .groupBy(sql`json_each.value`)
        .orderBy(desc(count()))
        .limit(1);

      setCache(c, 'medium');
      return c.json({
        data: {
          total_items: totals.totalItems,
          by_format: { vinyl: 0, cd: 0, cassette: 0, other: 0 },
          wantlist_count: 0,
          unique_artists: totals.uniqueArtists,
          estimated_value: null,
          top_genre: topGenre?.genre || null,
          oldest_release_year: null,
          newest_release_year: null,
          most_collected_artist: null,
          added_this_year: 0,
        },
      });
    }

    // Lifetime: use pre-computed stats table
    const [stats] = await db
      .select()
      .from(discogsCollectionStats)
      .where(eq(discogsCollectionStats.userId, 1));

    if (!stats) {
      return c.json({
        data: {
          total_items: 0,
          by_format: { vinyl: 0, cd: 0, cassette: 0, other: 0 },
          wantlist_count: 0,
          unique_artists: 0,
          estimated_value: null,
          top_genre: null,
          oldest_release_year: null,
          newest_release_year: null,
          most_collected_artist: null,
          added_this_year: 0,
        },
      });
    }

    setCache(c, 'long');
    return c.json({
      data: {
        total_items: stats.totalItems,
        by_format: stats.byFormat
          ? JSON.parse(stats.byFormat)
          : { vinyl: 0, cd: 0, cassette: 0, other: 0 },
        wantlist_count: stats.wantlistCount,
        unique_artists: stats.uniqueArtists,
        estimated_value: stats.estimatedValue,
        top_genre: stats.topGenre,
        oldest_release_year: stats.oldestReleaseYear,
        newest_release_year: stats.newestReleaseYear,
        most_collected_artist: stats.mostCollectedArtist
          ? JSON.parse(stats.mostCollectedArtist)
          : null,
        added_this_year: stats.addedThisYear,
      },
    });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/stats: ${err}`);
    return serverError(c) as any;
  }
});

// GET /collecting/recent
collecting.openapi(collectionRecentRoute, async (c) => {
  try {
    const limit = Math.min(
      20,
      Math.max(1, parseInt(c.req.query('limit') || '5', 10))
    );

    const db = createDb(c.env.DB);

    const dateCondition = buildDateCondition(discogsCollection.dateAdded, {
      date: c.req.query('date'),
      from: c.req.query('from'),
      to: c.req.query('to'),
    });

    const rows = await db
      .select({
        id: discogsCollection.id,
        discogsId: discogsReleases.discogsId,
        title: discogsReleases.title,
        year: discogsReleases.year,
        format: discogsReleases.formats,
        formatDetail: discogsReleases.formatDetails,
        label: discogsReleases.labels,
        genres: discogsReleases.genres,
        styles: discogsReleases.styles,
        coverUrl: discogsReleases.coverUrl,
        dateAdded: discogsCollection.dateAdded,
        rating: discogsCollection.rating,
        discogsUrl: discogsReleases.discogsUrl,
      })
      .from(discogsCollection)
      .innerJoin(
        discogsReleases,
        eq(discogsCollection.releaseId, discogsReleases.id)
      )
      .where(and(eq(discogsCollection.userId, 1), dateCondition))
      .orderBy(desc(discogsCollection.dateAdded))
      .limit(limit);

    const releaseIds = rows.map((r) => String(r.discogsId));
    const imageMap = await getImageAttachmentBatch(
      db,
      'collecting',
      'releases',
      releaseIds
    );

    const data = await Promise.all(
      rows.map(async (row) => {
        const artistRows = await db
          .select({ name: discogsArtists.name })
          .from(discogsReleaseArtists)
          .innerJoin(
            discogsArtists,
            eq(discogsReleaseArtists.artistId, discogsArtists.id)
          )
          .innerJoin(
            discogsReleases,
            eq(discogsReleaseArtists.releaseId, discogsReleases.id)
          )
          .where(eq(discogsReleases.discogsId, row.discogsId));

        const formats: string[] = row.format ? JSON.parse(row.format) : [];
        return {
          id: row.id,
          discogs_id: row.discogsId,
          title: row.title,
          artists: artistRows.map((a) => a.name),
          year: row.year,
          format: formats[0] || 'Unknown',
          format_detail: row.formatDetail || '[]',
          label: row.label || '[]',
          genres: row.genres ? JSON.parse(row.genres) : [],
          styles: row.styles ? JSON.parse(row.styles) : [],
          image: imageMap.get(String(row.discogsId)) ?? null,
          date_added: row.dateAdded,
          rating: row.rating,
          discogs_url: row.discogsUrl,
        };
      })
    );

    setCache(c, 'medium');
    return c.json({ data });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/recent: ${err}`);
    return serverError(c) as any;
  }
});

// GET /collecting/collection/:id
collecting.openapi(collectionDetailRoute, async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return badRequest(c, 'Invalid collection item ID') as any;
    }

    const db = createDb(c.env.DB);

    const [row] = await db
      .select({
        id: discogsCollection.id,
        discogsId: discogsReleases.discogsId,
        title: discogsReleases.title,
        year: discogsReleases.year,
        format: discogsReleases.formats,
        formatDetail: discogsReleases.formatDetails,
        label: discogsReleases.labels,
        genres: discogsReleases.genres,
        styles: discogsReleases.styles,
        coverUrl: discogsReleases.coverUrl,
        dateAdded: discogsCollection.dateAdded,
        rating: discogsCollection.rating,
        discogsUrl: discogsReleases.discogsUrl,
        tracklist: discogsReleases.tracklist,
        country: discogsReleases.country,
        communityHave: discogsReleases.communityHave,
        communityWant: discogsReleases.communityWant,
        lowestPrice: discogsReleases.lowestPrice,
        numForSale: discogsReleases.numForSale,
        notes: discogsCollection.notes,
      })
      .from(discogsCollection)
      .innerJoin(
        discogsReleases,
        eq(discogsCollection.releaseId, discogsReleases.id)
      )
      .where(
        and(eq(discogsCollection.id, id), eq(discogsCollection.userId, 1))
      );

    if (!row) {
      return notFound(c, 'Collection item not found') as any;
    }

    const artistRows = await db
      .select({ name: discogsArtists.name })
      .from(discogsReleaseArtists)
      .innerJoin(
        discogsArtists,
        eq(discogsReleaseArtists.artistId, discogsArtists.id)
      )
      .innerJoin(
        discogsReleases,
        eq(discogsReleaseArtists.releaseId, discogsReleases.id)
      )
      .where(eq(discogsReleases.discogsId, row.discogsId));

    const formats: string[] = row.format ? JSON.parse(row.format) : [];
    const image = await getImageAttachment(
      db,
      'collecting',
      'releases',
      String(row.discogsId)
    );

    setCache(c, 'long');
    return c.json({
      id: row.id,
      discogs_id: row.discogsId,
      title: row.title,
      artists: artistRows.map((a) => a.name),
      year: row.year,
      format: formats[0] || 'Unknown',
      format_detail: row.formatDetail || '[]',
      label: row.label || '[]',
      genres: row.genres ? JSON.parse(row.genres) : [],
      styles: row.styles ? JSON.parse(row.styles) : [],
      image,
      date_added: row.dateAdded,
      rating: row.rating,
      discogs_url: row.discogsUrl,
      tracklist: row.tracklist ? JSON.parse(row.tracklist) : [],
      country: row.country,
      community_have: row.communityHave,
      community_want: row.communityWant,
      lowest_price: row.lowestPrice,
      num_for_sale: row.numForSale,
      notes: row.notes ? JSON.parse(row.notes) : null,
    });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/collection/:id: ${err}`);
    return serverError(c) as any;
  }
});

// GET /collecting/wantlist
collecting.openapi(wantlistRoute, async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(c.req.query('limit') || '20', 10))
    );
    const sort = c.req.query('sort') || 'date_added';
    const order = c.req.query('order') || 'desc';

    const db = createDb(c.env.DB);
    const offset = (page - 1) * limit;

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(discogsWantlist)
      .where(eq(discogsWantlist.userId, 1));

    const direction = order === 'asc' ? asc : desc;
    let orderBy;
    switch (sort) {
      case 'title':
        orderBy = direction(discogsWantlist.title);
        break;
      case 'year':
        orderBy = direction(discogsWantlist.year);
        break;
      case 'date_added':
      default:
        orderBy = direction(discogsWantlist.dateAdded);
        break;
    }

    const rows = await db
      .select()
      .from(discogsWantlist)
      .where(eq(discogsWantlist.userId, 1))
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    const data = rows.map((row) => ({
      id: row.id,
      discogs_id: row.discogsId,
      title: row.title,
      artists: row.artists ? JSON.parse(row.artists) : [],
      year: row.year,
      formats: row.formats ? JSON.parse(row.formats) : [],
      genres: row.genres ? JSON.parse(row.genres) : [],
      image: null as null,
      discogs_url: row.discogsUrl,
      notes: row.notes,
      rating: row.rating,
      date_added: row.dateAdded,
    }));

    setCache(c, 'long');
    return c.json({
      data,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/wantlist: ${err}`);
    return serverError(c) as any;
  }
});

// GET /collecting/formats
collecting.openapi(formatsRoute, async (c) => {
  try {
    const db = createDb(c.env.DB);

    const rows = await db
      .select({ formats: discogsReleases.formats })
      .from(discogsCollection)
      .innerJoin(
        discogsReleases,
        eq(discogsCollection.releaseId, discogsReleases.id)
      )
      .where(eq(discogsCollection.userId, 1));

    const formatCounts: Record<string, number> = {};
    for (const row of rows) {
      const formats: string[] = row.formats ? JSON.parse(row.formats) : [];
      const primaryFormat = formats[0] || 'Unknown';
      formatCounts[primaryFormat] = (formatCounts[primaryFormat] || 0) + 1;
    }

    const data = Object.entries(formatCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    setCache(c, 'long');
    return c.json({ data });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/formats: ${err}`);
    return serverError(c) as any;
  }
});

// GET /collecting/genres
collecting.openapi(genresRoute, async (c) => {
  try {
    const db = createDb(c.env.DB);

    const rows = await db
      .select({ genres: discogsReleases.genres })
      .from(discogsCollection)
      .innerJoin(
        discogsReleases,
        eq(discogsCollection.releaseId, discogsReleases.id)
      )
      .where(eq(discogsCollection.userId, 1));

    const genreCounts: Record<string, number> = {};
    for (const row of rows) {
      const genres: string[] = row.genres ? JSON.parse(row.genres) : [];
      for (const genre of genres) {
        genreCounts[genre] = (genreCounts[genre] || 0) + 1;
      }
    }

    const data = Object.entries(genreCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    setCache(c, 'long');
    return c.json({ data });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/genres: ${err}`);
    return serverError(c) as any;
  }
});

// GET /collecting/artists
collecting.openapi(artistsRoute, async (c) => {
  try {
    const limit = Math.min(
      100,
      Math.max(1, parseInt(c.req.query('limit') || '20', 10))
    );

    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        name: discogsArtists.name,
        discogsId: discogsArtists.discogsId,
        imageUrl: discogsArtists.imageUrl,
        count: sql<number>`count(*)`,
      })
      .from(discogsReleaseArtists)
      .innerJoin(
        discogsArtists,
        eq(discogsReleaseArtists.artistId, discogsArtists.id)
      )
      .innerJoin(
        discogsCollection,
        eq(discogsReleaseArtists.releaseId, discogsCollection.releaseId)
      )
      .where(eq(discogsCollection.userId, 1))
      .groupBy(discogsArtists.id)
      .orderBy(sql`count(*) desc`)
      .limit(limit);

    const data = rows.map((row) => ({
      name: row.name,
      discogs_id: row.discogsId,
      image_url: row.imageUrl,
      release_count: row.count,
    }));

    setCache(c, 'long');
    return c.json({ data });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/artists: ${err}`);
    return serverError(c) as any;
  }
});

// GET /collecting/cross-reference
collecting.openapi(crossRefRoute, async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(c.req.query('limit') || '20', 10))
    );
    const sort = c.req.query('sort') || 'plays';
    const filter = c.req.query('filter') || 'all';

    const db = createDb(c.env.DB);
    const offset = (page - 1) * limit;

    const conditions = [eq(collectionListeningXref.userId, 1)];

    if (filter === 'listened') {
      conditions.push(sql`${collectionListeningXref.playCount} > 0`);
    } else if (filter === 'unlistened') {
      conditions.push(
        or(
          eq(collectionListeningXref.playCount, 0),
          eq(collectionListeningXref.matchType, 'none')
        )!
      );
    }

    const whereClause = and(...conditions);

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(collectionListeningXref)
      .where(whereClause);

    const orderBy =
      sort === 'added'
        ? desc(discogsCollection.dateAdded)
        : desc(collectionListeningXref.playCount);

    const rows = await db
      .select({
        xrefId: collectionListeningXref.id,
        collectionId: collectionListeningXref.collectionId,
        releaseId: collectionListeningXref.releaseId,
        lastfmAlbumName: collectionListeningXref.lastfmAlbumName,
        lastfmArtistName: collectionListeningXref.lastfmArtistName,
        playCount: collectionListeningXref.playCount,
        lastPlayed: collectionListeningXref.lastPlayed,
        matchType: collectionListeningXref.matchType,
        matchConfidence: collectionListeningXref.matchConfidence,
        // Collection item fields
        itemId: discogsCollection.id,
        dateAdded: discogsCollection.dateAdded,
        rating: discogsCollection.rating,
        // Release fields
        discogsId: discogsReleases.discogsId,
        title: discogsReleases.title,
        year: discogsReleases.year,
        formats: discogsReleases.formats,
        genres: discogsReleases.genres,
        styles: discogsReleases.styles,
        coverUrl: discogsReleases.coverUrl,
        discogsUrl: discogsReleases.discogsUrl,
      })
      .from(collectionListeningXref)
      .innerJoin(
        discogsCollection,
        eq(collectionListeningXref.collectionId, discogsCollection.id)
      )
      .innerJoin(
        discogsReleases,
        eq(collectionListeningXref.releaseId, discogsReleases.id)
      )
      .where(whereClause)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    const releaseIds = rows.map((r) => String(r.discogsId));
    const imageMap = await getImageAttachmentBatch(
      db,
      'collecting',
      'releases',
      releaseIds
    );

    const data = await Promise.all(
      rows.map(async (row) => {
        const artistRows = await db
          .select({ name: discogsArtists.name })
          .from(discogsReleaseArtists)
          .innerJoin(
            discogsArtists,
            eq(discogsReleaseArtists.artistId, discogsArtists.id)
          )
          .innerJoin(
            discogsReleases,
            eq(discogsReleaseArtists.releaseId, discogsReleases.id)
          )
          .where(eq(discogsReleases.discogsId, row.discogsId));

        const formats: string[] = row.formats ? JSON.parse(row.formats) : [];

        return {
          collection: {
            id: row.itemId,
            discogs_id: row.discogsId,
            title: row.title,
            artists: artistRows.map((a) => a.name),
            year: row.year,
            format: formats[0] || 'Unknown',
            genres: row.genres ? JSON.parse(row.genres) : [],
            styles: row.styles ? JSON.parse(row.styles) : [],
            image: imageMap.get(String(row.discogsId)) ?? null,
            date_added: row.dateAdded,
            rating: row.rating,
            discogs_url: row.discogsUrl,
          },
          listening: {
            album_name: row.lastfmAlbumName,
            artist_name: row.lastfmArtistName,
            play_count: row.playCount,
            last_played: row.lastPlayed,
            match_type: row.matchType,
            match_confidence: row.matchConfidence,
          },
        };
      })
    );

    // Summary stats
    const [{ totalMatches }] = await db
      .select({
        totalMatches: sql<number>`count(case when ${collectionListeningXref.matchType} != 'none' then 1 end)`,
      })
      .from(collectionListeningXref)
      .where(eq(collectionListeningXref.userId, 1));

    const [{ totalAll }] = await db
      .select({ totalAll: sql<number>`count(*)` })
      .from(collectionListeningXref)
      .where(eq(collectionListeningXref.userId, 1));

    const [{ unlistenedCount }] = await db
      .select({
        unlistenedCount: sql<number>`count(case when ${collectionListeningXref.playCount} = 0 or ${collectionListeningXref.matchType} = 'none' then 1 end)`,
      })
      .from(collectionListeningXref)
      .where(eq(collectionListeningXref.userId, 1));

    setCache(c, 'long');
    return c.json({
      data,
      summary: {
        total_matches: totalMatches,
        listen_rate: totalAll > 0 ? totalMatches / totalAll : 0,
        unlistened_count: unlistenedCount,
      },
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/cross-reference: ${err}`);
    return serverError(c) as any;
  }
});

// GET /collecting/calendar
collecting.openapi(calendarRoute, async (c) => {
  try {
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

    // Vinyl additions
    const vinylDays = await db
      .select({
        date: sql<string>`substr(${discogsCollection.dateAdded}, 1, 10)`,
        count: count(),
      })
      .from(discogsCollection)
      .where(
        and(
          eq(discogsCollection.userId, 1),
          gte(discogsCollection.dateAdded, startDate),
          lte(discogsCollection.dateAdded, endDate)
        )
      )
      .groupBy(sql`substr(${discogsCollection.dateAdded}, 1, 10)`);

    // Media additions
    const mediaDays = await db
      .select({
        date: sql<string>`substr(${traktCollection.collectedAt}, 1, 10)`,
        count: count(),
      })
      .from(traktCollection)
      .where(
        and(
          eq(traktCollection.userId, 1),
          gte(traktCollection.collectedAt, startDate),
          lte(traktCollection.collectedAt, endDate)
        )
      )
      .groupBy(sql`substr(${traktCollection.collectedAt}, 1, 10)`);

    // Merge vinyl + media by date
    const dayMap = new Map<string, number>();
    for (const row of vinylDays) {
      dayMap.set(row.date, (dayMap.get(row.date) ?? 0) + row.count);
    }
    for (const row of mediaDays) {
      dayMap.set(row.date, (dayMap.get(row.date) ?? 0) + row.count);
    }

    const days = [...dayMap.entries()]
      .map(([date, cnt]) => ({ date, count: cnt }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const total = days.reduce((sum, d) => sum + d.count, 0);
    const maxDay = days.reduce((max, d) => (d.count > max.count ? d : max), {
      date: '',
      count: 0,
    });

    return c.json({
      year: yearParam,
      days,
      total,
      max_day: { date: maxDay.date, count: maxDay.count },
    });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/calendar: ${err}`);
    return serverError(c) as any;
  }
});

// POST /admin/sync/collecting
collecting.openapi(syncCollectingRoute, async (c) => {
  try {
    await syncCollecting(c.env);
    return c.json({ status: 'ok', message: 'Collecting sync complete' });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] POST /admin/sync/collecting: ${errorMsg}`);
    return serverError(c, `Sync failed: ${errorMsg}`) as any;
  }
});

// POST /admin/collecting/backfill-images
collecting.openapi(backfillImagesRoute, async (c) => {
  try {
    const db = createDb(c.env.DB);
    const body = await c.req
      .json<{ limit?: number }>()
      .catch(() => ({ limit: undefined }));
    const maxItems = Math.min(body.limit || 50, 200);

    // Get releases without images, joined with primary artist name
    const rows = await db
      .select({
        discogsId: discogsReleases.discogsId,
        title: discogsReleases.title,
      })
      .from(discogsReleases)
      .where(
        sql`${discogsReleases.discogsId} NOT IN (
          SELECT ${images.entityId} FROM ${images}
          WHERE ${images.domain} = 'collecting' AND ${images.entityType} = 'releases'
        )`
      )
      .limit(maxItems);

    // Get artist names for each release
    const items: BackfillItem[] = await Promise.all(
      rows.map(async (row) => {
        const [artist] = await db
          .select({ name: discogsArtists.name })
          .from(discogsReleaseArtists)
          .innerJoin(
            discogsArtists,
            eq(discogsReleaseArtists.artistId, discogsArtists.id)
          )
          .innerJoin(
            discogsReleases,
            eq(discogsReleaseArtists.releaseId, discogsReleases.id)
          )
          .where(eq(discogsReleases.discogsId, row.discogsId))
          .limit(1);

        return {
          entityId: String(row.discogsId),
          artistName: artist?.name,
          albumName: row.title,
        };
      })
    );

    const result = await backfillImages(
      db,
      c.env,
      'collecting',
      'releases',
      items,
      { batchSize: 5, delayMs: 500 }
    );

    return c.json({ success: true, results: result });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] POST /admin/collecting/backfill-images: ${errorMsg}`);
    return serverError(c, `Backfill failed: ${errorMsg}`) as any;
  }
});

// ─── Physical Media (Trakt) Handlers ────────────────────────────────

// GET /collecting/media
collecting.openapi(mediaListRoute, async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(c.req.query('limit') || '20', 10))
    );
    const format = c.req.query('format');
    const genre = c.req.query('genre');
    const sort = c.req.query('sort') || 'collected_at';
    const order = c.req.query('order') || 'desc';
    const q = c.req.query('q');

    const db = createDb(c.env.DB);
    const offset = (page - 1) * limit;

    const conditions = [eq(traktCollection.userId, 1)];

    const dateConditionMedia = buildDateCondition(traktCollection.collectedAt, {
      date: c.req.query('date'),
      from: c.req.query('from'),
      to: c.req.query('to'),
    });
    if (dateConditionMedia) {
      conditions.push(dateConditionMedia);
    }

    if (format) {
      conditions.push(sql`${traktCollection.mediaType} = ${format}`);
    }
    if (genre) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM movie_genres mg
          JOIN genres g ON mg.genre_id = g.id
          WHERE mg.movie_id = ${movies.id}
          AND g.name LIKE ${`%${genre}%`}
        )`
      );
    }
    if (q) {
      conditions.push(like(movies.title, `%${q}%`));
    }

    const whereClause = and(...conditions);

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(traktCollection)
      .innerJoin(movies, eq(traktCollection.movieId, movies.id))
      .where(whereClause);

    const direction = order === 'asc' ? asc : desc;
    let orderBy;
    switch (sort) {
      case 'title':
        orderBy = direction(movies.title);
        break;
      case 'year':
        orderBy = direction(movies.year);
        break;
      case 'collected_at':
      default:
        orderBy = direction(traktCollection.collectedAt);
        break;
    }

    const rows = await db
      .select({
        id: traktCollection.id,
        movieId: traktCollection.movieId,
        traktId: traktCollection.traktId,
        mediaType: traktCollection.mediaType,
        resolution: traktCollection.resolution,
        hdr: traktCollection.hdr,
        audio: traktCollection.audio,
        audioChannels: traktCollection.audioChannels,
        collectedAt: traktCollection.collectedAt,
        title: movies.title,
        year: movies.year,
        tmdbId: movies.tmdbId,
        imdbId: movies.imdbId,
        posterPath: movies.posterPath,
        runtime: movies.runtime,
        tmdbRating: movies.tmdbRating,
      })
      .from(traktCollection)
      .innerJoin(movies, eq(traktCollection.movieId, movies.id))
      .where(whereClause)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    const movieIds = rows.map((r) => String(r.movieId));
    const imageMap = await getImageAttachmentBatch(
      db,
      'watching',
      'movies',
      movieIds
    );

    const data = rows.map((row) => ({
      id: row.id,
      title: row.title,
      year: row.year,
      tmdb_id: row.tmdbId,
      imdb_id: row.imdbId,
      image: imageMap.get(String(row.movieId)) ?? null,
      runtime: row.runtime,
      tmdb_rating: row.tmdbRating,
      media_type: row.mediaType,
      resolution: row.resolution,
      hdr: row.hdr,
      audio: row.audio,
      audio_channels: row.audioChannels,
      collected_at: row.collectedAt,
    }));

    setCache(c, 'long');
    return c.json({
      data,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/media: ${err}`);
    return serverError(c) as any;
  }
});

// GET /collecting/media/stats
collecting.openapi(mediaStatsRoute, async (c) => {
  try {
    const db = createDb(c.env.DB);

    const [stats] = await db
      .select()
      .from(traktCollectionStats)
      .where(eq(traktCollectionStats.userId, 1));

    if (!stats) {
      return c.json({
        data: {
          total_items: 0,
          by_format: {},
          by_resolution: {},
          by_hdr: {},
          by_genre: {},
          by_decade: {},
          added_this_year: 0,
        },
      });
    }

    setCache(c, 'long');
    return c.json({
      data: {
        total_items: stats.totalItems,
        by_format: stats.byFormat ? JSON.parse(stats.byFormat) : {},
        by_resolution: stats.byResolution ? JSON.parse(stats.byResolution) : {},
        by_hdr: stats.byHdr ? JSON.parse(stats.byHdr) : {},
        by_genre: stats.byGenre ? JSON.parse(stats.byGenre) : {},
        by_decade: stats.byDecade ? JSON.parse(stats.byDecade) : {},
        added_this_year: stats.addedThisYear,
      },
    });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/media/stats: ${err}`);
    return serverError(c) as any;
  }
});

// GET /collecting/media/recent
collecting.openapi(mediaRecentRoute, async (c) => {
  try {
    const limit = Math.min(
      20,
      Math.max(1, parseInt(c.req.query('limit') || '5', 10))
    );
    const db = createDb(c.env.DB);

    const dateCondition = buildDateCondition(traktCollection.collectedAt, {
      date: c.req.query('date'),
      from: c.req.query('from'),
      to: c.req.query('to'),
    });

    const rows = await db
      .select({
        id: traktCollection.id,
        movieId: traktCollection.movieId,
        mediaType: traktCollection.mediaType,
        resolution: traktCollection.resolution,
        hdr: traktCollection.hdr,
        audio: traktCollection.audio,
        audioChannels: traktCollection.audioChannels,
        collectedAt: traktCollection.collectedAt,
        title: movies.title,
        year: movies.year,
        tmdbId: movies.tmdbId,
        posterPath: movies.posterPath,
        tmdbRating: movies.tmdbRating,
      })
      .from(traktCollection)
      .innerJoin(movies, eq(traktCollection.movieId, movies.id))
      .where(and(eq(traktCollection.userId, 1), dateCondition))
      .orderBy(desc(traktCollection.collectedAt))
      .limit(limit);

    const movieIds = rows.map((r) => String(r.movieId));
    const imageMap = await getImageAttachmentBatch(
      db,
      'watching',
      'movies',
      movieIds
    );

    const data = rows.map((row) => ({
      id: row.id,
      title: row.title,
      year: row.year,
      tmdb_id: row.tmdbId,
      image: imageMap.get(String(row.movieId)) ?? null,
      tmdb_rating: row.tmdbRating,
      media_type: row.mediaType,
      resolution: row.resolution,
      hdr: row.hdr,
      audio: row.audio,
      audio_channels: row.audioChannels,
      collected_at: row.collectedAt,
    }));

    setCache(c, 'medium');
    return c.json({ data });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/media/recent: ${err}`);
    return serverError(c) as any;
  }
});

// GET /collecting/media/formats
collecting.openapi(mediaFormatsRoute, async (c) => {
  try {
    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        mediaType: traktCollection.mediaType,
        count: sql<number>`count(*)`,
      })
      .from(traktCollection)
      .where(eq(traktCollection.userId, 1))
      .groupBy(traktCollection.mediaType)
      .orderBy(sql`count(*) desc`);

    const data = rows.map((row) => ({
      name: row.mediaType,
      count: row.count,
    }));

    setCache(c, 'long');
    return c.json({ data });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/media/formats: ${err}`);
    return serverError(c) as any;
  }
});

// GET /collecting/media/cross-reference
collecting.openapi(mediaCrossRefRoute, async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(c.req.query('limit') || '20', 10))
    );
    const filter = c.req.query('filter') || 'all';

    const db = createDb(c.env.DB);
    const offset = (page - 1) * limit;

    // Base query: trakt_collection joined with movies and optional watch_history
    const baseConditions = [eq(traktCollection.userId, 1)];

    if (filter === 'watched') {
      baseConditions.push(
        sql`EXISTS (
            SELECT 1 FROM watch_history wh
            WHERE wh.movie_id = ${traktCollection.movieId}
          )`
      );
    } else if (filter === 'unwatched') {
      baseConditions.push(
        sql`NOT EXISTS (
            SELECT 1 FROM watch_history wh
            WHERE wh.movie_id = ${traktCollection.movieId}
          )`
      );
    }

    const whereClause = and(...baseConditions);

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(traktCollection)
      .innerJoin(movies, eq(traktCollection.movieId, movies.id))
      .where(whereClause);

    const rows = await db
      .select({
        id: traktCollection.id,
        movieId: traktCollection.movieId,
        mediaType: traktCollection.mediaType,
        resolution: traktCollection.resolution,
        collectedAt: traktCollection.collectedAt,
        title: movies.title,
        year: movies.year,
        tmdbId: movies.tmdbId,
        posterPath: movies.posterPath,
      })
      .from(traktCollection)
      .innerJoin(movies, eq(traktCollection.movieId, movies.id))
      .where(whereClause)
      .orderBy(desc(traktCollection.collectedAt))
      .limit(limit)
      .offset(offset);

    // Get watch counts for each movie
    const movieIds = rows.map((r) => r.movieId);
    const watchCounts = new Map<
      number,
      { count: number; lastWatched: string | null }
    >();

    if (movieIds.length > 0) {
      const watchRows = await db
        .select({
          movieId: watchHistory.movieId,
          count: sql<number>`count(*)`,
          lastWatched: sql<string | null>`max(${watchHistory.watchedAt})`,
        })
        .from(watchHistory)
        .where(inArray(watchHistory.movieId, movieIds))
        .groupBy(watchHistory.movieId);

      for (const wr of watchRows) {
        watchCounts.set(wr.movieId, {
          count: wr.count,
          lastWatched: wr.lastWatched,
        });
      }
    }

    const data = rows.map((row) => {
      const watch = watchCounts.get(row.movieId);
      return {
        collection: {
          id: row.id,
          title: row.title,
          year: row.year,
          tmdb_id: row.tmdbId,
          image: null as null,
          media_type: row.mediaType,
          resolution: row.resolution,
          collected_at: row.collectedAt,
        },
        watching: {
          watched: !!watch,
          watch_count: watch?.count || 0,
          last_watched: watch?.lastWatched || null,
        },
      };
    });

    // Summary
    const [{ totalOwned }] = await db
      .select({ totalOwned: sql<number>`count(*)` })
      .from(traktCollection)
      .where(eq(traktCollection.userId, 1));

    const [{ totalWatched }] = await db
      .select({
        totalWatched: sql<number>`count(distinct ${traktCollection.movieId})`,
      })
      .from(traktCollection)
      .innerJoin(
        watchHistory,
        eq(traktCollection.movieId, watchHistory.movieId)
      )
      .where(eq(traktCollection.userId, 1));

    setCache(c, 'long');
    return c.json({
      data,
      summary: {
        total_owned: totalOwned,
        total_watched: totalWatched,
        total_unwatched: totalOwned - totalWatched,
        watch_rate: totalOwned > 0 ? totalWatched / totalOwned : 0,
      },
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/media/cross-reference: ${err}`);
    return serverError(c) as any;
  }
});

// GET /collecting/media/:id
collecting.openapi(mediaDetailRoute, async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return badRequest(c, 'Invalid media item ID') as any;
    }

    const db = createDb(c.env.DB);

    const [row] = await db
      .select({
        id: traktCollection.id,
        movieId: traktCollection.movieId,
        traktId: traktCollection.traktId,
        mediaType: traktCollection.mediaType,
        resolution: traktCollection.resolution,
        hdr: traktCollection.hdr,
        audio: traktCollection.audio,
        audioChannels: traktCollection.audioChannels,
        collectedAt: traktCollection.collectedAt,
        title: movies.title,
        year: movies.year,
        tmdbId: movies.tmdbId,
        imdbId: movies.imdbId,
        tagline: movies.tagline,
        summary: movies.summary,
        posterPath: movies.posterPath,
        backdropPath: movies.backdropPath,
        runtime: movies.runtime,
        tmdbRating: movies.tmdbRating,
        contentRating: movies.contentRating,
      })
      .from(traktCollection)
      .innerJoin(movies, eq(traktCollection.movieId, movies.id))
      .where(and(eq(traktCollection.id, id), eq(traktCollection.userId, 1)));

    if (!row) {
      return notFound(c, 'Media item not found') as any;
    }

    // Get watch history for this movie
    const watchRows = await db
      .select({
        watchedAt: watchHistory.watchedAt,
        source: watchHistory.source,
        userRating: watchHistory.userRating,
      })
      .from(watchHistory)
      .where(eq(watchHistory.movieId, row.movieId))
      .orderBy(desc(watchHistory.watchedAt));

    const image = row.movieId
      ? await getImageAttachment(db, 'watching', 'movies', String(row.movieId))
      : null;

    setCache(c, 'long');
    return c.json({
      id: row.id,
      title: row.title,
      year: row.year,
      tmdb_id: row.tmdbId,
      imdb_id: row.imdbId,
      tagline: row.tagline,
      summary: row.summary,
      image,
      runtime: row.runtime,
      tmdb_rating: row.tmdbRating,
      content_rating: row.contentRating,
      media_type: row.mediaType,
      resolution: row.resolution,
      hdr: row.hdr,
      audio: row.audio,
      audio_channels: row.audioChannels,
      collected_at: row.collectedAt,
      watch_history: watchRows.map((w) => ({
        watched_at: w.watchedAt,
        source: w.source,
        user_rating: w.userRating,
      })),
    });
  } catch (err) {
    console.log(`[ERROR] GET /collecting/media/:id: ${err}`);
    return serverError(c) as any;
  }
});

// POST /admin/collecting/media
collecting.openapi(addMediaRoute, async (c) => {
  try {
    const body = await c.req.json<{
      tmdb_id?: number;
      imdb_id?: string;
      title?: string;
      year?: number;
      media_type: string;
      resolution?: string;
      hdr?: string;
      audio?: string;
      audio_channels?: string;
    }>();

    if (!body.media_type) {
      return badRequest(c, 'media_type is required') as any;
    }

    const db = createDb(c.env.DB);
    const tmdbClient = new TmdbClient(c.env.TMDB_API_KEY);

    // Resolve TMDb ID
    let tmdbId: number | null = body.tmdb_id || null;

    if (!tmdbId && body.imdb_id) {
      tmdbId = await tmdbClient.findByImdbId(body.imdb_id);
    }

    if (!tmdbId && body.title) {
      const results = await tmdbClient.searchMovie(body.title, body.year);
      if (results.length === 0) {
        return notFound(c, `No movie found for "${body.title}"`) as any;
      }
      if (results.length > 1 && !body.year) {
        return c.json(
          {
            status: 'ambiguous',
            message: 'Multiple results found. Specify year or tmdb_id.',
            candidates: results.slice(0, 5).map((r) => ({
              tmdb_id: r.id,
              title: r.title,
              release_date: r.release_date,
            })),
          },
          422
        ) as any;
      }
      tmdbId = results[0].id;
    }

    if (!tmdbId) {
      return badRequest(
        c,
        'Provide tmdb_id, imdb_id, or title to identify the movie'
      ) as any;
    }

    // Get movie detail from TMDb
    const detail = await tmdbClient.getMovieDetail(tmdbId);

    // Ensure movie exists locally
    const [existing] = await db
      .select({ id: movies.id })
      .from(movies)
      .where(eq(movies.tmdbId, tmdbId))
      .limit(1);

    let movieId: number;
    if (existing) {
      movieId = existing.id;
    } else {
      const [inserted] = await db
        .insert(movies)
        .values({
          title: detail.title,
          year: detail.year,
          tmdbId,
          imdbId: detail.imdb_id,
          tagline: detail.tagline,
          summary: detail.overview,
          runtime: detail.runtime,
          tmdbRating: detail.vote_average,
          posterPath: detail.poster_path,
          backdropPath: detail.backdrop_path,
          contentRating: detail.content_rating,
        })
        .returning({ id: movies.id });
      movieId = inserted.id;
    }

    // Push to Trakt
    const accessToken = await getAccessToken(c.env, db);
    const traktClient = new TraktClient(accessToken, c.env.TRAKT_CLIENT_ID);

    // Map local uhd_bluray to Trakt's bluray + uhd_4k resolution
    const traktMediaType =
      body.media_type === 'uhd_bluray' ? 'bluray' : body.media_type;
    const traktResolution =
      body.media_type === 'uhd_bluray'
        ? body.resolution || 'uhd_4k'
        : body.resolution;

    const traktResult = await traktClient.addToCollection([
      {
        ids: { tmdb: tmdbId },
        media_type: traktMediaType,
        resolution: traktResolution,
        hdr: body.hdr,
        audio: body.audio,
        audio_channels: body.audio_channels,
      },
    ]);

    // Sync back from Trakt to get the trakt_id
    // (The add response doesn't return the trakt ID directly)
    const collection = await traktClient.getCollection();
    const traktItem = collection.find((item) => item.movie.ids.tmdb === tmdbId);

    const traktId = traktItem?.movie.ids.trakt || 0;

    // Store locally
    await db
      .insert(traktCollection)
      .values({
        movieId,
        traktId,
        mediaType:
          body.media_type as typeof traktCollection.$inferInsert.mediaType,
        resolution: (body.resolution ||
          null) as typeof traktCollection.$inferInsert.resolution,
        hdr: (body.hdr || null) as typeof traktCollection.$inferInsert.hdr,
        audio: (body.audio ||
          null) as typeof traktCollection.$inferInsert.audio,
        audioChannels: (body.audio_channels ||
          null) as typeof traktCollection.$inferInsert.audioChannels,
        collectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [
          traktCollection.userId,
          traktCollection.traktId,
          traktCollection.mediaType,
        ],
        set: {
          resolution: sql`excluded.resolution`,
          hdr: sql`excluded.hdr`,
          audio: sql`excluded.audio`,
          audioChannels: sql`excluded.audio_channels`,
          updatedAt: sql`excluded.updated_at`,
        },
      });

    // Process image inline (poster via TMDb)
    let imageProcessed = false;
    try {
      const imageParams: SourceSearchParams = {
        domain: 'watching',
        entityType: 'movies',
        entityId: String(movieId),
        tmdbId: String(tmdbId),
      };
      const imageResult = await runPipeline(db, c.env, imageParams);
      imageProcessed = !!imageResult;
    } catch (imgErr) {
      console.log(
        `[ERROR] Image pipeline failed for movie ${tmdbId}: ${imgErr instanceof Error ? imgErr.message : String(imgErr)}`
      );
    }

    return c.json({
      status: 'ok',
      movie: {
        title: detail.title,
        year: detail.year,
        tmdb_id: tmdbId,
      },
      media_type: body.media_type,
      trakt: {
        added: traktResult.added.movies,
        existing: traktResult.existing.movies,
      },
      image_processed: imageProcessed,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] POST /admin/collecting/media: ${errorMsg}`);
    return serverError(c, `Failed to add media: ${errorMsg}`) as any;
  }
});

// POST /admin/collecting/media/:id/remove

collecting.openapi(removeMediaRoute, async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return badRequest(c, 'Invalid media item ID') as any;
    }

    const db = createDb(c.env.DB);

    const [item] = await db
      .select({
        id: traktCollection.id,
        traktId: traktCollection.traktId,
        mediaType: traktCollection.mediaType,
        tmdbId: movies.tmdbId,
        title: movies.title,
      })
      .from(traktCollection)
      .innerJoin(movies, eq(traktCollection.movieId, movies.id))
      .where(and(eq(traktCollection.id, id), eq(traktCollection.userId, 1)));

    if (!item) {
      return notFound(c, 'Media item not found') as any;
    }

    // Remove from Trakt
    const accessToken = await getAccessToken(c.env, db);
    const traktClient = new TraktClient(accessToken, c.env.TRAKT_CLIENT_ID);

    await traktClient.removeFromCollection([
      {
        ids: { tmdb: item.tmdbId || undefined, trakt: item.traktId },
        media_type: item.mediaType,
      },
    ]);

    // Remove locally
    await db.delete(traktCollection).where(eq(traktCollection.id, id));

    return c.json({
      status: 'ok',
      message: `Removed "${item.title}" (${item.mediaType}) from collection`,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] POST /admin/collecting/media/:id/remove: ${errorMsg}`);
    return serverError(c, `Failed to remove media: ${errorMsg}`) as any;
  }
});

// POST /admin/sync/trakt
collecting.openapi(syncTraktRoute, async (c) => {
  try {
    await syncTraktCollection(c.env);
    return c.json({ status: 'ok', message: 'Trakt collection sync complete' });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] POST /admin/sync/trakt: ${errorMsg}`);
    return serverError(c, `Trakt sync failed: ${errorMsg}`) as any;
  }
});

// POST /admin/collecting/media/backfill-images
collecting.openapi(mediaBackfillImagesRoute, async (c) => {
  try {
    const db = createDb(c.env.DB);
    const body = await c.req
      .json<{ limit?: number }>()
      .catch(() => ({ limit: undefined }));
    const maxItems = Math.min(body.limit || 50, 200);

    // Get movies in Trakt collection without images
    const rows = await db
      .select({
        tmdbId: movies.tmdbId,
        title: movies.title,
      })
      .from(traktCollection)
      .innerJoin(movies, eq(traktCollection.movieId, movies.id))
      .where(
        and(
          eq(traktCollection.userId, 1),
          sql`CAST(${movies.tmdbId} AS TEXT) NOT IN (
              SELECT ${images.entityId} FROM ${images}
              WHERE ${images.domain} = 'watching' AND ${images.entityType} = 'movies'
            )`
        )
      )
      .limit(maxItems);

    const items: BackfillItem[] = rows
      .filter((r) => r.tmdbId !== null)
      .map((row) => ({
        entityId: String(row.tmdbId),
        albumName: row.title,
      }));

    const result = await backfillImages(
      db,
      c.env,
      'watching',
      'movies',
      items,
      { batchSize: 5, delayMs: 500 }
    );

    return c.json({ success: true, results: result });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(
      `[ERROR] POST /admin/collecting/media/backfill-images: ${errorMsg}`
    );
    return serverError(c, `Backfill failed: ${errorMsg}`) as any;
  }
});

export default collecting;
