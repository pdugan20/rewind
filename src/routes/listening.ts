import { createRoute, z } from '@hono/zod-openapi';
import { eq, and, desc, sql, gte, lte, like, asc } from 'drizzle-orm';
import { createDb } from '../db/client.js';
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
} from '../db/schema/lastfm.js';
import { setCache } from '../lib/cache.js';
import { DateFilterQuery, buildDateCondition } from '../lib/date-filters.js';
import { notFound, badRequest, serverError } from '../lib/errors.js';
import { getImageAttachment, getImageAttachmentBatch } from '../lib/images.js';
import { images } from '../db/schema/system.js';
import { LastfmClient } from '../services/lastfm/client.js';
import type { LastfmPeriod } from '../services/lastfm/client.js';
import { backfillImages } from '../services/images/backfill.js';
import { enrichBatch } from '../services/itunes/enrich.js';
import type { BackfillItem } from '../services/images/backfill.js';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses, PaginationMeta } from '../lib/schemas/common.js';

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

const ArtistDetailSchema = z.object({
  id: z.number(),
  name: z.string(),
  mbid: z.string().nullable(),
  url: z.string().nullable(),
  apple_music_url: z.string().nullable(),
  playcount: z.number(),
  scrobble_count: z.number(),
  genre: z.string().nullable(),
  tags: z.array(NormalizedTagSchema).nullable(),
  image: z.any().nullable(),
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
      scrobble_count: z.number(),
      apple_music_url: z.string().nullable(),
      preview_url: z.string().nullable(),
    })
  ),
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
    'Returns the most recent scrobbles. Supports date filtering via date, from, and to params.',
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
  description: 'Returns top artists for a given time period.',
  request: { query: PeriodQuery },
  responses: {
    200: {
      description: 'Top artists list',
      content: {
        'application/json': {
          schema: z.object({
            period: z.string(),
            data: z.array(TopItemSchema),
            pagination: PaginationMeta,
          }),
          example: {
            period: 'overall',
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
  description: 'Returns top albums for a given time period.',
  request: { query: PeriodQuery },
  responses: {
    200: {
      description: 'Top albums list',
      content: {
        'application/json': {
          schema: z.object({
            period: z.string(),
            data: z.array(TopItemSchema),
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
  description: 'Returns top tracks for a given time period.',
  request: { query: PeriodQuery },
  responses: {
    200: {
      description: 'Top tracks list',
      content: {
        'application/json': {
          schema: z.object({
            period: z.string(),
            data: z.array(TopItemSchema),
            pagination: PaginationMeta,
          }),
          example: {
            period: 'overall',
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
            genre: 'Grunge',
            tags: [
              { name: 'Grunge', count: 100 },
              { name: 'Rock', count: 49 },
            ],
            image: {
              url: 'https://cdn.rewind.rest/listening/artists/189/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
              thumbhash: 'GggGBwDN+CSBp7VXcmVmlyZ2BgAAAAAA',
              dominant_color: '#191919',
              accent_color: '#7e7e7e',
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
                scrobble_count: 101,
                apple_music_url:
                  'https://music.apple.com/us/album/come-as-you-are/1440783617?i=1440783636&uo=4',
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
    'Returns genre breakdown over time, grouped by period. Designed for stacked bar charts.',
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
    }),
  },
  responses: {
    200: {
      description: 'Genre breakdown by period',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(GenrePeriodSchema) }),
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
    const response = await client.getRecentTracks({ limit: 1 });
    const tracks = response.recenttracks.track;

    if (!tracks || tracks.length === 0) {
      return c.json({ is_playing: false, track: null, scrobbled_at: null });
    }

    const latestTrack = tracks[0];
    const isPlaying = latestTrack['@attr']?.nowplaying === 'true';

    // Look up artist and album in DB for IDs
    const [artist] = await db
      .select({
        id: lastfmArtists.id,
        name: lastfmArtists.name,
        appleMusicUrl: lastfmArtists.appleMusicUrl,
      })
      .from(lastfmArtists)
      .where(eq(lastfmArtists.name, latestTrack.artist['#text']))
      .limit(1);

    let albumData: {
      id: number;
      name: string;
    } | null = null;
    if (latestTrack.album['#text'] && artist) {
      const [album] = await db
        .select({
          id: lastfmAlbums.id,
          name: lastfmAlbums.name,
        })
        .from(lastfmAlbums)
        .where(
          and(
            eq(lastfmAlbums.name, latestTrack.album['#text']),
            eq(lastfmAlbums.artistId, artist.id)
          )
        )
        .limit(1);
      albumData = album ?? null;
    }

    // Look up track in DB for Apple Music data
    let trackData: {
      id: number;
      appleMusicUrl: string | null;
      previewUrl: string | null;
    } | null = null;
    if (artist) {
      const [track] = await db
        .select({
          id: lastfmTracks.id,
          appleMusicUrl: lastfmTracks.appleMusicUrl,
          previewUrl: lastfmTracks.previewUrl,
        })
        .from(lastfmTracks)
        .where(
          and(
            eq(lastfmTracks.name, latestTrack.name),
            eq(lastfmTracks.artistId, artist.id)
          )
        )
        .limit(1);
      trackData = track ?? null;
    }

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
          name: latestTrack.album['#text'],
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
    .limit(limit);

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

  const [{ count: total }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(lastfmTopArtists)
    .innerJoin(lastfmArtists, eq(lastfmTopArtists.artistId, lastfmArtists.id))
    .where(
      and(eq(lastfmTopArtists.period, period), eq(lastfmArtists.isFiltered, 0))
    );

  const items = await db
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
      and(eq(lastfmTopArtists.period, period), eq(lastfmArtists.isFiltered, 0))
    )
    .orderBy(asc(lastfmTopArtists.rank))
    .limit(limit)
    .offset(offset);

  const artistIds = items.map((i) => String(i.artistId));
  const imageMap = await getImageAttachmentBatch(
    db,
    'listening',
    'artists',
    artistIds
  );

  return c.json({
    period,
    data: items.map((item) => ({
      rank: item.rank,
      id: item.artistId,
      name: item.artistName,
      detail: '',
      playcount: item.playcount,
      genre: item.artistGenre ?? null,
      image: imageMap.get(String(item.artistId)) ?? null,
      url: item.artistUrl ?? '',
      apple_music_url: item.artistAppleMusicUrl ?? null,
    })),
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
  const imageMap = await getImageAttachmentBatch(
    db,
    'listening',
    'albums',
    albumIds
  );

  return c.json({
    period,
    data: items.map((item) => ({
      rank: item.rank,
      id: item.albumId,
      name: item.albumName,
      detail: item.artistName,
      playcount: item.playcount,
      image: imageMap.get(String(item.albumId)) ?? null,
      url: item.albumUrl ?? '',
      apple_music_url: item.albumAppleMusicUrl ?? null,
    })),
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

  const [{ count: total }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(lastfmTopTracks)
    .innerJoin(lastfmTracks, eq(lastfmTopTracks.trackId, lastfmTracks.id))
    .where(
      and(eq(lastfmTopTracks.period, period), eq(lastfmTracks.isFiltered, 0))
    );

  const items = await db
    .select({
      rank: lastfmTopTracks.rank,
      playcount: lastfmTopTracks.playcount,
      trackId: lastfmTracks.id,
      trackName: lastfmTracks.name,
      trackUrl: lastfmTracks.url,
      trackAppleMusicUrl: lastfmTracks.appleMusicUrl,
      trackPreviewUrl: lastfmTracks.previewUrl,
      artistName: lastfmArtists.name,
    })
    .from(lastfmTopTracks)
    .innerJoin(lastfmTracks, eq(lastfmTopTracks.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .where(
      and(eq(lastfmTopTracks.period, period), eq(lastfmTracks.isFiltered, 0))
    )
    .orderBy(asc(lastfmTopTracks.rank))
    .limit(limit)
    .offset(offset);

  return c.json({
    period,
    data: items.map((item) => ({
      rank: item.rank,
      id: item.trackId,
      name: item.trackName,
      detail: item.artistName,
      playcount: item.playcount,
      image: null,
      url: item.trackUrl ?? '',
      apple_music_url: item.trackAppleMusicUrl ?? null,
      preview_url: item.trackPreviewUrl ?? null,
    })),
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

  // Get scrobble count (exclude filtered tracks)
  const [scrobbleCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(and(eq(lastfmTracks.artistId, id), eq(lastfmTracks.isFiltered, 0)));

  // Get top albums (exclude filtered)
  const topAlbums = await db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      playcount: lastfmAlbums.playcount,
      appleMusicUrl: lastfmAlbums.appleMusicUrl,
    })
    .from(lastfmAlbums)
    .where(and(eq(lastfmAlbums.artistId, id), eq(lastfmAlbums.isFiltered, 0)))
    .orderBy(desc(lastfmAlbums.playcount))
    .limit(10);

  // Get top tracks (exclude filtered)
  const topTracks = await db
    .select({
      id: lastfmTracks.id,
      name: lastfmTracks.name,
      appleMusicUrl: lastfmTracks.appleMusicUrl,
      previewUrl: lastfmTracks.previewUrl,
      scrobbleCount: sql<number>`count(${lastfmScrobbles.id})`,
    })
    .from(lastfmTracks)
    .leftJoin(lastfmScrobbles, eq(lastfmScrobbles.trackId, lastfmTracks.id))
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
  const albumIds = topAlbums.map((a) => String(a.id));
  const albumImageMap = await getImageAttachmentBatch(
    db,
    'listening',
    'albums',
    albumIds
  );

  // First scrobbled date
  const [firstScrobble] = await db
    .select({
      firstScrobbledAt: sql<string>`min(${lastfmScrobbles.scrobbledAt})`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(and(eq(lastfmTracks.artistId, id), eq(lastfmTracks.isFiltered, 0)));

  return c.json({
    id: artist.id,
    name: artist.name,
    mbid: artist.mbid,
    url: artist.url,
    apple_music_url: artist.appleMusicUrl ?? null,
    playcount: artist.playcount,
    scrobble_count: scrobbleCount.count,
    first_scrobbled_at: firstScrobble?.firstScrobbledAt ?? null,
    genre: artist.genre ?? null,
    tags: artist.tags ? JSON.parse(artist.tags) : null,
    image: artistImage,
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
      scrobble_count: t.scrobbleCount,
      apple_music_url: t.appleMusicUrl ?? null,
      preview_url: t.previewUrl ?? null,
    })),
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
listening.openapi(yearRoute, async (c) => {
  const db = createDb(c.env.DB);
  const currentYear = new Date().getFullYear();
  const year = parseInt(c.req.param('year'));

  const monthParam = c.req.query('month')
    ? parseInt(c.req.query('month')!)
    : undefined;

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

  // Total scrobbles
  const [{ count: totalScrobbles }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .where(filteredDateRange);

  // Unique counts
  const [uniqueCounts] = await db
    .select({
      artists: sql<number>`count(distinct ${lastfmTracks.artistId})`,
      albums: sql<number>`count(distinct ${lastfmTracks.albumId})`,
      tracks: sql<number>`count(distinct ${lastfmScrobbles.trackId})`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .where(filteredDateRange);

  // Top artists
  const topArtists = await db
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

  // Top albums
  const topAlbums = await db
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

  // Top tracks
  const topTracks = await db
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

  // Monthly breakdown (skip when scoped to a single month)
  const monthlyBreakdown = monthParam
    ? []
    : await db
        .select({
          month: sql<string>`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`,
          scrobbles: sql<number>`count(*)`,
          artists: sql<number>`count(distinct ${lastfmTracks.artistId})`,
          albums: sql<number>`count(distinct ${lastfmTracks.albumId})`,
        })
        .from(lastfmScrobbles)
        .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
        .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
        .where(filteredDateRange)
        .groupBy(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`)
        .orderBy(asc(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`));

  // Batch fetch images
  const artistIds = topArtists.map((a) => String(a.id));
  const albumIds = topAlbums.map((a) => String(a.id));
  const [artistImageMap, albumImageMap] = await Promise.all([
    getImageAttachmentBatch(db, 'listening', 'artists', artistIds),
    getImageAttachmentBatch(db, 'listening', 'albums', albumIds),
  ]);

  return c.json({
    year,
    ...(monthParam ? { month: monthParam } : {}),
    total_scrobbles: totalScrobbles,
    unique_artists: uniqueCounts.artists,
    unique_albums: uniqueCounts.albums,
    unique_tracks: uniqueCounts.tracks,
    top_artists: topArtists.map((a) => ({
      id: a.id,
      name: a.name,
      scrobbles: a.scrobbles,
      apple_music_url: a.appleMusicUrl ?? null,
      image: artistImageMap.get(String(a.id)) ?? null,
    })),
    top_albums: topAlbums.map((a) => ({
      id: a.id,
      name: a.name,
      artist: a.artistName,
      scrobbles: a.scrobbles,
      apple_music_url: a.appleMusicUrl ?? null,
      image: albumImageMap.get(String(a.id)) ?? null,
    })),
    top_tracks: topTracks.map((t) => ({
      id: t.id,
      name: t.name,
      artist: t.artistName,
      scrobbles: t.scrobbles,
      apple_music_url: t.appleMusicUrl ?? null,
      preview_url: t.previewUrl ?? null,
    })),
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

  const dateCondition = buildDateCondition(
    lastfmScrobbles.scrobbledAt,
    c.req.query()
  );

  const conditions = [
    eq(lastfmTracks.isFiltered, 0),
    sql`${lastfmArtists.genre} IS NOT NULL`,
  ];
  if (dateCondition) conditions.push(dateCondition);

  // Query: group by period + genre, count scrobbles
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

  // Aggregate: for each period, take top N genres, sum rest as "Other"
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

  // Apply genre limit per period
  const data = Array.from(periodMap.entries())
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

  return c.json({ data });
});

// POST /v1/admin/sync/listening -- moved to admin-sync.ts
// Old path /v1/listening/admin/sync redirects via admin-sync.ts

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

export default listening;
