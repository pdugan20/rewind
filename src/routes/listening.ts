import { createRoute, z } from '@hono/zod-openapi';
import { eq, and, desc, sql, gte, lte, like, asc, inArray } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import {
  lastfmArtists,
  lastfmAlbums,
  lastfmTracks,
  lastfmScrobbles,
  lastfmTopArtists,
  lastfmTopAlbums,
  lastfmTopTracks,
  lastfmUserStats,
  lastfmFilters,
  lastfmMonthlyStats,
  lastfmYearlyStats,
} from '../db/schema/lastfm.js';
import { setCache } from '../lib/cache.js';
import { requireAuth } from '../lib/auth.js';
import { DateFilterQuery, buildDateCondition } from '../lib/date-filters.js';
import { notFound, badRequest, serverError } from '../lib/errors.js';
import { getImageAttachment, getImageAttachmentBatch } from '../lib/images.js';
import { images } from '../db/schema/system.js';
import { LastfmClient } from '../services/lastfm/client.js';
import type { LastfmPeriod } from '../services/lastfm/client.js';
import { loadFilters, isFiltered } from '../services/lastfm/filters.js';
import {
  enrichArtistBio,
  type SimilarArtistEntry,
} from '../services/lastfm/enrichment.js';
import { backfillImages } from '../services/images/backfill.js';
import { enrichBatch, enrichArtistsByName } from '../services/itunes/enrich.js';
import { refreshArtistImageFromAppleMusicId } from '../services/images/sync-images.js';
import type { BackfillItem } from '../services/images/backfill.js';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses, PaginationMeta } from '../lib/schemas/common.js';
import {
  buildSparklinesForWindow,
  isSparklinePeriod,
  overallToWindow,
  periodToWindow,
  yearMonthToWindow,
  yearToWindow,
  type SparklinePeriod,
} from '../lib/listening-sparklines.js';

const listening = createOpenAPIApp();

const VALID_PERIODS: LastfmPeriod[] = [
  '7day',
  '1month',
  '3month',
  '6month',
  '12month',
  'overall',
];

function paginate(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    total_pages: Math.ceil(total / limit),
  };
}

// ─── Schemas ────────────────────────────────────────────────────────

const PeriodQuery = z.object({
  period: z
    .enum(['7day', '1month', '3month', '6month', '12month', 'overall'])
    .optional()
    .default('7day')
    .openapi({ example: '7day' }),
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
    .default(10)
    .openapi({ example: 10 }),
});

const TopItemSchema = z.object({
  rank: z.number(),
  id: z.number(),
  name: z.string(),
  detail: z.string(),
  playcount: z.number(),
  image: z.any().nullable(),
  url: z.string(),
  apple_music_url: z.string().nullable(),
  preview_url: z.string().nullable().optional(),
});

const SparklineSchema = z.object({
  granularity: z.enum(['day', 'week', 'month', 'year']),
  points: z.array(z.number()),
});

// Variant used by the artist detail endpoint — points carry their bucket
// timestamp inline so the artist card's SVG can label its x-axis with
// years/months without a separate "first/last bucket" derivation. List
// endpoints (top-artists, top-albums, top-tracks) keep the bare-number
// shape for backward compatibility.
const TimestampedSparklineSchema = z.object({
  granularity: z.enum(['day', 'week', 'month', 'year']),
  points: z.array(
    z.object({
      at: z.string(),
      count: z.number(),
    })
  ),
});

const TopArtistItemSchema = TopItemSchema.extend({
  sparkline: SparklineSchema.optional(),
});

const TopAlbumItemSchema = TopItemSchema.extend({
  sparkline: SparklineSchema.optional(),
});

const TopTrackItemSchema = TopItemSchema.extend({
  sparkline: SparklineSchema.optional(),
  album_id: z.number().nullable().optional(),
  album_name: z.string().nullable().optional(),
  album_apple_music_url: z.string().nullable().optional(),
  album_released_year: z.number().nullable().optional(),
  album_total_tracks: z.number().nullable().optional(),
});

const includeSparklinesField = z.coerce.boolean().optional().openapi({
  description:
    'When true, attach a `sparkline` object (granularity + zero-filled points) to each item. On rolling-period endpoints, supported for period in {1month, 3month, 6month, 12month, overall}. `overall` returns yearly buckets covering the artist/album/track lifetime; `7day` is unsupported and the field is omitted.',
  example: false,
});

const TopArtistsQuery = PeriodQuery.merge(DateFilterQuery).extend({
  include_sparklines: includeSparklinesField,
});

const TopAlbumsQuery = PeriodQuery.merge(DateFilterQuery).extend({
  include_sparklines: includeSparklinesField,
});

const TopTracksQuery = PeriodQuery.merge(DateFilterQuery).extend({
  include_sparklines: includeSparklinesField,
  // Optional artist filter — returns this user's top tracks BY a single
  // artist. Composes with `period` and the date filters. Either `artist_id`
  // (preferred — stable id from get_artist_details) or `artist_name`
  // (substring match against lastfm_artists.name) may be supplied; passing
  // both is a 400. Filter is enforced via lastfm_top_tracks → lastfm_tracks
  // join to lastfm_tracks.artist_id.
  artist_id: z.coerce.number().int().positive().optional().openapi({
    description:
      "Filter top tracks to a single artist's catalog. Stable id from `get_artist_details` or `get_top_artists`. Composes with `period` and date filters.",
    example: 189,
  }),
  artist_name: z.string().min(1).optional().openapi({
    description:
      'Substring match against `lastfm_artists.name`. Resolves to the highest-playcount artist. Use only when no `artist_id` is available; passing both is a 400.',
    example: 'olivia rodrigo',
  }),
});

const NowPlayingSchema = z.object({
  is_playing: z.boolean(),
  track: z.any().nullable(),
  scrobbled_at: z.string().nullable(),
});

const ScrobbleSchema = z.object({
  track: z.object({
    id: z.number(),
    name: z.string(),
    url: z.string().nullable(),
    apple_music_url: z.string().nullable(),
    preview_url: z.string().nullable(),
  }),
  artist: z.object({ id: z.number(), name: z.string() }),
  album: z.object({
    id: z.number().nullable(),
    name: z.string().nullable(),
    image: z.any().nullable(),
  }),
  scrobbled_at: z.string(),
});

const StatsSchema = z.object({
  total_scrobbles: z.number(),
  unique_artists: z.number(),
  unique_albums: z.number(),
  unique_tracks: z.number(),
  registered_date: z.string().nullable(),
  years_tracking: z.number(),
  scrobbles_per_day: z.number(),
});

const CalendarDaySchema = z.object({
  date: z.string(),
  count: z.number(),
});

const CalendarSchema = z.object({
  year: z.number(),
  days: z.array(CalendarDaySchema),
  total: z.number(),
  max_day: CalendarDaySchema,
});

const TrendPointSchema = z.object({
  period: z.string(),
  value: z.number(),
});

const TrendsSchema = z.object({
  metric: z.string(),
  data: z.array(TrendPointSchema),
});

const StreaksSchema = z.object({
  current: z.object({
    days: z.number(),
    start_date: z.string().nullable(),
    total_scrobbles: z.number(),
  }),
  longest: z.object({
    days: z.number(),
    start_date: z.string().nullable(),
    end_date: z.string().nullable(),
    total_scrobbles: z.number(),
  }),
});

const ArtistBrowseSchema = z.object({
  id: z.number(),
  name: z.string(),
  playcount: z.number().nullable(),
  genre: z.string().nullable(),
  url: z.string(),
  apple_music_url: z.string().nullable(),
  image: z.any().nullable(),
});

const AlbumBrowseSchema = z.object({
  id: z.number(),
  name: z.string(),
  artist: z.object({ id: z.number(), name: z.string() }),
  playcount: z.number().nullable(),
  url: z.string(),
  apple_music_url: z.string().nullable(),
  image: z.any().nullable(),
});

const NormalizedTagSchema = z.object({
  name: z.string().openapi({ example: 'Rock' }),
  count: z.number().openapi({ example: 100 }),
});

const SimilarArtistSchema = z.object({
  id: z.number(),
  name: z.string(),
  genre: z.string().nullable(),
  your_scrobble_count: z.number(),
  similarity_score: z.number(),
  image: z.any().nullable(),
});

const ArtistDetailSchema = z.object({
  id: z.number(),
  name: z.string(),
  mbid: z.string().nullable(),
  url: z.string().nullable(),
  apple_music_url: z.string().nullable(),
  playcount: z.number(),
  scrobble_count: z.number(),
  first_scrobbled_at: z.string().nullable(),
  last_played_at: z.string().nullable(),
  all_time_rank: z.number().nullable(),
  distinct_tracks: z.number(),
  distinct_albums: z.number(),
  genre: z.string().nullable(),
  tags: z.array(NormalizedTagSchema).nullable(),
  bio_summary: z.string().nullable(),
  bio_content: z.string().nullable(),
  bio_synced_at: z.string().nullable(),
  image: z.any().nullable(),
  sparkline: TimestampedSparklineSchema.nullable(),
  top_albums: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      playcount: z.number(),
      apple_music_url: z.string().nullable(),
      image: z.any().nullable(),
    })
  ),
  top_tracks: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      album_id: z.number().nullable(),
      album_name: z.string().nullable(),
      scrobble_count: z.number(),
      apple_music_url: z.string().nullable(),
      preview_url: z.string().nullable(),
      image: z.any().nullable(),
    })
  ),
  similar_artists: z.array(SimilarArtistSchema),
});

const AlbumDetailSchema = z.object({
  id: z.number(),
  name: z.string(),
  mbid: z.string().nullable(),
  url: z.string().nullable(),
  apple_music_url: z.string().nullable(),
  playcount: z.number(),
  image: z.any().nullable(),
  artist: z.object({ id: z.number(), name: z.string() }),
  tracks: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      scrobble_count: z.number(),
      apple_music_url: z.string().nullable(),
      preview_url: z.string().nullable(),
    })
  ),
});

const FilterSchema = z.object({
  id: z.number(),
  filter_type: z.string(),
  pattern: z.string(),
  scope: z.string().nullable(),
  reason: z.string().nullable(),
  created_at: z.string(),
});

const YearSchema = z.object({
  year: z.number(),
  month: z.number().optional(),
  total_scrobbles: z.number(),
  unique_artists: z.number(),
  unique_albums: z.number(),
  unique_tracks: z.number(),
  top_artists: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      scrobbles: z.number(),
      apple_music_url: z.string().nullable(),
      image: z.any().nullable(),
      sparkline: SparklineSchema.optional(),
    })
  ),
  top_albums: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      artist: z.string(),
      scrobbles: z.number(),
      apple_music_url: z.string().nullable(),
      image: z.any().nullable(),
      sparkline: SparklineSchema.optional(),
    })
  ),
  top_tracks: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      artist: z.string(),
      scrobbles: z.number(),
      apple_music_url: z.string().nullable(),
      preview_url: z.string().nullable(),
      sparkline: SparklineSchema.optional(),
    })
  ),
  monthly: z.array(
    z.object({
      month: z.string(),
      scrobbles: z.number(),
      unique_artists: z.number(),
      unique_albums: z.number(),
    })
  ),
});

const IdParamSchema = z.object({
  id: z.string().openapi({ example: '42' }),
});

const YearParamSchema = z.object({
  year: z.string().openapi({ example: '2024' }),
});

// ─── Routes ─────────────────────────────────────────────────────────

const nowPlayingRoute = createRoute({
  method: 'get',
  path: '/now-playing',
  operationId: 'getListeningNowPlaying',
  tags: ['Listening'],
  summary: 'Now playing',
  description:
    'Returns the currently playing or most recently scrobbled track from Last.fm.',
  responses: {
    200: {
      description: 'Now playing info',
      content: {
        'application/json': {
          schema: NowPlayingSchema,
          example: {
            is_playing: true,
            track: {
              name: 'Espresso',
              artist: {
                id: 471,
                name: 'Sabrina Carpenter',
                apple_music_url:
                  'https://music.apple.com/us/artist/sabrina-carpenter/595947033?uo=4',
              },
              album: {
                id: 254,
                name: "Short n' Sweet",
                image: {
                  url: 'https://cdn.rewind.rest/listening/albums/254/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
                  thumbhash: 'HBkKHQi694WIeIiAh3Z3d2eAd4B3',
                  dominant_color: '#5c4a6d',
                  accent_color: '#c4a8d4',
                },
              },
              url: 'https://www.last.fm/music/Sabrina+Carpenter/_/Espresso',
              apple_music_url:
                'https://music.apple.com/us/album/espresso/1745069032?i=1745069234&uo=4',
              preview_url: null,
            },
            scrobbled_at: '2026-03-18T22:30:00.000Z',
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const recentRoute = createRoute({
  method: 'get',
  path: '/recent',
  operationId: 'getListeningRecent',
  tags: ['Listening'],
  summary: 'Recent scrobbles',
  description:
    'Returns the most recent scrobbles. Supports date filtering via date, from, and to params and page-based pagination.',
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
        page: z.coerce
          .number()
          .int()
          .min(1)
          .optional()
          .default(1)
          .openapi({ example: 1 }),
      })
      .merge(DateFilterQuery),
  },
  responses: {
    200: {
      description: 'Recent scrobbles',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(ScrobbleSchema) }),
          example: {
            data: [
              {
                track: {
                  id: 1001,
                  name: 'bad idea right?',
                  url: 'https://www.last.fm/music/Olivia+Rodrigo/_/bad+idea+right%3F',
                  apple_music_url: null,
                  preview_url: null,
                },
                artist: { id: 37, name: 'Olivia Rodrigo' },
                album: {
                  id: 20,
                  name: 'GUTS',
                  image: {
                    url: 'https://cdn.rewind.rest/listening/albums/20/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
                    thumbhash: 'HBkKHQi694WIeIiAh3Z3d2eAd4B3',
                    dominant_color: '#5c4a6d',
                    accent_color: '#c4a8d4',
                  },
                },
                scrobbled_at: '2026-03-18T22:14:04.000Z',
              },
              {
                track: {
                  id: 1002,
                  name: 'Sabotage',
                  url: 'https://www.last.fm/music/Beastie+Boys/_/Sabotage',
                  apple_music_url: null,
                  preview_url: null,
                },
                artist: { id: 130, name: 'Beastie Boys' },
                album: { id: 500, name: 'Ill Communication', image: null },
                scrobbled_at: '2026-03-18T22:10:00.000Z',
              },
              {
                track: {
                  id: 1003,
                  name: 'Come as You Are',
                  url: 'https://www.last.fm/music/Nirvana/_/Come+as+You+Are',
                  apple_music_url:
                    'https://music.apple.com/us/album/come-as-you-are/1440783617?i=1440783636&uo=4',
                  preview_url: null,
                },
                artist: { id: 189, name: 'Nirvana' },
                album: { id: 300, name: 'Nevermind', image: null },
                scrobbled_at: '2026-03-18T22:05:00.000Z',
              },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const topArtistsRoute = createRoute({
  method: 'get',
  path: '/top/artists',
  operationId: 'getListeningTopArtists',
  tags: ['Listening'],
  summary: 'Top artists',
  description: 'Returns your top artists for a given time period.',
  request: { query: TopArtistsQuery },
  responses: {
    200: {
      description: 'Top artists list',
      content: {
        'application/json': {
          schema: z.object({
            period: z.string(),
            data: z.array(TopArtistItemSchema),
            pagination: PaginationMeta,
          }),
          example: {
            period: '12month',
            data: [
              {
                rank: 1,
                id: 130,
                name: 'Beastie Boys',
                detail: '',
                playcount: 4011,
                genre: 'Hip-Hop',
                image: {
                  url: 'https://cdn.rewind.rest/listening/artists/130/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
                  thumbhash: 'GggGBwDN+CSBp7VXcmVmlyZ2BgAAAAAA',
                  dominant_color: '#191919',
                  accent_color: '#7e7e7e',
                },
                url: 'https://www.last.fm/music/Beastie+Boys',
                apple_music_url: null,
                sparkline: {
                  granularity: 'week',
                  points: [
                    3, 5, 12, 8, 4, 0, 0, 6, 9, 11, 14, 7, 5, 8, 12, 18, 22, 19,
                    11, 6, 4, 8, 13, 17, 21, 16, 9, 5, 3, 7, 12, 18, 24, 19, 14,
                    8, 5, 9, 13, 17, 22, 28, 25, 18, 12, 7, 4, 9, 14, 19, 23,
                    26,
                  ],
                },
              },
              {
                rank: 2,
                id: 189,
                name: 'Nirvana',
                detail: '',
                playcount: 2179,
                genre: 'Grunge',
                image: null,
                url: 'https://www.last.fm/music/Nirvana',
                apple_music_url:
                  'https://music.apple.com/us/artist/nirvana/112018?uo=4',
              },
              {
                rank: 3,
                id: 92,
                name: 'Taylor Swift',
                detail: '',
                playcount: 2164,
                genre: 'Country',
                image: null,
                url: 'https://www.last.fm/music/Taylor+Swift',
                apple_music_url:
                  'https://music.apple.com/us/artist/taylor-swift/159260351?uo=4',
              },
            ],
            pagination: { page: 1, limit: 20, total: 29, total_pages: 2 },
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

const topAlbumsRoute = createRoute({
  method: 'get',
  path: '/top/albums',
  operationId: 'getListeningTopAlbums',
  tags: ['Listening'],
  summary: 'Top albums',
  description:
    'Returns top albums for a given time period. Pass `include_sparklines=true` to attach a play-count time series per album (1month/3month/6month/12month/overall).',
  request: { query: TopAlbumsQuery },
  responses: {
    200: {
      description: 'Top albums list',
      content: {
        'application/json': {
          schema: z.object({
            period: z.string(),
            data: z.array(TopAlbumItemSchema),
            pagination: PaginationMeta,
          }),
          example: {
            period: 'overall',
            data: [
              {
                rank: 1,
                id: 300,
                name: 'MTV Unplugged in New York',
                detail: 'Nirvana',
                playcount: 428,
                image: {
                  url: 'https://cdn.rewind.rest/listening/albums/300/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
                  thumbhash: 'HBkKHQi694WIeIiAh3Z3d2eAd4B3',
                  dominant_color: '#5c4a6d',
                  accent_color: '#c4a8d4',
                },
                url: 'https://www.last.fm/music/Nirvana/MTV+Unplugged+in+New+York',
                apple_music_url: null,
              },
              {
                rank: 2,
                id: 500,
                name: 'Hot Sauce Committee Part Two',
                detail: 'Beastie Boys',
                playcount: 534,
                image: null,
                url: 'https://www.last.fm/music/Beastie+Boys/Hot+Sauce+Committee+Part+Two',
                apple_music_url: null,
              },
              {
                rank: 3,
                id: 20,
                name: 'GUTS',
                detail: 'Olivia Rodrigo',
                playcount: 32,
                image: null,
                url: 'https://www.last.fm/music/Olivia+Rodrigo/GUTS',
                apple_music_url: null,
              },
            ],
            pagination: { page: 1, limit: 20, total: 29, total_pages: 2 },
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

const topTracksRoute = createRoute({
  method: 'get',
  path: '/top/tracks',
  operationId: 'getListeningTopTracks',
  tags: ['Listening'],
  summary: 'Top tracks',
  description:
    'Returns your top tracks for a given time period, optionally scoped to a single artist.',
  request: { query: TopTracksQuery },
  responses: {
    200: {
      description: 'Top tracks list',
      content: {
        'application/json': {
          schema: z.object({
            period: z.string(),
            artist_id: z.number().nullable().optional(),
            data: z.array(TopTrackItemSchema),
            pagination: PaginationMeta,
          }),
          example: {
            period: 'overall',
            artist_id: null,
            data: [
              {
                rank: 1,
                id: 595,
                name: 'Come as You Are',
                detail: 'Nirvana',
                playcount: 101,
                image: null,
                url: 'https://www.last.fm/music/Nirvana/_/Come+as+You+Are',
                apple_music_url:
                  'https://music.apple.com/us/album/come-as-you-are/1440783617?i=1440783636&uo=4',
                preview_url: null,
              },
              {
                rank: 2,
                id: 1050,
                name: 'bad idea right?',
                detail: 'Olivia Rodrigo',
                playcount: 82,
                image: null,
                url: 'https://www.last.fm/music/Olivia+Rodrigo/_/bad+idea+right%3F',
                apple_music_url: null,
                preview_url: null,
              },
              {
                rank: 3,
                id: 2001,
                name: 'Espresso',
                detail: 'Sabrina Carpenter',
                playcount: 68,
                image: null,
                url: 'https://www.last.fm/music/Sabrina+Carpenter/_/Espresso',
                apple_music_url: null,
                preview_url: null,
              },
            ],
            pagination: { page: 1, limit: 20, total: 13, total_pages: 1 },
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

const statsRoute = createRoute({
  method: 'get',
  path: '/stats',
  operationId: 'getListeningStats',
  tags: ['Listening'],
  summary: 'Listening stats',
  description:
    'Returns listening statistics. Supports optional date filtering to scope stats to a time period.',
  request: {
    query: DateFilterQuery,
  },
  responses: {
    200: {
      description: 'Listening statistics',
      content: {
        'application/json': {
          schema: StatsSchema,
          example: {
            total_scrobbles: 123867,
            unique_artists: 5278,
            unique_albums: 11168,
            unique_tracks: 28405,
            registered_date: '2012-02-09T16:01:17.000Z',
            years_tracking: 14,
            scrobbles_per_day: 24,
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const historyRoute = createRoute({
  method: 'get',
  path: '/history',
  operationId: 'getListeningHistory',
  tags: ['Listening'],
  summary: 'Listening history',
  description: 'Returns paginated scrobble history with optional filters.',
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
        .max(200)
        .optional()
        .default(50)
        .openapi({ example: 50 }),
      from: z
        .string()
        .optional()
        .openapi({ example: '2024-01-01T00:00:00.000Z' }),
      to: z
        .string()
        .optional()
        .openapi({ example: '2024-12-31T23:59:59.999Z' }),
      artist: z.string().optional().openapi({ example: 'Radiohead' }),
      album: z.string().optional().openapi({ example: 'OK Computer' }),
    }),
  },
  responses: {
    200: {
      description: 'Scrobble history',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(ScrobbleSchema),
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                track: {
                  id: 1001,
                  name: 'bad idea right?',
                  url: 'https://www.last.fm/music/Olivia+Rodrigo/_/bad+idea+right%3F',
                  apple_music_url: null,
                  preview_url: null,
                },
                artist: { id: 37, name: 'Olivia Rodrigo' },
                album: {
                  id: 20,
                  name: 'GUTS',
                  image: {
                    url: 'https://cdn.rewind.rest/listening/albums/20/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
                    thumbhash: 'HBkKHQi694WIeIiAh3Z3d2eAd4B3',
                    dominant_color: '#5c4a6d',
                    accent_color: '#c4a8d4',
                  },
                },
                scrobbled_at: '2026-03-18T22:14:04.000Z',
              },
            ],
            pagination: {
              page: 1,
              limit: 50,
              total: 123867,
              total_pages: 2478,
            },
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const browseArtistsRoute = createRoute({
  method: 'get',
  path: '/artists',
  operationId: 'listListeningArtists',
  tags: ['Listening'],
  summary: 'Browse artists',
  description: 'Returns paginated list of all artists.',
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
      sort: z
        .enum(['playcount', 'name'])
        .optional()
        .default('playcount')
        .openapi({ example: 'playcount' }),
      order: z
        .enum(['asc', 'desc'])
        .optional()
        .default('desc')
        .openapi({ example: 'desc' }),
      search: z.string().optional().openapi({ example: 'Radiohead' }),
    }),
  },
  responses: {
    200: {
      description: 'Artist list',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(ArtistBrowseSchema),
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                id: 130,
                name: 'Beastie Boys',
                playcount: 4011,
                genre: 'Hip-Hop',
                url: 'https://www.last.fm/music/Beastie+Boys',
                apple_music_url: null,
                image: {
                  url: 'https://cdn.rewind.rest/listening/artists/130/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
                  thumbhash: 'GggGBwDN+CSBp7VXcmVmlyZ2BgAAAAAA',
                  dominant_color: '#191919',
                  accent_color: '#7e7e7e',
                },
              },
              {
                id: 189,
                name: 'Nirvana',
                playcount: 2179,
                genre: 'Grunge',
                url: 'https://www.last.fm/music/Nirvana',
                apple_music_url:
                  'https://music.apple.com/us/artist/nirvana/112018?uo=4',
                image: null,
              },
              {
                id: 92,
                name: 'Taylor Swift',
                playcount: 2164,
                genre: 'Country',
                url: 'https://www.last.fm/music/Taylor+Swift',
                apple_music_url:
                  'https://music.apple.com/us/artist/taylor-swift/159260351?uo=4',
                image: null,
              },
            ],
            pagination: { page: 1, limit: 20, total: 5278, total_pages: 264 },
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const browseAlbumsRoute = createRoute({
  method: 'get',
  path: '/albums',
  operationId: 'listListeningAlbums',
  tags: ['Listening'],
  summary: 'Browse albums',
  description: 'Returns paginated list of all albums.',
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
      sort: z
        .enum(['playcount', 'name', 'recent'])
        .optional()
        .default('playcount')
        .openapi({ example: 'playcount' }),
      order: z
        .enum(['asc', 'desc'])
        .optional()
        .default('desc')
        .openapi({ example: 'desc' }),
      artist: z.string().optional().openapi({ example: 'Radiohead' }),
      search: z.string().optional().openapi({ example: 'OK Computer' }),
    }),
  },
  responses: {
    200: {
      description: 'Album list',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(AlbumBrowseSchema),
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                id: 300,
                name: 'Nevermind',
                artist: { id: 189, name: 'Nirvana' },
                playcount: 333,
                url: 'https://www.last.fm/music/Nirvana/Nevermind',
                apple_music_url: null,
                image: null,
              },
              {
                id: 20,
                name: 'GUTS',
                artist: { id: 37, name: 'Olivia Rodrigo' },
                playcount: 32,
                url: 'https://www.last.fm/music/Olivia+Rodrigo/GUTS',
                apple_music_url: null,
                image: null,
              },
            ],
            pagination: { page: 1, limit: 20, total: 11168, total_pages: 559 },
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const artistDetailRoute = createRoute({
  method: 'get',
  path: '/artists/{id}',
  operationId: 'getListeningArtist',
  tags: ['Listening'],
  summary: 'Artist detail',
  description:
    'Returns detailed information about an artist including top albums and tracks.',
  request: { params: IdParamSchema },
  responses: {
    200: {
      description: 'Artist detail',
      content: {
        'application/json': {
          schema: ArtistDetailSchema,
          example: {
            id: 189,
            name: 'Nirvana',
            mbid: null,
            url: 'https://www.last.fm/music/Nirvana',
            apple_music_url:
              'https://music.apple.com/us/artist/nirvana/112018?uo=4',
            playcount: 2179,
            scrobble_count: 2193,
            first_scrobbled_at: '2012-05-02T18:32:15.000Z',
            last_played_at: '2026-04-12T20:11:00.000Z',
            all_time_rank: 12,
            distinct_tracks: 84,
            distinct_albums: 7,
            genre: 'Grunge',
            tags: [
              { name: 'Grunge', count: 100 },
              { name: 'Rock', count: 49 },
            ],
            bio_summary:
              'American rock band formed in Aberdeen, Washington in 1987.',
            bio_content: null,
            bio_synced_at: '2026-04-12T20:11:00.000Z',
            image: {
              url: 'https://cdn.rewind.rest/listening/artists/189/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
              thumbhash: 'GggGBwDN+CSBp7VXcmVmlyZ2BgAAAAAA',
              dominant_color: '#191919',
              accent_color: '#7e7e7e',
            },
            sparkline: {
              granularity: 'year',
              points: [
                { at: '2024-01-01T00:00:00.000Z', count: 80 },
                { at: '2025-01-01T00:00:00.000Z', count: 65 },
                { at: '2026-01-01T00:00:00.000Z', count: 22 },
              ],
            },
            top_albums: [
              {
                id: 300,
                name: 'MTV Unplugged in New York',
                playcount: 428,
                apple_music_url: null,
                image: null,
              },
            ],
            top_tracks: [
              {
                id: 595,
                name: 'Come as You Are',
                album_id: 300,
                album_name: 'MTV Unplugged in New York',
                scrobble_count: 101,
                apple_music_url:
                  'https://music.apple.com/us/album/come-as-you-are/1440783617?i=1440783636&uo=4',
                preview_url: null,
                image: null,
              },
            ],
            similar_artists: [
              {
                id: 244,
                name: 'Pearl Jam',
                genre: 'Grunge',
                your_scrobble_count: 612,
                similarity_score: 0.86,
                image: null,
              },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401, 404),
  },
});

const albumDetailRoute = createRoute({
  method: 'get',
  path: '/albums/{id}',
  operationId: 'getListeningAlbum',
  tags: ['Listening'],
  summary: 'Album detail',
  description: 'Returns detailed information about an album including tracks.',
  request: { params: IdParamSchema },
  responses: {
    200: {
      description: 'Album detail',
      content: {
        'application/json': {
          schema: AlbumDetailSchema,
          example: {
            id: 20,
            name: 'GUTS',
            mbid: null,
            artist: { id: 37, name: 'Olivia Rodrigo' },
            playcount: 32,
            url: 'https://www.last.fm/music/Olivia+Rodrigo/GUTS',
            apple_music_url: null,
            image: {
              url: 'https://cdn.rewind.rest/listening/albums/20/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
              thumbhash: 'HBkKHQi694WIeIiAh3Z3d2eAd4B3',
              dominant_color: '#5c4a6d',
              accent_color: '#c4a8d4',
            },
            tracks: [
              {
                id: 1001,
                name: 'bad idea right?',
                scrobble_count: 82,
                apple_music_url: null,
                preview_url: null,
              },
              {
                id: 1002,
                name: 'vampire',
                scrobble_count: 57,
                apple_music_url: null,
                preview_url: null,
              },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401, 404),
  },
});

const calendarRoute = createRoute({
  method: 'get',
  path: '/calendar',
  operationId: 'getListeningCalendar',
  tags: ['Listening'],
  summary: 'Listening calendar',
  description: 'Returns daily scrobble counts for a given year.',
  request: {
    query: z.object({
      year: z.coerce.number().int().optional().openapi({ example: 2024 }),
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
              { date: '2026-03-01', count: 15 },
              { date: '2026-03-02', count: 22 },
              { date: '2026-03-03', count: 8 },
            ],
            total: 45,
            max_day: { date: '2026-03-02', count: 22 },
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

const trendsRoute = createRoute({
  method: 'get',
  path: '/trends',
  operationId: 'getListeningTrends',
  tags: ['Listening'],
  summary: 'Listening trends',
  description: 'Returns monthly trend data for a given metric.',
  request: {
    query: z.object({
      metric: z
        .enum(['scrobbles', 'artists', 'albums', 'tracks'])
        .optional()
        .default('scrobbles')
        .openapi({ example: 'scrobbles' }),
      from: z
        .string()
        .optional()
        .openapi({ example: '2024-01-01T00:00:00.000Z' }),
      to: z
        .string()
        .optional()
        .openapi({ example: '2024-12-31T23:59:59.999Z' }),
    }),
  },
  responses: {
    200: {
      description: 'Trend data',
      content: {
        'application/json': {
          schema: TrendsSchema,
          example: {
            metric: 'scrobbles',
            data: [
              { period: '2026-01', value: 552 },
              { period: '2026-02', value: 501 },
              { period: '2026-03', value: 387 },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

const streaksRoute = createRoute({
  method: 'get',
  path: '/streaks',
  operationId: 'getListeningStreaks',
  tags: ['Listening'],
  summary: 'Listening streaks',
  description: 'Returns current and longest listening streaks.',
  responses: {
    200: {
      description: 'Streak data',
      content: {
        'application/json': {
          schema: StreaksSchema,
          example: {
            current: { days: 3, start_date: '2026-03-16', total_scrobbles: 65 },
            longest: {
              days: 62,
              start_date: '2017-01-02',
              end_date: '2017-03-04',
              total_scrobbles: 3535,
            },
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const YearQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12).optional().openapi({
    example: 3,
    description: 'Optional month (1-12) to scope results to a single month',
  }),
  include_sparklines: z.coerce.boolean().optional().openapi({
    description:
      'When true, attach a `sparkline` object to each item in `top_artists`, `top_albums`, and `top_tracks`. Without `month`, returns 12 monthly buckets for the year. With `month`, returns daily buckets within that month (28-31 points).',
    example: false,
  }),
});

const yearRoute = createRoute({
  method: 'get',
  path: '/year/{year}',
  operationId: 'getListeningYearInReview',
  tags: ['Listening'],
  summary: 'Year in review',
  description:
    'Returns year-in-review listening data. Optionally pass ?month=N to scope to a single month.',
  request: { params: YearParamSchema, query: YearQuerySchema },
  responses: {
    200: {
      description: 'Year in review data',
      content: {
        'application/json': {
          schema: YearSchema,
          example: {
            year: 2025,
            total_scrobbles: 8500,
            unique_artists: 420,
            unique_albums: 890,
            unique_tracks: 3200,
            top_artists: [
              {
                id: 92,
                name: 'Taylor Swift',
                scrobbles: 350,
                apple_music_url:
                  'https://music.apple.com/us/artist/taylor-swift/159260351?uo=4',
                image: null,
              },
              {
                id: 189,
                name: 'Nirvana',
                scrobbles: 280,
                apple_music_url:
                  'https://music.apple.com/us/artist/nirvana/112018?uo=4',
                image: null,
              },
            ],
            top_albums: [
              {
                id: 20,
                name: 'GUTS',
                artist: 'Olivia Rodrigo',
                scrobbles: 120,
                apple_music_url: null,
                image: null,
              },
              {
                id: 300,
                name: 'MTV Unplugged in New York',
                artist: 'Nirvana',
                scrobbles: 95,
                apple_music_url: null,
                image: null,
              },
            ],
            top_tracks: [
              {
                id: 2001,
                name: 'Espresso',
                artist: 'Sabrina Carpenter',
                scrobbles: 68,
                apple_music_url: null,
                preview_url: null,
              },
              {
                id: 1001,
                name: 'bad idea right?',
                artist: 'Olivia Rodrigo',
                scrobbles: 55,
                apple_music_url: null,
                preview_url: null,
              },
            ],
            monthly: [
              {
                month: '2025-01',
                scrobbles: 720,
                unique_artists: 85,
                unique_albums: 140,
              },
              {
                month: '2025-02',
                scrobbles: 680,
                unique_artists: 78,
                unique_albums: 125,
              },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

const YearSummarySchema = z.object({
  year: z.number(),
  total_scrobbles: z.number(),
  unique_artists: z.number(),
  unique_albums: z.number(),
  unique_tracks: z.number(),
  top_artist: z
    .object({ id: z.number(), name: z.string() })
    .nullable()
    .optional(),
});

const yearsRoute = createRoute({
  method: 'get',
  path: '/years',
  operationId: 'listListeningYears',
  tags: ['Listening'],
  summary: 'All year summaries',
  description:
    'Returns one entry per year tracked, with total scrobbles and unique artist, album, and track counts.',
  responses: {
    200: {
      description: 'Year summaries, newest first',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(YearSummarySchema) }),
          example: {
            data: [
              {
                year: 2026,
                total_scrobbles: 3200,
                unique_artists: 180,
                unique_albums: 410,
                unique_tracks: 1250,
                top_artist: { id: 92, name: 'Taylor Swift' },
              },
              {
                year: 2025,
                total_scrobbles: 12345,
                unique_artists: 234,
                unique_albums: 567,
                unique_tracks: 890,
                top_artist: { id: 189, name: 'Nirvana' },
              },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const GenrePeriodSchema = z.object({
  period: z.string().openapi({ example: '2025-01' }),
  genres: z.record(z.string(), z.number()).openapi({
    example: { Rock: 245, 'Hip-Hop': 112, Electronic: 87, Other: 89 },
  }),
  total: z.number().openapi({ example: 637 }),
});

const genresRoute = createRoute({
  method: 'get',
  path: '/genres',
  operationId: 'getListeningGenres',
  tags: ['Listening'],
  summary: 'Genre breakdown',
  description:
    'Returns a genre breakdown over time, grouped by period and designed for stacked bar charts.',
  request: {
    query: DateFilterQuery.extend({
      group_by: z
        .enum(['week', 'month', 'year'])
        .optional()
        .default('month')
        .openapi({ example: 'month' }),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .openapi({
          example: 10,
          description: 'Max genres to return (rest grouped as "Other")',
        }),
      compare_to: z.enum(['previous_year']).optional().openapi({
        example: 'previous_year',
        description:
          'When set to `previous_year`, returns a `compare` array with the same shape as `data` but for the window shifted back one year. Requires `from` + `to` or `date` to be set; ignored otherwise.',
      }),
    }),
  },
  responses: {
    200: {
      description: 'Genre breakdown by period',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(GenrePeriodSchema),
            compare: z.array(GenrePeriodSchema).optional(),
          }),
          example: {
            data: [
              {
                period: '2026-01',
                genres: {
                  Rock: 245,
                  'Hip-Hop': 112,
                  Electronic: 87,
                  Other: 89,
                },
                total: 533,
              },
              {
                period: '2026-02',
                genres: { Pop: 180, Rock: 150, 'Hip-Hop': 95, Other: 76 },
                total: 501,
              },
              {
                period: '2026-03',
                genres: { Grunge: 120, Rock: 110, Pop: 90, Other: 67 },
                total: 387,
              },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const listFiltersRoute = createRoute({
  method: 'get',
  path: '/admin/filters',
  operationId: 'listListeningFilters',
  'x-hidden': true,
  tags: ['Listening', 'Admin'],
  summary: 'List listening filters',
  description: 'Returns all listening filters.',
  responses: {
    200: {
      description: 'Filter list',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(FilterSchema) }),
        },
      },
    },
    ...errorResponses(401),
  },
});

const createFilterRoute = createRoute({
  method: 'post',
  path: '/admin/filters',
  operationId: 'createListeningFilter',
  'x-hidden': true,
  tags: ['Listening', 'Admin'],
  summary: 'Create listening filter',
  description: 'Creates a new listening filter.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            filter_type: z.string().openapi({ example: 'holiday' }),
            pattern: z.string().openapi({ example: 'Christmas' }),
            scope: z.string().openapi({ example: 'album' }),
            reason: z
              .string()
              .optional()
              .openapi({ example: 'Seasonal music' }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Filter created',
      content: { 'application/json': { schema: FilterSchema } },
    },
    ...errorResponses(400, 401, 500),
  },
});

const deleteFilterRoute = createRoute({
  method: 'delete',
  path: '/admin/filters/{id}',
  operationId: 'deleteListeningFilter',
  'x-hidden': true,
  tags: ['Listening', 'Admin'],
  summary: 'Delete listening filter',
  description: 'Deletes a listening filter by ID.',
  request: { params: IdParamSchema },
  responses: {
    200: {
      description: 'Filter deleted',
      content: {
        'application/json': {
          schema: z.object({ success: z.boolean(), deleted_id: z.number() }),
        },
      },
    },
    ...errorResponses(400, 401, 404),
  },
});

const backfillImagesRoute = createRoute({
  method: 'post',
  path: '/admin/backfill-images',
  operationId: 'backfillListeningImages',
  'x-hidden': true,
  tags: ['Listening', 'Admin'],
  summary: 'Backfill listening images',
  description: 'Backfills missing images for albums and/or artists.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            type: z
              .enum(['albums', 'artists', 'all'])
              .optional()
              .default('albums')
              .openapi({ example: 'albums' }),
            limit: z
              .number()
              .int()
              .min(1)
              .max(200)
              .optional()
              .default(50)
              .openapi({ example: 50 }),
            retry: z.boolean().optional().default(false).openapi({
              description:
                'Retry albums/artists that previously failed (source=none placeholders)',
              example: true,
            }),
            artist: z.string().optional().openapi({
              description:
                'Filter to a specific artist name (case-insensitive partial match)',
              example: 'Beastie Boys',
            }),
          }),
        },
      },
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
    ...errorResponses(400, 401),
  },
});

// ─── Handlers ───────────────────────────────────────────────────────

// GET /v1/listening/now-playing
listening.openapi(nowPlayingRoute, async (c) => {
  setCache(c, 'none');
  const client = new LastfmClient(c.env.LASTFM_API_KEY, c.env.LASTFM_USERNAME);
  const db = createDb(c.env.DB);

  try {
    // now-playing reads live from Last.fm (the only listening endpoint that
    // does). Every other endpoint excludes audiobooks/holiday music via the
    // synced is_filtered columns, so we must apply the same filtering here --
    // otherwise a stray scrobble (e.g. Plex scrobbling an audiobook) surfaces
    // as "now playing". Over-fetch so we can fall through to the most recent
    // track that isn't filtered.
    await loadFilters(db);
    const response = await client.getRecentTracks({ limit: 20 });
    const tracks = response.recenttracks.track;

    if (!tracks || tracks.length === 0) {
      return c.json({ is_playing: false, track: null, scrobbled_at: null });
    }

    // Walk newest-to-oldest and pick the first track that isn't filtered.
    // Check both the live filter rules (artist/album/track patterns -- catches
    // an author blacklist before a sync flags the row) and the synced
    // is_filtered flag on the artist (catches tag-detected audiobooks).
    let latestTrack: (typeof tracks)[number] | undefined;
    let artist:
      | { id: number; name: string; appleMusicUrl: string | null }
      | undefined;

    for (const candidate of tracks) {
      const artistName = candidate.artist['#text'];
      if (
        isFiltered({
          artistName,
          albumName: candidate.album?.['#text'] || undefined,
          trackName: candidate.name,
        })
      ) {
        continue;
      }

      const [row] = await db
        .select({
          id: lastfmArtists.id,
          name: lastfmArtists.name,
          appleMusicUrl: lastfmArtists.appleMusicUrl,
          isFiltered: lastfmArtists.isFiltered,
        })
        .from(lastfmArtists)
        .where(eq(lastfmArtists.name, artistName))
        .limit(1);

      if (row?.isFiltered === 1) {
        continue;
      }

      latestTrack = candidate;
      artist = row
        ? { id: row.id, name: row.name, appleMusicUrl: row.appleMusicUrl }
        : undefined;
      break;
    }

    if (!latestTrack) {
      return c.json({ is_playing: false, track: null, scrobbled_at: null });
    }

    const isPlaying = latestTrack['@attr']?.nowplaying === 'true';

    // Resolve track + album via the stored track.album_id link. Mirrors the
    // /recent endpoint's join shape so attribution stays consistent across
    // surfaces — see docs/projects/album-attribution-repair/README.md for
    // why the previous (name, artist_id) album lookup was unreliable.
    let trackData: {
      id: number;
      appleMusicUrl: string | null;
      previewUrl: string | null;
      albumId: number | null;
      albumName: string | null;
    } | null = null;
    if (artist) {
      const [row] = await db
        .select({
          id: lastfmTracks.id,
          appleMusicUrl: lastfmTracks.appleMusicUrl,
          previewUrl: lastfmTracks.previewUrl,
          albumId: lastfmTracks.albumId,
          albumName: lastfmAlbums.name,
        })
        .from(lastfmTracks)
        .leftJoin(lastfmAlbums, eq(lastfmTracks.albumId, lastfmAlbums.id))
        .where(
          and(
            eq(lastfmTracks.name, latestTrack.name),
            eq(lastfmTracks.artistId, artist.id)
          )
        )
        .limit(1);
      trackData = row ?? null;
    }

    const albumData =
      trackData?.albumId && trackData.albumName
        ? { id: trackData.albumId, name: trackData.albumName }
        : null;

    const albumImage = albumData
      ? await getImageAttachment(
          db,
          'listening',
          'albums',
          String(albumData.id)
        )
      : null;

    const scrobbledAt = latestTrack.date
      ? new Date(parseInt(latestTrack.date.uts) * 1000).toISOString()
      : null;

    return c.json({
      is_playing: isPlaying,
      track: {
        name: latestTrack.name,
        artist: {
          id: artist?.id ?? null,
          name: latestTrack.artist['#text'],
          apple_music_url: artist?.appleMusicUrl ?? null,
        },
        album: {
          id: albumData?.id ?? null,
          name: albumData?.name ?? latestTrack.album['#text'],
          image: albumImage,
        },
        url: latestTrack.url,
        apple_music_url: trackData?.appleMusicUrl ?? null,
        preview_url: trackData?.previewUrl ?? null,
      },
      scrobbled_at: scrobbledAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[ERROR] Now playing fetch failed: ${message}`);
    return c.json({ is_playing: false, track: null, scrobbled_at: null });
  }
});

// GET /v1/listening/recent
listening.openapi(recentRoute, async (c) => {
  setCache(c, 'realtime');
  const db = createDb(c.env.DB);

  const limitParam = parseInt(c.req.query('limit') ?? '10');
  const limit = Math.min(Math.max(1, limitParam), 50);
  const pageParam = parseInt(c.req.query('page') ?? '1');
  const page = Math.max(1, pageParam);
  const offset = (page - 1) * limit;

  const dateCondition = buildDateCondition(lastfmScrobbles.scrobbledAt, {
    date: c.req.query('date'),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });

  const scrobbles = await db
    .select({
      scrobbledAt: lastfmScrobbles.scrobbledAt,
      trackName: lastfmTracks.name,
      trackUrl: lastfmTracks.url,
      trackId: lastfmTracks.id,
      trackAppleMusicUrl: lastfmTracks.appleMusicUrl,
      trackPreviewUrl: lastfmTracks.previewUrl,
      artistName: lastfmArtists.name,
      artistId: lastfmArtists.id,
      albumName: lastfmAlbums.name,
      albumId: lastfmAlbums.id,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .leftJoin(lastfmAlbums, eq(lastfmTracks.albumId, lastfmAlbums.id))
    .where(and(eq(lastfmTracks.isFiltered, 0), dateCondition))
    .orderBy(desc(lastfmScrobbles.scrobbledAt))
    .limit(limit)
    .offset(offset);

  const albumIds = [
    ...new Set(
      scrobbles.map((s) => s.albumId).filter((id): id is number => id !== null)
    ),
  ].map(String);
  const imageMap = await getImageAttachmentBatch(
    db,
    'listening',
    'albums',
    albumIds
  );

  return c.json({
    data: scrobbles.map((s) => ({
      track: {
        id: s.trackId,
        name: s.trackName,
        url: s.trackUrl,
        apple_music_url: s.trackAppleMusicUrl ?? null,
        preview_url: s.trackPreviewUrl ?? null,
      },
      artist: {
        id: s.artistId,
        name: s.artistName,
      },
      album: {
        id: s.albumId,
        name: s.albumName,
        image: s.albumId ? (imageMap.get(String(s.albumId)) ?? null) : null,
      },
      scrobbled_at: s.scrobbledAt,
    })),
  });
});

// Resolve which sparkline window to use for a top-* endpoint based on the
// period string. Returns null when sparklines are unsupported (e.g. `7day`)
// or there's no data to anchor an `overall` window against.
async function resolveTopListSparklineWindow(
  db: Database,
  period: string
): Promise<ReturnType<typeof periodToWindow> | null> {
  if (isSparklinePeriod(period)) {
    return periodToWindow(period as SparklinePeriod);
  }
  if (period === 'overall') {
    const earliest = await db
      .select({
        first: sql<string>`strftime('%Y', min(${lastfmScrobbles.scrobbledAt}))`,
      })
      .from(lastfmScrobbles)
      .where(eq(lastfmScrobbles.userId, 1))
      .limit(1);
    const year = parseInt(earliest[0]?.first ?? '');
    if (!Number.isFinite(year)) return null;
    return overallToWindow(year, new Date().getUTCFullYear());
  }
  return null;
}

// GET /v1/listening/top/artists
listening.openapi(topArtistsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const period = (c.req.query('period') ?? '7day') as LastfmPeriod;
  if (!VALID_PERIODS.includes(period)) {
    return badRequest(
      c,
      `Invalid period. Valid: ${VALID_PERIODS.join(', ')}`
    ) as any;
  }

  const page = Math.max(1, parseInt(c.req.query('page') ?? '1'));
  const limit = Math.min(
    Math.max(1, parseInt(c.req.query('limit') ?? '10')),
    50
  );
  const offset = (page - 1) * limit;

  const includeSparklinesParam = c.req.query('include_sparklines');
  const includeSparklines =
    includeSparklinesParam === 'true' || includeSparklinesParam === '1';

  // Date filter present → live aggregate from scrobbles (precomputed
  // top-artists table only carries Last.fm's canonical periods). Without
  // a date filter, use the precomputed table for speed.
  const dateCondition = buildDateCondition(lastfmScrobbles.scrobbledAt, {
    date: c.req.query('date'),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });

  type ArtistRow = {
    rank: number;
    playcount: number;
    artistId: number;
    artistName: string;
    artistUrl: string | null;
    artistGenre: string | null;
    artistAppleMusicUrl: string | null;
  };

  let total: number;
  let items: ArtistRow[];

  if (dateCondition) {
    const liveConditions = [eq(lastfmTracks.isFiltered, 0), dateCondition];

    const [{ count: countResult }] = await db
      .select({
        count: sql<number>`count(distinct ${lastfmTracks.artistId})`,
      })
      .from(lastfmScrobbles)
      .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
      .where(and(...liveConditions));
    total = countResult;

    const aggregated = await db
      .select({
        artistId: lastfmArtists.id,
        artistName: lastfmArtists.name,
        artistUrl: lastfmArtists.url,
        artistGenre: lastfmArtists.genre,
        artistAppleMusicUrl: lastfmArtists.appleMusicUrl,
        playcount: sql<number>`count(${lastfmScrobbles.id})`,
      })
      .from(lastfmScrobbles)
      .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
      .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
      .where(and(...liveConditions))
      .groupBy(lastfmArtists.id)
      .orderBy(desc(sql`count(${lastfmScrobbles.id})`))
      .limit(limit)
      .offset(offset);

    items = aggregated.map((row, i) => ({
      rank: offset + i + 1,
      playcount: row.playcount,
      artistId: row.artistId,
      artistName: row.artistName,
      artistUrl: row.artistUrl,
      artistGenre: row.artistGenre,
      artistAppleMusicUrl: row.artistAppleMusicUrl,
    }));
  } else {
    const [{ count: countResult }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(lastfmTopArtists)
      .innerJoin(lastfmArtists, eq(lastfmTopArtists.artistId, lastfmArtists.id))
      .where(
        and(
          eq(lastfmTopArtists.period, period),
          eq(lastfmArtists.isFiltered, 0)
        )
      );
    total = countResult;

    items = await db
      .select({
        rank: lastfmTopArtists.rank,
        playcount: lastfmTopArtists.playcount,
        artistId: lastfmArtists.id,
        artistName: lastfmArtists.name,
        artistUrl: lastfmArtists.url,
        artistGenre: lastfmArtists.genre,
        artistAppleMusicUrl: lastfmArtists.appleMusicUrl,
      })
      .from(lastfmTopArtists)
      .innerJoin(lastfmArtists, eq(lastfmTopArtists.artistId, lastfmArtists.id))
      .where(
        and(
          eq(lastfmTopArtists.period, period),
          eq(lastfmArtists.isFiltered, 0)
        )
      )
      .orderBy(asc(lastfmTopArtists.rank))
      .limit(limit)
      .offset(offset);
  }

  const artistIdStrings = items.map((i) => String(i.artistId));
  const numericArtistIds = items.map((i) => i.artistId);
  const sparklineWindow = includeSparklines
    ? await resolveTopListSparklineWindow(db, period)
    : null;

  const [imageMap, sparklineMap] = await Promise.all([
    getImageAttachmentBatch(db, 'listening', 'artists', artistIdStrings),
    sparklineWindow
      ? buildSparklinesForWindow(
          db,
          numericArtistIds,
          sparklineWindow,
          'artist'
        )
      : Promise.resolve(undefined),
  ]);

  return c.json({
    period,
    data: items.map((item) => {
      const sparkline = sparklineMap?.get(item.artistId);
      return {
        rank: item.rank,
        id: item.artistId,
        name: item.artistName,
        detail: '',
        playcount: item.playcount,
        genre: item.artistGenre ?? null,
        image: imageMap.get(String(item.artistId)) ?? null,
        url: item.artistUrl ?? '',
        apple_music_url: item.artistAppleMusicUrl ?? null,
        ...(sparkline ? { sparkline } : {}),
      };
    }),
    pagination: paginate(page, limit, total),
  });
});

// GET /v1/listening/top/albums
listening.openapi(topAlbumsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const period = (c.req.query('period') ?? '7day') as LastfmPeriod;
  if (!VALID_PERIODS.includes(period)) {
    return badRequest(
      c,
      `Invalid period. Valid: ${VALID_PERIODS.join(', ')}`
    ) as any;
  }

  const page = Math.max(1, parseInt(c.req.query('page') ?? '1'));
  const limit = Math.min(
    Math.max(1, parseInt(c.req.query('limit') ?? '10')),
    50
  );
  const offset = (page - 1) * limit;

  const [{ count: total }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(lastfmTopAlbums)
    .innerJoin(lastfmAlbums, eq(lastfmTopAlbums.albumId, lastfmAlbums.id))
    .where(
      and(eq(lastfmTopAlbums.period, period), eq(lastfmAlbums.isFiltered, 0))
    );

  const items = await db
    .select({
      rank: lastfmTopAlbums.rank,
      playcount: lastfmTopAlbums.playcount,
      albumId: lastfmAlbums.id,
      albumName: lastfmAlbums.name,
      albumUrl: lastfmAlbums.url,
      albumAppleMusicUrl: lastfmAlbums.appleMusicUrl,
      artistName: lastfmArtists.name,
    })
    .from(lastfmTopAlbums)
    .innerJoin(lastfmAlbums, eq(lastfmTopAlbums.albumId, lastfmAlbums.id))
    .innerJoin(lastfmArtists, eq(lastfmAlbums.artistId, lastfmArtists.id))
    .where(
      and(eq(lastfmTopAlbums.period, period), eq(lastfmAlbums.isFiltered, 0))
    )
    .orderBy(asc(lastfmTopAlbums.rank))
    .limit(limit)
    .offset(offset);

  const albumIds = items.map((i) => String(i.albumId));
  const numericAlbumIds = items.map((i) => i.albumId);

  const includeSparklinesParam = c.req.query('include_sparklines');
  const includeSparklines =
    includeSparklinesParam === 'true' || includeSparklinesParam === '1';
  const sparklineWindow = includeSparklines
    ? await resolveTopListSparklineWindow(db, period)
    : null;

  const [imageMap, sparklineMap] = await Promise.all([
    getImageAttachmentBatch(db, 'listening', 'albums', albumIds),
    sparklineWindow
      ? buildSparklinesForWindow(db, numericAlbumIds, sparklineWindow, 'album')
      : Promise.resolve(undefined),
  ]);

  return c.json({
    period,
    data: items.map((item) => {
      const sparkline = sparklineMap?.get(item.albumId);
      return {
        rank: item.rank,
        id: item.albumId,
        name: item.albumName,
        detail: item.artistName,
        playcount: item.playcount,
        image: imageMap.get(String(item.albumId)) ?? null,
        url: item.albumUrl ?? '',
        apple_music_url: item.albumAppleMusicUrl ?? null,
        ...(sparkline ? { sparkline } : {}),
      };
    }),
    pagination: paginate(page, limit, total),
  });
});

// GET /v1/listening/top/tracks
listening.openapi(topTracksRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const period = (c.req.query('period') ?? '7day') as LastfmPeriod;
  if (!VALID_PERIODS.includes(period)) {
    return badRequest(
      c,
      `Invalid period. Valid: ${VALID_PERIODS.join(', ')}`
    ) as any;
  }

  const page = Math.max(1, parseInt(c.req.query('page') ?? '1'));
  const limit = Math.min(
    Math.max(1, parseInt(c.req.query('limit') ?? '10')),
    50
  );
  const offset = (page - 1) * limit;

  // Optional artist filter — `artist_id` (preferred, stable) or
  // `artist_name` (substring resolver). Both supplied is a 400.
  const artistIdParam = c.req.query('artist_id');
  const artistNameParam = c.req.query('artist_name');
  if (artistIdParam && artistNameParam) {
    return badRequest(
      c,
      'Pass either artist_id or artist_name, not both.'
    ) as any;
  }
  let resolvedArtistId: number | null = null;
  if (artistIdParam) {
    const parsed = parseInt(artistIdParam);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return badRequest(c, 'artist_id must be a positive integer.') as any;
    }
    resolvedArtistId = parsed;
  } else if (artistNameParam) {
    // Case-insensitive substring; tie-break by playcount desc.
    const matches = await db
      .select({ id: lastfmArtists.id })
      .from(lastfmArtists)
      .where(
        and(
          eq(lastfmArtists.isFiltered, 0),
          like(
            sql`lower(${lastfmArtists.name})`,
            `%${artistNameParam.toLowerCase()}%`
          )
        )
      )
      .orderBy(desc(lastfmArtists.playcount))
      .limit(1);
    if (matches.length === 0) {
      return notFound(c, `No artist matching '${artistNameParam}'.`) as any;
    }
    resolvedArtistId = matches[0].id;
  }

  // Three query paths:
  //   1. date filter present (date|from|to) → live aggregate from scrobbles
  //      with the user-supplied date range. Composes with the optional
  //      artist filter. Precomputed top-list isn't useful for arbitrary
  //      ranges (it only carries the canonical Last.fm periods).
  //   2. artist filter present (no date filter) → live aggregate from
  //      scrobbles with the period-derived window (the precomputed
  //      lastfm_top_tracks table only carries the user's global top-N,
  //      so most per-artist tracks are missing from it).
  //   3. neither → use the precomputed lastfm_top_tracks table — fast,
  //      matches existing behavior.
  const dateCondition = buildDateCondition(lastfmScrobbles.scrobbledAt, {
    date: c.req.query('date'),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });

  type ItemRow = {
    rank: number;
    playcount: number;
    trackId: number;
    trackName: string;
    trackUrl: string | null;
    trackAppleMusicUrl: string | null;
    trackPreviewUrl: string | null;
    albumId: number | null;
    albumName: string | null;
    albumAppleMusicUrl: string | null;
    albumReleasedYear: number | null;
    albumTotalTracks: number | null;
    artistName: string;
  };

  let total: number;
  let items: ItemRow[];

  const useLiveAggregation =
    dateCondition !== undefined || resolvedArtistId !== null;

  if (useLiveAggregation) {
    // Live aggregate from scrobbles. Date filter wins over period when both
    // are supplied; otherwise derive a period window. The artist filter, if
    // present, narrows further.
    const liveConditions = [eq(lastfmTracks.isFiltered, 0)];
    if (resolvedArtistId !== null) {
      liveConditions.push(eq(lastfmTracks.artistId, resolvedArtistId));
    }
    if (dateCondition) {
      liveConditions.push(dateCondition);
    } else {
      const periodWindow = await resolveTopListSparklineWindow(db, period);
      if (periodWindow) {
        liveConditions.push(
          gte(lastfmScrobbles.scrobbledAt, periodWindow.from),
          lte(lastfmScrobbles.scrobbledAt, periodWindow.to)
        );
      }
    }

    // Count distinct tracks in the window.
    const [{ count: countResult }] = await db
      .select({
        count: sql<number>`count(distinct ${lastfmTracks.id})`,
      })
      .from(lastfmScrobbles)
      .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
      .where(and(...liveConditions));
    total = countResult;

    // Aggregate scrobble counts per track + join album/artist for display.
    const aggregated = await db
      .select({
        trackId: lastfmTracks.id,
        trackName: lastfmTracks.name,
        trackUrl: lastfmTracks.url,
        trackAppleMusicUrl: lastfmTracks.appleMusicUrl,
        trackPreviewUrl: lastfmTracks.previewUrl,
        albumId: lastfmTracks.albumId,
        albumName: lastfmAlbums.name,
        albumAppleMusicUrl: lastfmAlbums.appleMusicUrl,
        albumReleasedYear: lastfmAlbums.releasedYear,
        albumTotalTracks: lastfmAlbums.totalTracks,
        artistName: lastfmArtists.name,
        playcount: sql<number>`count(${lastfmScrobbles.id})`,
      })
      .from(lastfmScrobbles)
      .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
      .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
      .leftJoin(lastfmAlbums, eq(lastfmTracks.albumId, lastfmAlbums.id))
      .where(and(...liveConditions))
      .groupBy(lastfmTracks.id)
      .orderBy(desc(sql`count(${lastfmScrobbles.id})`))
      .limit(limit)
      .offset(offset);

    items = aggregated.map((row, i) => ({
      rank: offset + i + 1,
      playcount: row.playcount,
      trackId: row.trackId,
      trackName: row.trackName,
      trackUrl: row.trackUrl,
      trackAppleMusicUrl: row.trackAppleMusicUrl,
      trackPreviewUrl: row.trackPreviewUrl,
      albumId: row.albumId,
      albumName: row.albumName,
      albumAppleMusicUrl: row.albumAppleMusicUrl,
      albumReleasedYear: row.albumReleasedYear,
      albumTotalTracks: row.albumTotalTracks,
      artistName: row.artistName,
    }));
  } else {
    // No artist filter — use the precomputed top-tracks table.
    const baseConditions = [
      eq(lastfmTopTracks.period, period),
      eq(lastfmTracks.isFiltered, 0),
    ];

    const [{ count: countResult }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(lastfmTopTracks)
      .innerJoin(lastfmTracks, eq(lastfmTopTracks.trackId, lastfmTracks.id))
      .where(and(...baseConditions));
    total = countResult;

    items = await db
      .select({
        rank: lastfmTopTracks.rank,
        playcount: lastfmTopTracks.playcount,
        trackId: lastfmTracks.id,
        trackName: lastfmTracks.name,
        trackUrl: lastfmTracks.url,
        trackAppleMusicUrl: lastfmTracks.appleMusicUrl,
        trackPreviewUrl: lastfmTracks.previewUrl,
        albumId: lastfmTracks.albumId,
        albumName: lastfmAlbums.name,
        albumAppleMusicUrl: lastfmAlbums.appleMusicUrl,
        albumReleasedYear: lastfmAlbums.releasedYear,
        albumTotalTracks: lastfmAlbums.totalTracks,
        artistName: lastfmArtists.name,
      })
      .from(lastfmTopTracks)
      .innerJoin(lastfmTracks, eq(lastfmTopTracks.trackId, lastfmTracks.id))
      .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
      .leftJoin(lastfmAlbums, eq(lastfmTracks.albumId, lastfmAlbums.id))
      .where(and(...baseConditions))
      .orderBy(asc(lastfmTopTracks.rank))
      .limit(limit)
      .offset(offset);
  }

  const numericTrackIds = items.map((i) => i.trackId);
  const includeSparklinesParam = c.req.query('include_sparklines');
  const includeSparklines =
    includeSparklinesParam === 'true' || includeSparklinesParam === '1';
  const sparklineWindow = includeSparklines
    ? await resolveTopListSparklineWindow(db, period)
    : null;
  const sparklineMap = sparklineWindow
    ? await buildSparklinesForWindow(
        db,
        numericTrackIds,
        sparklineWindow,
        'track'
      )
    : undefined;

  // Album art lookup — track image == its album's image when present.
  const albumIds = Array.from(
    new Set(
      items
        .map((i) => (i.albumId ? String(i.albumId) : null))
        .filter((s): s is string => s !== null)
    )
  );
  const albumImageMap = await getImageAttachmentBatch(
    db,
    'listening',
    'albums',
    albumIds
  );

  return c.json({
    period,
    artist_id: resolvedArtistId,
    data: items.map((item) => {
      const sparkline = sparklineMap?.get(item.trackId);
      return {
        rank: item.rank,
        id: item.trackId,
        name: item.trackName,
        detail: item.artistName,
        album_id: item.albumId,
        album_name: item.albumName ?? null,
        album_apple_music_url: item.albumAppleMusicUrl ?? null,
        album_released_year: item.albumReleasedYear ?? null,
        album_total_tracks: item.albumTotalTracks ?? null,
        playcount: item.playcount,
        image: item.albumId
          ? (albumImageMap.get(String(item.albumId)) ?? null)
          : null,
        url: item.trackUrl ?? '',
        apple_music_url: item.trackAppleMusicUrl ?? null,
        preview_url: item.trackPreviewUrl ?? null,
        ...(sparkline ? { sparkline } : {}),
      };
    }),
    pagination: paginate(page, limit, total),
  });
});

// GET /v1/listening/stats
listening.openapi(statsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const dateCondition = buildDateCondition(lastfmScrobbles.scrobbledAt, {
    date: c.req.query('date'),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });

  // Date-scoped: compute live from scrobbles
  if (dateCondition) {
    const scopedCondition = and(dateCondition, eq(lastfmTracks.isFiltered, 0));

    const [totals] = await db
      .select({
        totalScrobbles: sql<number>`count(*)`,
        uniqueArtists: sql<number>`count(distinct ${lastfmTracks.artistId})`,
        uniqueAlbums: sql<number>`count(distinct ${lastfmTracks.albumId})`,
        uniqueTracks: sql<number>`count(distinct ${lastfmScrobbles.trackId})`,
        minDate: sql<string>`min(${lastfmScrobbles.scrobbledAt})`,
        maxDate: sql<string>`max(${lastfmScrobbles.scrobbledAt})`,
      })
      .from(lastfmScrobbles)
      .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
      .where(scopedCondition);

    const daysInRange =
      totals.minDate && totals.maxDate
        ? Math.max(
            1,
            Math.ceil(
              (new Date(totals.maxDate).getTime() -
                new Date(totals.minDate).getTime()) /
                86400000
            ) + 1
          )
        : 1;

    const scrobblesPerDay =
      daysInRange > 0
        ? Math.round((totals.totalScrobbles / daysInRange) * 10) / 10
        : 0;

    return c.json({
      total_scrobbles: totals.totalScrobbles,
      unique_artists: totals.uniqueArtists,
      unique_albums: totals.uniqueAlbums,
      unique_tracks: totals.uniqueTracks,
      registered_date: null,
      years_tracking: 0,
      scrobbles_per_day: scrobblesPerDay,
    });
  }

  // Lifetime: use pre-computed stats table
  const [stats] = await db
    .select()
    .from(lastfmUserStats)
    .where(eq(lastfmUserStats.userId, 1))
    .limit(1);

  if (!stats) {
    return c.json({
      total_scrobbles: 0,
      unique_artists: 0,
      unique_albums: 0,
      unique_tracks: 0,
      registered_date: null,
      years_tracking: 0,
      scrobbles_per_day: 0,
    });
  }

  const registeredDate = stats.registeredDate
    ? new Date(stats.registeredDate)
    : null;
  const now = new Date();
  const yearsTracking = registeredDate
    ? Math.floor(
        (now.getTime() - registeredDate.getTime()) / (365.25 * 86400000)
      )
    : 0;
  const daysTracking = registeredDate
    ? Math.floor((now.getTime() - registeredDate.getTime()) / 86400000)
    : 1;
  const scrobblesPerDay =
    daysTracking > 0
      ? Math.round((stats.totalScrobbles / daysTracking) * 10) / 10
      : 0;

  return c.json({
    total_scrobbles: stats.totalScrobbles,
    unique_artists: stats.uniqueArtists,
    unique_albums: stats.uniqueAlbums,
    unique_tracks: stats.uniqueTracks,
    registered_date: stats.registeredDate,
    years_tracking: yearsTracking,
    scrobbles_per_day: scrobblesPerDay,
  });
});

// GET /v1/listening/history
listening.openapi(historyRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const page = Math.max(1, parseInt(c.req.query('page') ?? '1'));
  const limit = Math.min(
    Math.max(1, parseInt(c.req.query('limit') ?? '50')),
    200
  );
  const offset = (page - 1) * limit;

  const from = c.req.query('from');
  const to = c.req.query('to');
  const artistFilter = c.req.query('artist');
  const albumFilter = c.req.query('album');

  // Build conditions — always exclude filtered tracks
  const conditions = [eq(lastfmTracks.isFiltered, 0)];
  if (from) conditions.push(gte(lastfmScrobbles.scrobbledAt, from));
  if (to) conditions.push(lte(lastfmScrobbles.scrobbledAt, to));
  if (artistFilter)
    conditions.push(like(lastfmArtists.name, `%${artistFilter}%`));
  if (albumFilter) conditions.push(like(lastfmAlbums.name, `%${albumFilter}%`));

  const whereClause = and(...conditions);

  // Count total
  const baseQuery = db
    .select({ count: sql<number>`count(*)` })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .leftJoin(lastfmAlbums, eq(lastfmTracks.albumId, lastfmAlbums.id));

  const [{ count: total }] = await baseQuery.where(whereClause);

  // Fetch page
  const scrobbles = await db
    .select({
      scrobbledAt: lastfmScrobbles.scrobbledAt,
      trackName: lastfmTracks.name,
      trackUrl: lastfmTracks.url,
      trackId: lastfmTracks.id,
      trackAppleMusicUrl: lastfmTracks.appleMusicUrl,
      trackPreviewUrl: lastfmTracks.previewUrl,
      artistName: lastfmArtists.name,
      artistId: lastfmArtists.id,
      albumName: lastfmAlbums.name,
      albumId: lastfmAlbums.id,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .leftJoin(lastfmAlbums, eq(lastfmTracks.albumId, lastfmAlbums.id))
    .where(whereClause)
    .orderBy(desc(lastfmScrobbles.scrobbledAt))
    .limit(limit)
    .offset(offset);

  const albumIds = [
    ...new Set(
      scrobbles.map((s) => s.albumId).filter((id): id is number => id !== null)
    ),
  ].map(String);
  const imageMap = await getImageAttachmentBatch(
    db,
    'listening',
    'albums',
    albumIds
  );

  return c.json({
    data: scrobbles.map((s) => ({
      track: {
        id: s.trackId,
        name: s.trackName,
        url: s.trackUrl,
        apple_music_url: s.trackAppleMusicUrl ?? null,
        preview_url: s.trackPreviewUrl ?? null,
      },
      artist: { id: s.artistId, name: s.artistName },
      album: {
        id: s.albumId,
        name: s.albumName,
        image: s.albumId ? (imageMap.get(String(s.albumId)) ?? null) : null,
      },
      scrobbled_at: s.scrobbledAt,
    })),
    pagination: paginate(page, limit, total),
  });
});

// GET /v1/listening/artists - Browse all artists
listening.openapi(browseArtistsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const page = Math.max(1, parseInt(c.req.query('page') ?? '1'));
  const limit = Math.min(
    Math.max(1, parseInt(c.req.query('limit') ?? '20')),
    100
  );
  const offset = (page - 1) * limit;
  const sort = c.req.query('sort') ?? 'playcount';
  const order = c.req.query('order') ?? 'desc';
  const search = c.req.query('search');

  const conditions = [eq(lastfmArtists.isFiltered, 0)];
  if (search) conditions.push(like(lastfmArtists.name, `%${search}%`));

  const whereClause = and(...conditions);

  const [{ count: total }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(lastfmArtists)
    .where(whereClause);

  let orderByClause;
  if (sort === 'name') {
    orderByClause =
      order === 'asc' ? asc(lastfmArtists.name) : desc(lastfmArtists.name);
  } else {
    orderByClause =
      order === 'asc'
        ? asc(lastfmArtists.playcount)
        : desc(lastfmArtists.playcount);
  }

  const items = await db
    .select({
      id: lastfmArtists.id,
      name: lastfmArtists.name,
      url: lastfmArtists.url,
      appleMusicUrl: lastfmArtists.appleMusicUrl,
      playcount: lastfmArtists.playcount,
      genre: lastfmArtists.genre,
    })
    .from(lastfmArtists)
    .where(whereClause)
    .orderBy(orderByClause)
    .limit(limit)
    .offset(offset);

  const artistIds = items.map((i) => String(i.id));
  const imageMap = await getImageAttachmentBatch(
    db,
    'listening',
    'artists',
    artistIds
  );

  return c.json({
    data: items.map((item) => ({
      id: item.id,
      name: item.name,
      playcount: item.playcount,
      genre: item.genre ?? null,
      url: item.url ?? '',
      apple_music_url: item.appleMusicUrl ?? null,
      image: imageMap.get(String(item.id)) ?? null,
    })),
    pagination: paginate(page, limit, total),
  });
});

// GET /v1/listening/albums - Browse all albums
listening.openapi(browseAlbumsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const page = Math.max(1, parseInt(c.req.query('page') ?? '1'));
  const limit = Math.min(
    Math.max(1, parseInt(c.req.query('limit') ?? '20')),
    100
  );
  const offset = (page - 1) * limit;
  const sort = c.req.query('sort') ?? 'playcount';
  const order = c.req.query('order') ?? 'desc';
  const artist = c.req.query('artist');
  const search = c.req.query('search');

  const conditions = [eq(lastfmAlbums.isFiltered, 0)];
  if (artist) conditions.push(like(lastfmArtists.name, `%${artist}%`));
  if (search) conditions.push(like(lastfmAlbums.name, `%${search}%`));

  const whereClause = and(...conditions);

  const [{ count: total }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(lastfmAlbums)
    .innerJoin(lastfmArtists, eq(lastfmAlbums.artistId, lastfmArtists.id))
    .where(whereClause);

  let orderByClause;
  if (sort === 'name') {
    orderByClause =
      order === 'asc' ? asc(lastfmAlbums.name) : desc(lastfmAlbums.name);
  } else if (sort === 'recent') {
    orderByClause =
      order === 'asc'
        ? asc(lastfmAlbums.createdAt)
        : desc(lastfmAlbums.createdAt);
  } else {
    orderByClause =
      order === 'asc'
        ? asc(lastfmAlbums.playcount)
        : desc(lastfmAlbums.playcount);
  }

  const items = await db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      url: lastfmAlbums.url,
      appleMusicUrl: lastfmAlbums.appleMusicUrl,
      playcount: lastfmAlbums.playcount,
      artistId: lastfmArtists.id,
      artistName: lastfmArtists.name,
    })
    .from(lastfmAlbums)
    .innerJoin(lastfmArtists, eq(lastfmAlbums.artistId, lastfmArtists.id))
    .where(whereClause)
    .orderBy(orderByClause)
    .limit(limit)
    .offset(offset);

  const albumIds = items.map((i) => String(i.id));
  const imageMap = await getImageAttachmentBatch(
    db,
    'listening',
    'albums',
    albumIds
  );

  return c.json({
    data: items.map((item) => ({
      id: item.id,
      name: item.name,
      artist: { id: item.artistId, name: item.artistName },
      playcount: item.playcount,
      url: item.url ?? '',
      apple_music_url: item.appleMusicUrl ?? null,
      image: imageMap.get(String(item.id)) ?? null,
    })),
    pagination: paginate(page, limit, total),
  });
});

// GET /v1/listening/artists/:id
listening.openapi(artistDetailRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) return badRequest(c, 'Invalid artist ID') as any;

  const [artist] = await db
    .select()
    .from(lastfmArtists)
    .where(eq(lastfmArtists.id, id))
    .limit(1);

  if (!artist) return notFound(c, 'Artist not found') as any;

  // Get scrobble count + first/last + distinct counts in one pass.
  const [aggregates] = await db
    .select({
      count: sql<number>`count(*)`,
      first: sql<string>`min(${lastfmScrobbles.scrobbledAt})`,
      last: sql<string>`max(${lastfmScrobbles.scrobbledAt})`,
      distinctTracks: sql<number>`count(distinct ${lastfmTracks.id})`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(and(eq(lastfmTracks.artistId, id), eq(lastfmTracks.isFiltered, 0)));

  const [albumCount] = await db
    .select({ distinctAlbums: sql<number>`count(distinct ${lastfmAlbums.id})` })
    .from(lastfmAlbums)
    .where(and(eq(lastfmAlbums.artistId, id), eq(lastfmAlbums.isFiltered, 0)));

  // Overall ranking — where the artist sits among all-time top artists.
  const [overallRank] = await db
    .select({ rank: lastfmTopArtists.rank })
    .from(lastfmTopArtists)
    .where(
      and(
        eq(lastfmTopArtists.artistId, id),
        eq(lastfmTopArtists.period, 'overall')
      )
    )
    .limit(1);

  // Get top albums (exclude filtered) — aggregate plays from scrobbles
  // rather than the cached lastfm_albums.playcount, which can lag behind
  // for albums that never appeared in user.getTopAlbums (deluxe / video
  // editions, soundtracks the user listened to once, etc.). Matches the
  // top_tracks approach below for consistency.
  const topAlbums = await db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      appleMusicUrl: lastfmAlbums.appleMusicUrl,
      playcount: sql<number>`count(${lastfmScrobbles.id})`,
    })
    .from(lastfmAlbums)
    .leftJoin(lastfmTracks, eq(lastfmTracks.albumId, lastfmAlbums.id))
    .leftJoin(lastfmScrobbles, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(
      and(
        eq(lastfmAlbums.artistId, id),
        eq(lastfmAlbums.isFiltered, 0),
        // Inner-filter on tracks too so a single filtered-out track doesn't
        // skew an album's plays.
        sql`(${lastfmTracks.isFiltered} = 0 OR ${lastfmTracks.isFiltered} IS NULL)`
      )
    )
    .groupBy(lastfmAlbums.id)
    // Require ≥ 2 distinct tracks scrobbled — drops one-track guest
    // appearances, singles, and soundtracks where the user only listened
    // to a single contributed song (e.g. Olivia Rodrigo's "All I Want"
    // from the High School Musical soundtrack).
    .having(sql`count(distinct ${lastfmTracks.id}) >= 2`)
    .orderBy(desc(sql`count(${lastfmScrobbles.id})`))
    .limit(10);

  // Get top tracks (exclude filtered) — include album_id so we can join
  // album art for the card. Per-row scrobble count via aggregate.
  const topTracks = await db
    .select({
      id: lastfmTracks.id,
      name: lastfmTracks.name,
      albumId: lastfmTracks.albumId,
      albumName: lastfmAlbums.name,
      appleMusicUrl: lastfmTracks.appleMusicUrl,
      previewUrl: lastfmTracks.previewUrl,
      scrobbleCount: sql<number>`count(${lastfmScrobbles.id})`,
    })
    .from(lastfmTracks)
    .leftJoin(lastfmScrobbles, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .leftJoin(lastfmAlbums, eq(lastfmTracks.albumId, lastfmAlbums.id))
    .where(and(eq(lastfmTracks.artistId, id), eq(lastfmTracks.isFiltered, 0)))
    .groupBy(lastfmTracks.id)
    .orderBy(desc(sql`count(${lastfmScrobbles.id})`))
    .limit(10);

  const artistImage = await getImageAttachment(
    db,
    'listening',
    'artists',
    String(id)
  );

  // Album image lookup for both top_albums and (via album_id) top_tracks.
  const albumIds = Array.from(
    new Set([
      ...topAlbums.map((a) => String(a.id)),
      ...topTracks
        .map((t) => (t.albumId ? String(t.albumId) : null))
        .filter((s): s is string => s !== null),
    ])
  );
  const albumImageMap = await getImageAttachmentBatch(
    db,
    'listening',
    'albums',
    albumIds
  );

  // Lazy-fill bio if missing. ~200ms additional latency on first call per
  // artist, instant thereafter. Same pattern as itunes-enrichment.
  let bioSummary = artist.bioSummary;
  let bioContent = artist.bioContent;
  let bioSyncedAt = artist.bioSyncedAt;
  if (!bioContent && c.env.LASTFM_API_KEY && c.env.LASTFM_USERNAME) {
    try {
      const client = new LastfmClient(
        c.env.LASTFM_API_KEY,
        c.env.LASTFM_USERNAME
      );
      const out = await enrichArtistBio(db, client, {
        id: artist.id,
        name: artist.name,
        mbid: artist.mbid,
      });
      bioSummary = out.bio_summary;
      bioContent = out.bio_content;
      bioSyncedAt = new Date().toISOString();
    } catch (err) {
      // Non-fatal — surface null bio fields rather than failing the request.
      console.log(
        `[WARN] artist ${id} bio lazy-fill failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Resolve similar artists — read from JSON column, look up images, drop
  // entries where the local artist no longer exists (defensive — should
  // not happen if cron is healthy).
  const similarRaw = artist.similarArtists
    ? (JSON.parse(artist.similarArtists) as SimilarArtistEntry[])
    : [];
  const similarIds = similarRaw.map((s) => String(s.artist_id));
  const similarImageMap = await getImageAttachmentBatch(
    db,
    'listening',
    'artists',
    similarIds
  );
  // Aggregate similar-artist plays from scrobbles, not lastfmArtists.playcount
  // (the cached column is from Last.fm's user.getTopArtists which only ranks
  // your top-N — artists below that show 0 in the cache even though you've
  // scrobbled them, which is exactly the case for the long tail of similar
  // artists like Harry Styles / Conan Gray relative to a heavy listen
  // like Olivia Rodrigo).
  const similarPlaycountRows =
    similarRaw.length > 0
      ? await db
          .select({
            id: lastfmArtists.id,
            genre: lastfmArtists.genre,
            playcount: sql<number>`count(${lastfmScrobbles.id})`,
          })
          .from(lastfmArtists)
          .leftJoin(lastfmTracks, eq(lastfmTracks.artistId, lastfmArtists.id))
          .leftJoin(
            lastfmScrobbles,
            eq(lastfmScrobbles.trackId, lastfmTracks.id)
          )
          .where(
            and(
              inArray(
                lastfmArtists.id,
                similarRaw.map((s) => s.artist_id)
              ),
              sql`(${lastfmTracks.isFiltered} = 0 OR ${lastfmTracks.isFiltered} IS NULL)`
            )
          )
          .groupBy(lastfmArtists.id)
      : [];
  const similarMetaById = new Map(
    similarPlaycountRows.map((r) => [
      r.id,
      { playcount: r.playcount ?? 0, genre: r.genre ?? null },
    ])
  );
  const similar_artists = similarRaw
    .filter((s) => similarMetaById.has(s.artist_id))
    .slice(0, 10)
    .map((s) => {
      const meta = similarMetaById.get(s.artist_id);
      return {
        id: s.artist_id,
        name: s.name,
        genre: meta?.genre ?? null,
        your_scrobble_count: meta?.playcount ?? 0,
        similarity_score: s.similarity_score,
        image: similarImageMap.get(String(s.artist_id)) ?? null,
      };
    });

  // Sparkline — overall window, yearly granularity. Falls back to null
  // when the artist has no scrobbles (shouldn't normally happen but the
  // schema allows it).
  let sparkline: {
    granularity: 'year';
    points: Array<{ at: string; count: number }>;
  } | null = null;
  if (aggregates?.first) {
    const earliestYear = new Date(aggregates.first).getUTCFullYear();
    const currentYear = new Date().getUTCFullYear();
    if (Number.isFinite(earliestYear) && earliestYear <= currentYear) {
      const window = overallToWindow(earliestYear, currentYear);
      const seriesMap = await buildSparklinesForWindow(
        db,
        [id],
        window,
        'artist'
      );
      const series = seriesMap.get(id);
      if (series) {
        sparkline = {
          granularity: 'year',
          points: window.bucketKeys.map((key, i) => ({
            at: `${key}-01-01T00:00:00.000Z`,
            count: series.points[i] ?? 0,
          })),
        };
      }
    }
  }

  return c.json({
    id: artist.id,
    name: artist.name,
    mbid: artist.mbid,
    url: artist.url,
    apple_music_url: artist.appleMusicUrl ?? null,
    playcount: artist.playcount,
    scrobble_count: aggregates?.count ?? 0,
    first_scrobbled_at: aggregates?.first ?? null,
    last_played_at: aggregates?.last ?? null,
    all_time_rank: overallRank?.rank ?? null,
    distinct_tracks: aggregates?.distinctTracks ?? 0,
    distinct_albums: albumCount?.distinctAlbums ?? 0,
    genre: artist.genre ?? null,
    tags: artist.tags ? JSON.parse(artist.tags) : null,
    bio_summary: bioSummary ?? null,
    bio_content: bioContent ?? null,
    bio_synced_at: bioSyncedAt ?? null,
    image: artistImage,
    sparkline,
    top_albums: topAlbums.map((a) => ({
      id: a.id,
      name: a.name,
      playcount: a.playcount,
      apple_music_url: a.appleMusicUrl ?? null,
      image: albumImageMap.get(String(a.id)) ?? null,
    })),
    top_tracks: topTracks.map((t) => ({
      id: t.id,
      name: t.name,
      album_id: t.albumId,
      album_name: t.albumName ?? null,
      scrobble_count: t.scrobbleCount,
      apple_music_url: t.appleMusicUrl ?? null,
      preview_url: t.previewUrl ?? null,
      image: t.albumId ? (albumImageMap.get(String(t.albumId)) ?? null) : null,
    })),
    similar_artists,
  });
});

// GET /v1/listening/albums/:id
listening.openapi(albumDetailRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) return badRequest(c, 'Invalid album ID') as any;

  const [album] = await db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      mbid: lastfmAlbums.mbid,
      url: lastfmAlbums.url,
      appleMusicUrl: lastfmAlbums.appleMusicUrl,
      playcount: lastfmAlbums.playcount,
      artistId: lastfmArtists.id,
      artistName: lastfmArtists.name,
    })
    .from(lastfmAlbums)
    .innerJoin(lastfmArtists, eq(lastfmAlbums.artistId, lastfmArtists.id))
    .where(eq(lastfmAlbums.id, id))
    .limit(1);

  if (!album) return notFound(c, 'Album not found') as any;

  // Get tracks on this album with scrobble counts (exclude filtered)
  const tracks = await db
    .select({
      id: lastfmTracks.id,
      name: lastfmTracks.name,
      appleMusicUrl: lastfmTracks.appleMusicUrl,
      previewUrl: lastfmTracks.previewUrl,
      scrobbleCount: sql<number>`count(${lastfmScrobbles.id})`,
    })
    .from(lastfmTracks)
    .leftJoin(lastfmScrobbles, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(and(eq(lastfmTracks.albumId, id), eq(lastfmTracks.isFiltered, 0)))
    .groupBy(lastfmTracks.id)
    .orderBy(desc(sql`count(${lastfmScrobbles.id})`));

  const albumImage = await getImageAttachment(
    db,
    'listening',
    'albums',
    String(id)
  );

  // First scrobbled date
  const [firstAlbumScrobble] = await db
    .select({
      firstScrobbledAt: sql<string>`min(${lastfmScrobbles.scrobbledAt})`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(and(eq(lastfmTracks.albumId, id), eq(lastfmTracks.isFiltered, 0)));

  return c.json({
    id: album.id,
    name: album.name,
    mbid: album.mbid,
    url: album.url,
    apple_music_url: album.appleMusicUrl ?? null,
    playcount: album.playcount,
    first_scrobbled_at: firstAlbumScrobble?.firstScrobbledAt ?? null,
    image: albumImage,
    artist: {
      id: album.artistId,
      name: album.artistName,
    },
    tracks: tracks.map((t) => ({
      id: t.id,
      name: t.name,
      scrobble_count: t.scrobbleCount,
      apple_music_url: t.appleMusicUrl ?? null,
      preview_url: t.previewUrl ?? null,
    })),
  });
});

// GET /v1/listening/calendar
listening.openapi(calendarRoute, async (c) => {
  const db = createDb(c.env.DB);
  const currentYear = new Date().getFullYear();
  const yearParam = parseInt(c.req.query('year') ?? String(currentYear));

  if (isNaN(yearParam) || yearParam < 2000 || yearParam > currentYear + 1) {
    return badRequest(c, 'Invalid year') as any;
  }

  // Use longer cache for past years
  if (yearParam < currentYear) {
    setCache(c, 'long');
  } else {
    setCache(c, 'medium');
  }

  const startDate = `${yearParam}-01-01T00:00:00.000Z`;
  const endDate = `${yearParam + 1}-01-01T00:00:00.000Z`;

  const days = await db
    .select({
      date: sql<string>`date(${lastfmScrobbles.scrobbledAt})`,
      count: sql<number>`count(*)`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(
      and(
        gte(lastfmScrobbles.scrobbledAt, startDate),
        lte(lastfmScrobbles.scrobbledAt, endDate),
        eq(lastfmTracks.isFiltered, 0)
      )
    )
    .groupBy(sql`date(${lastfmScrobbles.scrobbledAt})`)
    .orderBy(asc(sql`date(${lastfmScrobbles.scrobbledAt})`));

  const total = days.reduce((sum, d) => sum + d.count, 0);
  const maxDay = days.reduce((max, d) => (d.count > max.count ? d : max), {
    date: '',
    count: 0,
  });

  return c.json({
    year: yearParam,
    days: days.map((d) => ({ date: d.date, count: d.count })),
    total,
    max_day: { date: maxDay.date, count: maxDay.count },
  });
});

// GET /v1/listening/trends
listening.openapi(trendsRoute, async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);

  const metric = c.req.query('metric') ?? 'scrobbles';
  const from = c.req.query('from');
  const to = c.req.query('to');

  if (!['scrobbles', 'artists', 'albums', 'tracks'].includes(metric)) {
    return badRequest(
      c,
      'Invalid metric. Valid: scrobbles, artists, albums, tracks'
    ) as any;
  }

  // Always exclude filtered tracks
  const conditions = [eq(lastfmTracks.isFiltered, 0)];
  if (from) conditions.push(gte(lastfmScrobbles.scrobbledAt, from));
  if (to) conditions.push(lte(lastfmScrobbles.scrobbledAt, to));

  const whereClause = and(...conditions);

  if (metric === 'scrobbles') {
    const data = await db
      .select({
        month: sql<string>`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`,
        count: sql<number>`count(*)`,
      })
      .from(lastfmScrobbles)
      .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
      .where(whereClause)
      .groupBy(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`)
      .orderBy(asc(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`));

    return c.json({
      metric,
      data: data.map((d) => ({ period: d.month, value: d.count })),
    });
  }

  if (metric === 'artists') {
    const data = await db
      .select({
        month: sql<string>`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`,
        count: sql<number>`count(distinct ${lastfmTracks.artistId})`,
      })
      .from(lastfmScrobbles)
      .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
      .where(whereClause)
      .groupBy(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`)
      .orderBy(asc(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`));

    return c.json({
      metric,
      data: data.map((d) => ({ period: d.month, value: d.count })),
    });
  }

  if (metric === 'albums') {
    const data = await db
      .select({
        month: sql<string>`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`,
        count: sql<number>`count(distinct ${lastfmTracks.albumId})`,
      })
      .from(lastfmScrobbles)
      .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
      .where(whereClause)
      .groupBy(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`)
      .orderBy(asc(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`));

    return c.json({
      metric,
      data: data.map((d) => ({ period: d.month, value: d.count })),
    });
  }

  // tracks
  const data = await db
    .select({
      month: sql<string>`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`,
      count: sql<number>`count(distinct ${lastfmScrobbles.trackId})`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(whereClause)
    .groupBy(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`)
    .orderBy(asc(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`));

  return c.json({
    metric,
    data: data.map((d) => ({ period: d.month, value: d.count })),
  });
});

// GET /v1/listening/streaks
listening.openapi(streaksRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  // Get all unique scrobble dates ordered (exclude filtered)
  const dates = await db
    .select({
      date: sql<string>`date(${lastfmScrobbles.scrobbledAt})`,
      count: sql<number>`count(*)`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(eq(lastfmTracks.isFiltered, 0))
    .groupBy(sql`date(${lastfmScrobbles.scrobbledAt})`)
    .orderBy(asc(sql`date(${lastfmScrobbles.scrobbledAt})`));

  if (dates.length === 0) {
    return c.json({
      current: { days: 0, start_date: null, total_scrobbles: 0 },
      longest: {
        days: 0,
        start_date: null,
        end_date: null,
        total_scrobbles: 0,
      },
    });
  }

  // Compute streaks
  let longestStreak = { days: 1, startIdx: 0, endIdx: 0, scrobbles: 0 };
  let tempStreak = {
    days: 1,
    startIdx: 0,
    endIdx: 0,
    scrobbles: dates[0].count,
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
      tempStreak.scrobbles += dates[i].count;
    } else {
      if (tempStreak.days > longestStreak.days) {
        longestStreak = { ...tempStreak };
      }
      tempStreak = {
        days: 1,
        startIdx: i,
        endIdx: i,
        scrobbles: dates[i].count,
      };
    }
  }

  // Check final streak
  if (tempStreak.days > longestStreak.days) {
    longestStreak = { ...tempStreak };
  }

  // Determine current streak (must include today or yesterday)
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const lastDate = dates[dates.length - 1].date;

  const currentStreak =
    lastDate === today || lastDate === yesterday
      ? { ...tempStreak }
      : { days: 0, startIdx: 0, endIdx: 0, scrobbles: 0 };

  return c.json({
    current: {
      days: currentStreak.days,
      start_date:
        currentStreak.days > 0 ? dates[currentStreak.startIdx].date : null,
      total_scrobbles: currentStreak.scrobbles,
    },
    longest: {
      days: longestStreak.days,
      start_date: dates[longestStreak.startIdx].date,
      end_date: dates[longestStreak.endIdx].date,
      total_scrobbles: longestStreak.scrobbles,
    },
  });
});

// GET /v1/listening/year/:year - Year-in-review for listening
// GET /v1/listening/years
listening.openapi(yearsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  // LEFT JOIN to lastfm_artists so we can return the top artist's name
  // alongside its id; falls back to null if the artist row is missing
  // (shouldn't happen in practice but the join handles it safely).
  const rows = await db
    .select({
      year: lastfmYearlyStats.year,
      scrobbles: lastfmYearlyStats.scrobbles,
      uniqueArtists: lastfmYearlyStats.uniqueArtists,
      uniqueAlbums: lastfmYearlyStats.uniqueAlbums,
      uniqueTracks: lastfmYearlyStats.uniqueTracks,
      topArtistId: lastfmYearlyStats.topArtistId,
      topArtistName: lastfmArtists.name,
    })
    .from(lastfmYearlyStats)
    .leftJoin(
      lastfmArtists,
      eq(lastfmYearlyStats.topArtistId, lastfmArtists.id)
    )
    .where(eq(lastfmYearlyStats.userId, 1))
    .orderBy(desc(lastfmYearlyStats.year));

  return c.json({
    data: rows.map((r) => ({
      year: r.year,
      total_scrobbles: r.scrobbles,
      unique_artists: r.uniqueArtists,
      unique_albums: r.uniqueAlbums,
      unique_tracks: r.uniqueTracks,
      top_artist:
        r.topArtistId != null && r.topArtistName != null
          ? { id: r.topArtistId, name: r.topArtistName }
          : null,
    })),
  });
});

listening.openapi(yearRoute, async (c) => {
  const db = createDb(c.env.DB);
  const currentYear = new Date().getFullYear();
  const year = parseInt(c.req.param('year'));

  const monthParam = c.req.query('month')
    ? parseInt(c.req.query('month')!)
    : undefined;
  const includeSparklinesParam = c.req.query('include_sparklines');
  const includeSparklines =
    includeSparklinesParam === 'true' || includeSparklinesParam === '1';

  if (isNaN(year) || year < 2000 || year > currentYear + 1) {
    return badRequest(c, 'Invalid year') as any;
  }
  if (monthParam !== undefined && (monthParam < 1 || monthParam > 12)) {
    return badRequest(c, 'Invalid month (1-12)') as any;
  }

  if (year < currentYear) {
    setCache(c, 'long');
  } else {
    setCache(c, 'medium');
  }

  let startDate: string;
  let endDate: string;
  if (monthParam) {
    const mm = String(monthParam).padStart(2, '0');
    startDate = `${year}-${mm}-01T00:00:00.000Z`;
    // Next month (handles December → next year)
    const nextMonth = monthParam === 12 ? 1 : monthParam + 1;
    const nextYear = monthParam === 12 ? year + 1 : year;
    const nmm = String(nextMonth).padStart(2, '0');
    endDate = `${nextYear}-${nmm}-01T00:00:00.000Z`;
  } else {
    startDate = `${year}-01-01T00:00:00.000Z`;
    endDate = `${year + 1}-01-01T00:00:00.000Z`;
  }
  const dateRange = and(
    gte(lastfmScrobbles.scrobbledAt, startDate),
    lte(lastfmScrobbles.scrobbledAt, endDate)
  );

  // Filtered date range — excludes audiobooks/holiday music (both track and artist level)
  const filteredDateRange = and(
    dateRange,
    eq(lastfmTracks.isFiltered, 0),
    eq(lastfmArtists.isFiltered, 0)
  );

  // Five aggregates fan out in parallel against the same filtered date
  // range. Each one is its own scan over scrobbles+tracks+artists, so
  // running them sequentially burned up to ~6x the round-trip cost on
  // cache miss for a heavy listening year.
  const totalsPromise = db
    .select({
      total: sql<number>`count(*)`,
      artists: sql<number>`count(distinct ${lastfmTracks.artistId})`,
      albums: sql<number>`count(distinct ${lastfmTracks.albumId})`,
      tracks: sql<number>`count(distinct ${lastfmScrobbles.trackId})`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .where(filteredDateRange);

  const topArtistsPromise = db
    .select({
      id: lastfmArtists.id,
      name: lastfmArtists.name,
      appleMusicUrl: lastfmArtists.appleMusicUrl,
      scrobbles: sql<number>`count(*)`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .where(filteredDateRange)
    .groupBy(lastfmArtists.id)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  const topAlbumsPromise = db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      appleMusicUrl: lastfmAlbums.appleMusicUrl,
      artistName: lastfmArtists.name,
      scrobbles: sql<number>`count(*)`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmAlbums, eq(lastfmTracks.albumId, lastfmAlbums.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .where(filteredDateRange)
    .groupBy(lastfmAlbums.id)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  const topTracksPromise = db
    .select({
      id: lastfmTracks.id,
      name: lastfmTracks.name,
      appleMusicUrl: lastfmTracks.appleMusicUrl,
      previewUrl: lastfmTracks.previewUrl,
      artistName: lastfmArtists.name,
      scrobbles: sql<number>`count(*)`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .where(filteredDateRange)
    .groupBy(lastfmTracks.id)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  // Monthly breakdown (skip when scoped to a single month). Reads from
  // the precomputed lastfm_monthly_stats table (refreshed daily by the
  // top-lists cron) instead of running a live GROUP-BY over scrobbles.
  // Indexed lookup against ~12 rows; previously the heaviest query in
  // this handler.
  const monthlyBreakdownPromise = monthParam
    ? Promise.resolve(
        [] as Array<{
          month: string;
          scrobbles: number;
          artists: number;
          albums: number;
        }>
      )
    : db
        .select({
          month: lastfmMonthlyStats.yearMonth,
          scrobbles: lastfmMonthlyStats.scrobbles,
          artists: lastfmMonthlyStats.uniqueArtists,
          albums: lastfmMonthlyStats.uniqueAlbums,
        })
        .from(lastfmMonthlyStats)
        .where(
          and(
            eq(lastfmMonthlyStats.userId, 1),
            like(lastfmMonthlyStats.yearMonth, `${year}-%`)
          )
        )
        .orderBy(asc(lastfmMonthlyStats.yearMonth));

  const [totalsRows, topArtists, topAlbums, topTracks, monthlyBreakdown] =
    await Promise.all([
      totalsPromise,
      topArtistsPromise,
      topAlbumsPromise,
      topTracksPromise,
      monthlyBreakdownPromise,
    ]);
  const totalsRow = totalsRows[0] ?? {
    total: 0,
    artists: 0,
    albums: 0,
    tracks: 0,
  };
  const totalScrobbles = totalsRow.total;
  const uniqueCounts = {
    artists: totalsRow.artists,
    albums: totalsRow.albums,
    tracks: totalsRow.tracks,
  };

  // Image attachments fan out in parallel after the top lists land.
  const artistIds = topArtists.map((a) => String(a.id));
  const albumIds = topAlbums.map((a) => String(a.id));
  const numericArtistIds = topArtists.map((a) => a.id);
  const numericAlbumIds = topAlbums.map((a) => a.id);
  const numericTrackIds = topTracks.map((t) => t.id);

  const sparklineWindow = includeSparklines
    ? monthParam
      ? yearMonthToWindow(year, monthParam)
      : yearToWindow(year)
    : null;

  const [
    artistImageMap,
    albumImageMap,
    artistSparklineMap,
    albumSparklineMap,
    trackSparklineMap,
  ] = await Promise.all([
    getImageAttachmentBatch(db, 'listening', 'artists', artistIds),
    getImageAttachmentBatch(db, 'listening', 'albums', albumIds),
    sparklineWindow
      ? buildSparklinesForWindow(
          db,
          numericArtistIds,
          sparklineWindow,
          'artist'
        )
      : Promise.resolve(undefined),
    sparklineWindow
      ? buildSparklinesForWindow(db, numericAlbumIds, sparklineWindow, 'album')
      : Promise.resolve(undefined),
    sparklineWindow
      ? buildSparklinesForWindow(db, numericTrackIds, sparklineWindow, 'track')
      : Promise.resolve(undefined),
  ]);

  return c.json({
    year,
    ...(monthParam ? { month: monthParam } : {}),
    total_scrobbles: totalScrobbles,
    unique_artists: uniqueCounts.artists,
    unique_albums: uniqueCounts.albums,
    unique_tracks: uniqueCounts.tracks,
    top_artists: topArtists.map((a) => {
      const sparkline = artistSparklineMap?.get(a.id);
      return {
        id: a.id,
        name: a.name,
        scrobbles: a.scrobbles,
        apple_music_url: a.appleMusicUrl ?? null,
        image: artistImageMap.get(String(a.id)) ?? null,
        ...(sparkline ? { sparkline } : {}),
      };
    }),
    top_albums: topAlbums.map((a) => {
      const sparkline = albumSparklineMap?.get(a.id);
      return {
        id: a.id,
        name: a.name,
        artist: a.artistName,
        scrobbles: a.scrobbles,
        apple_music_url: a.appleMusicUrl ?? null,
        image: albumImageMap.get(String(a.id)) ?? null,
        ...(sparkline ? { sparkline } : {}),
      };
    }),
    top_tracks: topTracks.map((t) => {
      const sparkline = trackSparklineMap?.get(t.id);
      return {
        id: t.id,
        name: t.name,
        artist: t.artistName,
        scrobbles: t.scrobbles,
        apple_music_url: t.appleMusicUrl ?? null,
        preview_url: t.previewUrl ?? null,
        ...(sparkline ? { sparkline } : {}),
      };
    }),
    monthly: monthlyBreakdown.map((m) => ({
      month: m.month,
      scrobbles: m.scrobbles,
      unique_artists: m.artists,
      unique_albums: m.albums,
    })),
  });
});

// GET /v1/listening/genres
listening.openapi(genresRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const groupBy = c.req.query('group_by') ?? 'month';
  const genreLimit = Math.min(
    Math.max(1, parseInt(c.req.query('limit') ?? '10')),
    50
  );

  // Build date format string based on group_by
  let dateFormat: string;
  switch (groupBy) {
    case 'week':
      // ISO week: YYYY-WNN
      dateFormat = `strftime('%Y-W%W', ${lastfmScrobbles.scrobbledAt.name})`;
      break;
    case 'year':
      dateFormat = `strftime('%Y', ${lastfmScrobbles.scrobbledAt.name})`;
      break;
    default:
      dateFormat = `strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt.name})`;
  }

  const queryParams = c.req.query();
  const dateCondition = buildDateCondition(
    lastfmScrobbles.scrobbledAt,
    queryParams
  );

  const compareTo = c.req.query('compare_to');
  const compareCondition =
    compareTo === 'previous_year'
      ? buildDateCondition(
          lastfmScrobbles.scrobbledAt,
          shiftDateFiltersByYears(queryParams, -1)
        )
      : null;

  const [data, compare] = await Promise.all([
    aggregateGenres(db, dateFormat, dateCondition, genreLimit),
    compareCondition
      ? aggregateGenres(db, dateFormat, compareCondition, genreLimit)
      : Promise.resolve(null),
  ]);

  return c.json({ data, ...(compare ? { compare } : {}) });
});

// Shift the `date`/`from`/`to` query params by N years (positive = forward,
// negative = backward). Returns a new params object, leaving non-date keys
// unchanged. Used by the genres endpoint's `compare_to=previous_year` flag
// to reuse the same buildDateCondition path against a year-shifted window.
function shiftDateFiltersByYears(
  params: Record<string, string | undefined>,
  years: number
): Record<string, string | undefined> {
  const shift = (iso: string | undefined): string | undefined => {
    if (!iso) return iso;
    // Accept either YYYY-MM-DD or full ISO 8601; preserve the time component
    // when present so endpoints relying on hour-precision still align.
    const datePart = iso.slice(0, 10);
    const timePart = iso.length > 10 ? iso.slice(10) : '';
    const [y, m, d] = datePart.split('-').map((s) => parseInt(s, 10));
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
      return iso;
    }
    const shiftedYear = y + years;
    // Day-clamp for Feb 29 -> Feb 28 in non-leap target years.
    const daysInTargetMonth = new Date(
      Date.UTC(shiftedYear, m, 0)
    ).getUTCDate();
    const clampedDay = Math.min(d, daysInTargetMonth);
    const yyyy = String(shiftedYear).padStart(4, '0');
    const mm = String(m).padStart(2, '0');
    const dd = String(clampedDay).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}${timePart}`;
  };

  return {
    ...params,
    date: shift(params.date),
    from: shift(params.from),
    to: shift(params.to),
  };
}

async function aggregateGenres(
  db: Database,
  dateFormat: string,
  dateCondition: ReturnType<typeof buildDateCondition>,
  genreLimit: number
): Promise<
  Array<{ period: string; genres: Record<string, number>; total: number }>
> {
  const conditions = [
    eq(lastfmTracks.isFiltered, 0),
    sql`${lastfmArtists.genre} IS NOT NULL`,
  ];
  if (dateCondition) conditions.push(dateCondition);

  const rows = await db
    .select({
      period: sql<string>`${sql.raw(dateFormat)}`.as('period'),
      genre: lastfmArtists.genre,
      count: sql<number>`count(*)`.as('count'),
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .where(and(...conditions))
    .groupBy(sql.raw(dateFormat), lastfmArtists.genre)
    .orderBy(sql.raw(dateFormat), desc(sql`count(*)`));

  const periodMap = new Map<
    string,
    { genres: Record<string, number>; total: number }
  >();

  for (const row of rows) {
    if (!row.period || !row.genre) continue;
    let entry = periodMap.get(row.period);
    if (!entry) {
      entry = { genres: {}, total: 0 };
      periodMap.set(row.period, entry);
    }
    entry.genres[row.genre] = (entry.genres[row.genre] || 0) + row.count;
    entry.total += row.count;
  }

  return Array.from(periodMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, { genres, total }]) => {
      const sorted = Object.entries(genres).sort(([, a], [, b]) => b - a);
      const topGenres: Record<string, number> = {};
      let otherCount = 0;

      for (let i = 0; i < sorted.length; i++) {
        if (i < genreLimit) {
          topGenres[sorted[i][0]] = sorted[i][1];
        } else {
          otherCount += sorted[i][1];
        }
      }

      if (otherCount > 0) {
        topGenres['Other'] = otherCount;
      }

      return { period, genres: topGenres, total };
    });
}

// POST /v1/admin/sync/listening -- moved to admin-sync.ts
// Old path /v1/listening/admin/sync redirects via admin-sync.ts

// All listening admin routes require an admin key. These live at
// /v1/listening/admin/* (not /v1/admin/*), so the global gate in index.ts
// does not catch them -- guard them here, as reading.ts does.
listening.use('/admin/*', requireAuth('admin'));

// GET /v1/admin/listening/filters
listening.openapi(listFiltersRoute, async (c) => {
  const db = createDb(c.env.DB);

  const rows = await db
    .select()
    .from(lastfmFilters)
    .where(eq(lastfmFilters.userId, 1))
    .orderBy(lastfmFilters.filterType, lastfmFilters.scope);

  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      filter_type: r.filterType,
      pattern: r.pattern,
      scope: r.scope,
      reason: r.reason,
      created_at: r.createdAt,
    })),
  });
});

// POST /v1/admin/listening/filters
listening.openapi(createFilterRoute, async (c) => {
  try {
    const db = createDb(c.env.DB);
    const body = await c.req.json<{
      filter_type: string;
      pattern: string;
      scope: string;
      reason?: string;
    }>();

    if (!body.filter_type || !body.pattern || !body.scope) {
      return badRequest(
        c,
        'filter_type, pattern, and scope are required'
      ) as any;
    }

    const validTypes = ['holiday', 'audiobook', 'custom'];
    if (!validTypes.includes(body.filter_type)) {
      return badRequest(
        c,
        `Invalid filter_type. Valid: ${validTypes.join(', ')}`
      ) as any;
    }

    const validScopes = [
      'album',
      'track',
      'artist',
      'artist_track',
      'track_regex',
    ];
    if (!validScopes.includes(body.scope)) {
      return badRequest(
        c,
        `Invalid scope. Valid: ${validScopes.join(', ')}`
      ) as any;
    }

    const [inserted] = await db
      .insert(lastfmFilters)
      .values({
        userId: 1,
        filterType: body.filter_type,
        pattern: body.pattern,
        scope: body.scope,
        reason: body.reason || null,
      })
      .returning();

    return c.json(
      {
        id: inserted.id,
        filter_type: inserted.filterType,
        pattern: inserted.pattern,
        scope: inserted.scope,
        reason: inserted.reason,
        created_at: inserted.createdAt,
      },
      201
    );
  } catch (err) {
    console.log(`[ERROR] POST /admin/listening/filters: ${err}`);
    return serverError(c) as any;
  }
});

// DELETE /v1/admin/listening/filters/:id
listening.openapi(deleteFilterRoute, async (c) => {
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return badRequest(c, 'Invalid filter ID') as any;

  const existing = await db
    .select({ id: lastfmFilters.id })
    .from(lastfmFilters)
    .where(eq(lastfmFilters.id, id))
    .limit(1);

  if (existing.length === 0) {
    return notFound(c, 'Filter not found') as any;
  }

  await db.delete(lastfmFilters).where(eq(lastfmFilters.id, id));

  return c.json({ success: true, deleted_id: id });
});

// ─── Admin: Backfill images ─────────────────────────────────────────

listening.openapi(backfillImagesRoute, async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req
    .json<{
      type?: string;
      limit?: number;
      retry?: boolean;
      artist?: string;
    }>()
    .catch(() => ({
      type: undefined,
      limit: undefined,
      retry: undefined,
      artist: undefined,
    }));

  const entityType = body.type || 'albums';
  if (!['albums', 'artists', 'all'].includes(entityType)) {
    return badRequest(c, 'Invalid type. Valid: albums, artists, all') as any;
  }
  const maxItems = Math.min(body.limit || 50, 200);
  const retry = body.retry === true;
  const artistFilter = body.artist?.trim();

  const results: Record<string, unknown> = {};

  if (entityType === 'albums' || entityType === 'all') {
    let albumRows;

    if (retry) {
      // Find albums whose image lookup previously failed (source='none' placeholder)
      const conditions = [
        eq(lastfmAlbums.isFiltered, 0),
        sql`${lastfmAlbums.id} IN (
          SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
          WHERE ${images.domain} = 'listening' AND ${images.entityType} = 'albums'
            AND ${images.source} = 'none'
        )`,
      ];
      if (artistFilter) {
        conditions.push(
          sql`LOWER(${lastfmArtists.name}) LIKE ${`%${artistFilter.toLowerCase()}%`}`
        );
      }
      albumRows = await db
        .select({
          id: lastfmAlbums.id,
          name: lastfmAlbums.name,
          mbid: lastfmAlbums.mbid,
          artistName: lastfmArtists.name,
        })
        .from(lastfmAlbums)
        .innerJoin(lastfmArtists, eq(lastfmAlbums.artistId, lastfmArtists.id))
        .where(and(...conditions))
        .limit(maxItems);

      // Delete the 'none' placeholders so the pipeline can insert fresh records
      if (albumRows.length > 0) {
        const entityIds = albumRows.map((a) => String(a.id));
        await db.delete(images).where(
          and(
            eq(images.domain, 'listening'),
            eq(images.entityType, 'albums'),
            eq(images.source, 'none'),
            sql`${images.entityId} IN (${sql.join(
              entityIds.map((id) => sql`${id}`),
              sql`, `
            )})`
          )
        );
      }
    } else {
      // Normal backfill: find albums with no image record at all
      const conditions = [
        eq(lastfmAlbums.isFiltered, 0),
        sql`${lastfmAlbums.id} NOT IN (
          SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
          WHERE ${images.domain} = 'listening' AND ${images.entityType} = 'albums'
        )`,
      ];
      if (artistFilter) {
        conditions.push(
          sql`LOWER(${lastfmArtists.name}) LIKE ${`%${artistFilter.toLowerCase()}%`}`
        );
      }
      albumRows = await db
        .select({
          id: lastfmAlbums.id,
          name: lastfmAlbums.name,
          mbid: lastfmAlbums.mbid,
          artistName: lastfmArtists.name,
        })
        .from(lastfmAlbums)
        .innerJoin(lastfmArtists, eq(lastfmAlbums.artistId, lastfmArtists.id))
        .where(and(...conditions))
        .limit(maxItems);
    }

    const albumItems: BackfillItem[] = albumRows.map((a) => ({
      entityId: String(a.id),
      albumName: a.name,
      artistName: a.artistName,
      mbid: a.mbid ?? undefined,
    }));

    const albumResult = await backfillImages(
      db,
      c.env,
      'listening',
      'albums',
      albumItems,
      { batchSize: 5, delayMs: 500 }
    );
    results.albums = albumResult;
  }

  if (entityType === 'artists' || entityType === 'all') {
    let artistRows;

    if (retry) {
      const conditions = [
        eq(lastfmArtists.isFiltered, 0),
        sql`${lastfmArtists.id} IN (
          SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
          WHERE ${images.domain} = 'listening' AND ${images.entityType} = 'artists'
            AND ${images.source} = 'none'
        )`,
      ];
      if (artistFilter) {
        conditions.push(
          sql`LOWER(${lastfmArtists.name}) LIKE ${`%${artistFilter.toLowerCase()}%`}`
        );
      }
      artistRows = await db
        .select({
          id: lastfmArtists.id,
          name: lastfmArtists.name,
          mbid: lastfmArtists.mbid,
        })
        .from(lastfmArtists)
        .where(and(...conditions))
        .limit(maxItems);

      if (artistRows.length > 0) {
        const entityIds = artistRows.map((a) => String(a.id));
        await db.delete(images).where(
          and(
            eq(images.domain, 'listening'),
            eq(images.entityType, 'artists'),
            eq(images.source, 'none'),
            sql`${images.entityId} IN (${sql.join(
              entityIds.map((id) => sql`${id}`),
              sql`, `
            )})`
          )
        );
      }
    } else {
      const conditions = [
        eq(lastfmArtists.isFiltered, 0),
        sql`${lastfmArtists.id} NOT IN (
          SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
          WHERE ${images.domain} = 'listening' AND ${images.entityType} = 'artists'
        )`,
      ];
      if (artistFilter) {
        conditions.push(
          sql`LOWER(${lastfmArtists.name}) LIKE ${`%${artistFilter.toLowerCase()}%`}`
        );
      }
      artistRows = await db
        .select({
          id: lastfmArtists.id,
          name: lastfmArtists.name,
          mbid: lastfmArtists.mbid,
        })
        .from(lastfmArtists)
        .where(and(...conditions))
        .limit(maxItems);
    }

    const artistItems: BackfillItem[] = artistRows.map((a) => ({
      entityId: String(a.id),
      artistName: a.name,
      mbid: a.mbid ?? undefined,
    }));

    const artistResult = await backfillImages(
      db,
      c.env,
      'listening',
      'artists',
      artistItems,
      { batchSize: 5, delayMs: 500 }
    );
    results.artists = artistResult;
  }

  return c.json({ success: true, results });
});

// POST /v1/listening/admin/enrich-apple-music
const enrichAppleMusicRoute = createRoute({
  method: 'post',
  path: '/admin/enrich-apple-music',
  operationId: 'enrichListeningAppleMusic',
  'x-hidden': true,
  tags: ['Listening', 'Admin'],
  summary: 'Enrich tracks with Apple Music URLs',
  description:
    'Enriches unenriched tracks with Apple Music deep links and preview audio via iTunes Search API.',
  responses: {
    200: {
      description: 'Enrichment results',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            results: z.object({
              total: z.number(),
              succeeded: z.number(),
              skipped: z.number(),
              failed: z.number(),
            }),
          }),
        },
      },
    },
    ...errorResponses(401),
  },
});

listening.openapi(enrichAppleMusicRoute, async (c) => {
  const db = createDb(c.env.DB);
  const limit = Math.min(
    Math.max(1, parseInt(c.req.query('limit') ?? '50', 10)),
    200
  );

  const results = await enrichBatch(db, limit);
  return c.json({ success: true, results });
});

// POST /v1/listening/admin/enrich-artists
const enrichArtistsRoute = createRoute({
  method: 'post',
  path: '/admin/enrich-artists',
  operationId: 'enrichListeningArtists',
  'x-hidden': true,
  tags: ['Listening', 'Admin'],
  summary: 'Enrich artists with Apple Music URLs via direct iTunes lookup',
  description:
    'Fallback for artists the track-driven enrichBatch path cannot reach. ' +
    'Searches iTunes with entity=musicArtist and writes apple_music_id + ' +
    'apple_music_url on a name match. Retries rows whose last attempt was ' +
    '>30 days ago.',
  responses: {
    200: {
      description: 'Enrichment results',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            results: z.object({
              total: z.number(),
              succeeded: z.number(),
              skipped: z.number(),
              failed: z.number(),
            }),
          }),
        },
      },
    },
    ...errorResponses(401),
  },
});

listening.openapi(enrichArtistsRoute, async (c) => {
  const db = createDb(c.env.DB);
  const limit = Math.min(
    Math.max(1, parseInt(c.req.query('limit') ?? '100', 10)),
    500
  );

  const results = await enrichArtistsByName(db, limit);
  return c.json({ success: true, results });
});

// POST /v1/listening/admin/refresh-artist-images
const refreshArtistImagesRoute = createRoute({
  method: 'post',
  path: '/admin/refresh-artist-images',
  operationId: 'refreshListeningArtistImages',
  'x-hidden': true,
  tags: ['Listening', 'Admin'],
  summary: 'Refresh artist images via stored Apple Music id',
  description:
    'Deterministic-by-id fetch against the Apple Music catalog for ' +
    'artists that have an apple_music_id but no image row (or a stale ' +
    'null-source placeholder). Bypasses the name-search waterfall.',
  responses: {
    200: {
      description: 'Image refresh results',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            results: z.object({
              domain: z.string(),
              entityType: z.string(),
              queued: z.number(),
              succeeded: z.number(),
              skipped: z.number(),
              failed: z.number(),
            }),
          }),
        },
      },
    },
    ...errorResponses(401),
  },
});

listening.openapi(refreshArtistImagesRoute, async (c) => {
  const db = createDb(c.env.DB);
  const limit = Math.min(
    Math.max(1, parseInt(c.req.query('limit') ?? '100', 10)),
    500
  );

  const results = await refreshArtistImageFromAppleMusicId(db, c.env, limit);
  return c.json({ success: true, results });
});

export default listening;
