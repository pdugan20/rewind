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
import { notFound, badRequest, serverError } from '../lib/errors.js';
import {
  getImageAttachment,
  getImageAttachmentBatch,
} from '../lib/images.js';
import { images } from '../db/schema/system.js';
import { LastfmClient } from '../services/lastfm/client.js';
import type { LastfmPeriod } from '../services/lastfm/client.js';
import { backfillImages } from '../services/images/backfill.js';
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
  period: z.enum(['7day', '1month', '3month', '6month', '12month', 'overall']).optional().default('7day').openapi({ example: '7day' }),
  page: z.coerce.number().int().min(1).optional().default(1).openapi({ example: 1 }),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10).openapi({ example: 10 }),
});

const TopItemSchema = z.object({
  rank: z.number(),
  id: z.number(),
  name: z.string(),
  detail: z.string(),
  playcount: z.number(),
  image: z.any().nullable(),
  url: z.string(),
});

const NowPlayingSchema = z.object({
  is_playing: z.boolean(),
  track: z.any().nullable(),
  scrobbled_at: z.string().nullable(),
});

const ScrobbleSchema = z.object({
  track: z.object({ id: z.number(), name: z.string(), url: z.string().nullable() }),
  artist: z.object({ id: z.number(), name: z.string() }),
  album: z.object({ id: z.number().nullable(), name: z.string().nullable(), image: z.any().nullable() }),
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
  url: z.string(),
  image: z.any().nullable(),
});

const AlbumBrowseSchema = z.object({
  id: z.number(),
  name: z.string(),
  artist: z.object({ id: z.number(), name: z.string() }),
  playcount: z.number().nullable(),
  url: z.string(),
  image: z.any().nullable(),
});

const ArtistDetailSchema = z.object({
  id: z.number(),
  name: z.string(),
  mbid: z.string().nullable(),
  url: z.string().nullable(),
  playcount: z.number(),
  scrobble_count: z.number(),
  image: z.any().nullable(),
  top_albums: z.array(z.object({
    id: z.number(),
    name: z.string(),
    playcount: z.number(),
    image: z.any().nullable(),
  })),
  top_tracks: z.array(z.object({
    id: z.number(),
    name: z.string(),
    scrobble_count: z.number(),
  })),
});

const AlbumDetailSchema = z.object({
  id: z.number(),
  name: z.string(),
  mbid: z.string().nullable(),
  url: z.string().nullable(),
  playcount: z.number(),
  image: z.any().nullable(),
  artist: z.object({ id: z.number(), name: z.string() }),
  tracks: z.array(z.object({
    id: z.number(),
    name: z.string(),
    scrobble_count: z.number(),
  })),
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
  total_scrobbles: z.number(),
  unique_artists: z.number(),
  unique_albums: z.number(),
  unique_tracks: z.number(),
  top_artists: z.array(z.object({
    id: z.number(),
    name: z.string(),
    scrobbles: z.number(),
    image: z.any().nullable(),
  })),
  top_albums: z.array(z.object({
    id: z.number(),
    name: z.string(),
    artist: z.string(),
    scrobbles: z.number(),
    image: z.any().nullable(),
  })),
  top_tracks: z.array(z.object({
    id: z.number(),
    name: z.string(),
    artist: z.string(),
    scrobbles: z.number(),
  })),
  monthly: z.array(z.object({
    month: z.string(),
    scrobbles: z.number(),
    unique_artists: z.number(),
    unique_albums: z.number(),
  })),
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
  tags: ['Listening'],
  summary: 'Now playing',
  description: 'Returns the currently playing or most recently scrobbled track from Last.fm.',
  responses: {
    200: {
      description: 'Now playing info',
      content: { 'application/json': { schema: NowPlayingSchema } },
    },
    ...errorResponses(401),
  },
});

const recentRoute = createRoute({
  method: 'get',
  path: '/recent',
  tags: ['Listening'],
  summary: 'Recent scrobbles',
  description: 'Returns the most recent scrobbles.',
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).optional().default(10).openapi({ example: 10 }),
    }),
  },
  responses: {
    200: {
      description: 'Recent scrobbles',
      content: { 'application/json': { schema: z.object({ data: z.array(ScrobbleSchema) }) } },
    },
    ...errorResponses(401),
  },
});

const topArtistsRoute = createRoute({
  method: 'get',
  path: '/top/artists',
  tags: ['Listening'],
  summary: 'Top artists',
  description: 'Returns top artists for a given time period.',
  request: { query: PeriodQuery },
  responses: {
    200: {
      description: 'Top artists list',
      content: { 'application/json': { schema: z.object({ period: z.string(), data: z.array(TopItemSchema), pagination: PaginationMeta }) } },
    },
    ...errorResponses(400, 401),
  },
});

const topAlbumsRoute = createRoute({
  method: 'get',
  path: '/top/albums',
  tags: ['Listening'],
  summary: 'Top albums',
  description: 'Returns top albums for a given time period.',
  request: { query: PeriodQuery },
  responses: {
    200: {
      description: 'Top albums list',
      content: { 'application/json': { schema: z.object({ period: z.string(), data: z.array(TopItemSchema), pagination: PaginationMeta }) } },
    },
    ...errorResponses(400, 401),
  },
});

const topTracksRoute = createRoute({
  method: 'get',
  path: '/top/tracks',
  tags: ['Listening'],
  summary: 'Top tracks',
  description: 'Returns top tracks for a given time period.',
  request: { query: PeriodQuery },
  responses: {
    200: {
      description: 'Top tracks list',
      content: { 'application/json': { schema: z.object({ period: z.string(), data: z.array(TopItemSchema), pagination: PaginationMeta }) } },
    },
    ...errorResponses(400, 401),
  },
});

const statsRoute = createRoute({
  method: 'get',
  path: '/stats',
  tags: ['Listening'],
  summary: 'Listening stats',
  description: 'Returns overall listening statistics.',
  responses: {
    200: {
      description: 'Listening statistics',
      content: { 'application/json': { schema: StatsSchema } },
    },
    ...errorResponses(401),
  },
});

const historyRoute = createRoute({
  method: 'get',
  path: '/history',
  tags: ['Listening'],
  summary: 'Scrobble history',
  description: 'Returns paginated scrobble history with optional filters.',
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional().default(1).openapi({ example: 1 }),
      limit: z.coerce.number().int().min(1).max(200).optional().default(50).openapi({ example: 50 }),
      from: z.string().optional().openapi({ example: '2024-01-01T00:00:00.000Z' }),
      to: z.string().optional().openapi({ example: '2024-12-31T23:59:59.999Z' }),
      artist: z.string().optional().openapi({ example: 'Radiohead' }),
      album: z.string().optional().openapi({ example: 'OK Computer' }),
    }),
  },
  responses: {
    200: {
      description: 'Scrobble history',
      content: { 'application/json': { schema: z.object({ data: z.array(ScrobbleSchema), pagination: PaginationMeta }) } },
    },
    ...errorResponses(401),
  },
});

const browseArtistsRoute = createRoute({
  method: 'get',
  path: '/artists',
  tags: ['Listening'],
  summary: 'Browse artists',
  description: 'Returns paginated list of all artists.',
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional().default(1).openapi({ example: 1 }),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20).openapi({ example: 20 }),
      sort: z.enum(['playcount', 'name']).optional().default('playcount').openapi({ example: 'playcount' }),
      order: z.enum(['asc', 'desc']).optional().default('desc').openapi({ example: 'desc' }),
      search: z.string().optional().openapi({ example: 'Radiohead' }),
    }),
  },
  responses: {
    200: {
      description: 'Artist list',
      content: { 'application/json': { schema: z.object({ data: z.array(ArtistBrowseSchema), pagination: PaginationMeta }) } },
    },
    ...errorResponses(401),
  },
});

const browseAlbumsRoute = createRoute({
  method: 'get',
  path: '/albums',
  tags: ['Listening'],
  summary: 'Browse albums',
  description: 'Returns paginated list of all albums.',
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional().default(1).openapi({ example: 1 }),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20).openapi({ example: 20 }),
      sort: z.enum(['playcount', 'name', 'recent']).optional().default('playcount').openapi({ example: 'playcount' }),
      order: z.enum(['asc', 'desc']).optional().default('desc').openapi({ example: 'desc' }),
      artist: z.string().optional().openapi({ example: 'Radiohead' }),
      search: z.string().optional().openapi({ example: 'OK Computer' }),
    }),
  },
  responses: {
    200: {
      description: 'Album list',
      content: { 'application/json': { schema: z.object({ data: z.array(AlbumBrowseSchema), pagination: PaginationMeta }) } },
    },
    ...errorResponses(401),
  },
});

const artistDetailRoute = createRoute({
  method: 'get',
  path: '/artists/{id}',
  tags: ['Listening'],
  summary: 'Artist detail',
  description: 'Returns detailed information about an artist including top albums and tracks.',
  request: { params: IdParamSchema },
  responses: {
    200: {
      description: 'Artist detail',
      content: { 'application/json': { schema: ArtistDetailSchema } },
    },
    ...errorResponses(400, 401, 404),
  },
});

const albumDetailRoute = createRoute({
  method: 'get',
  path: '/albums/{id}',
  tags: ['Listening'],
  summary: 'Album detail',
  description: 'Returns detailed information about an album including tracks.',
  request: { params: IdParamSchema },
  responses: {
    200: {
      description: 'Album detail',
      content: { 'application/json': { schema: AlbumDetailSchema } },
    },
    ...errorResponses(400, 401, 404),
  },
});

const calendarRoute = createRoute({
  method: 'get',
  path: '/calendar',
  tags: ['Listening'],
  summary: 'Scrobble calendar',
  description: 'Returns daily scrobble counts for a given year.',
  request: {
    query: z.object({
      year: z.coerce.number().int().optional().openapi({ example: 2024 }),
    }),
  },
  responses: {
    200: {
      description: 'Calendar data',
      content: { 'application/json': { schema: CalendarSchema } },
    },
    ...errorResponses(400, 401),
  },
});

const trendsRoute = createRoute({
  method: 'get',
  path: '/trends',
  tags: ['Listening'],
  summary: 'Listening trends',
  description: 'Returns monthly trend data for a given metric.',
  request: {
    query: z.object({
      metric: z.enum(['scrobbles', 'artists', 'albums', 'tracks']).optional().default('scrobbles').openapi({ example: 'scrobbles' }),
      from: z.string().optional().openapi({ example: '2024-01-01T00:00:00.000Z' }),
      to: z.string().optional().openapi({ example: '2024-12-31T23:59:59.999Z' }),
    }),
  },
  responses: {
    200: {
      description: 'Trend data',
      content: { 'application/json': { schema: TrendsSchema } },
    },
    ...errorResponses(400, 401),
  },
});

const streaksRoute = createRoute({
  method: 'get',
  path: '/streaks',
  tags: ['Listening'],
  summary: 'Listening streaks',
  description: 'Returns current and longest listening streaks.',
  responses: {
    200: {
      description: 'Streak data',
      content: { 'application/json': { schema: StreaksSchema } },
    },
    ...errorResponses(401),
  },
});

const yearRoute = createRoute({
  method: 'get',
  path: '/year/{year}',
  tags: ['Listening'],
  summary: 'Year in review',
  description: 'Returns year-in-review listening data.',
  request: { params: YearParamSchema },
  responses: {
    200: {
      description: 'Year in review data',
      content: { 'application/json': { schema: YearSchema } },
    },
    ...errorResponses(400, 401),
  },
});

const listFiltersRoute = createRoute({
  method: 'get',
  path: '/admin/filters',
  tags: ['Listening', 'Admin'],
  summary: 'List listening filters',
  description: 'Returns all listening filters.',
  responses: {
    200: {
      description: 'Filter list',
      content: { 'application/json': { schema: z.object({ data: z.array(FilterSchema) }) } },
    },
    ...errorResponses(401),
  },
});

const createFilterRoute = createRoute({
  method: 'post',
  path: '/admin/filters',
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
            reason: z.string().optional().openapi({ example: 'Seasonal music' }),
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
  tags: ['Listening', 'Admin'],
  summary: 'Delete listening filter',
  description: 'Deletes a listening filter by ID.',
  request: { params: IdParamSchema },
  responses: {
    200: {
      description: 'Filter deleted',
      content: { 'application/json': { schema: z.object({ success: z.boolean(), deleted_id: z.number() }) } },
    },
    ...errorResponses(400, 401, 404),
  },
});

const backfillImagesRoute = createRoute({
  method: 'post',
  path: '/admin/listening/backfill-images',
  tags: ['Listening', 'Admin'],
  summary: 'Backfill listening images',
  description: 'Backfills missing images for albums and/or artists.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            type: z.enum(['albums', 'artists', 'all']).optional().default('albums').openapi({ example: 'albums' }),
            limit: z.number().int().min(1).max(200).optional().default(50).openapi({ example: 50 }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Backfill results',
      content: { 'application/json': { schema: z.object({ success: z.boolean(), results: z.record(z.string(), z.unknown()) }) } },
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
      .select({ id: lastfmArtists.id, name: lastfmArtists.name })
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
        },
        album: {
          id: albumData?.id ?? null,
          name: latestTrack.album['#text'],
          image: albumImage,
        },
        url: latestTrack.url,
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

  const scrobbles = await db
    .select({
      scrobbledAt: lastfmScrobbles.scrobbledAt,
      trackName: lastfmTracks.name,
      trackUrl: lastfmTracks.url,
      trackId: lastfmTracks.id,
      artistName: lastfmArtists.name,
      artistId: lastfmArtists.id,
      albumName: lastfmAlbums.name,
      albumId: lastfmAlbums.id,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .leftJoin(lastfmAlbums, eq(lastfmTracks.albumId, lastfmAlbums.id))
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
      },
      artist: {
        id: s.artistId,
        name: s.artistName,
      },
      album: {
        id: s.albumId,
        name: s.albumName,
        image: s.albumId ? imageMap.get(String(s.albumId)) ?? null : null,
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
    return badRequest(c, `Invalid period. Valid: ${VALID_PERIODS.join(', ')}`) as any;
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
    .where(eq(lastfmTopArtists.period, period));

  const items = await db
    .select({
      rank: lastfmTopArtists.rank,
      playcount: lastfmTopArtists.playcount,
      artistId: lastfmArtists.id,
      artistName: lastfmArtists.name,
      artistUrl: lastfmArtists.url,
    })
    .from(lastfmTopArtists)
    .innerJoin(lastfmArtists, eq(lastfmTopArtists.artistId, lastfmArtists.id))
    .where(eq(lastfmTopArtists.period, period))
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
      image: imageMap.get(String(item.artistId)) ?? null,
      url: item.artistUrl ?? '',
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
    return badRequest(c, `Invalid period. Valid: ${VALID_PERIODS.join(', ')}`) as any;
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
    .where(eq(lastfmTopAlbums.period, period));

  const items = await db
    .select({
      rank: lastfmTopAlbums.rank,
      playcount: lastfmTopAlbums.playcount,
      albumId: lastfmAlbums.id,
      albumName: lastfmAlbums.name,
      albumUrl: lastfmAlbums.url,
      artistName: lastfmArtists.name,
    })
    .from(lastfmTopAlbums)
    .innerJoin(lastfmAlbums, eq(lastfmTopAlbums.albumId, lastfmAlbums.id))
    .innerJoin(lastfmArtists, eq(lastfmAlbums.artistId, lastfmArtists.id))
    .where(eq(lastfmTopAlbums.period, period))
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
    return badRequest(c, `Invalid period. Valid: ${VALID_PERIODS.join(', ')}`) as any;
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
    .where(eq(lastfmTopTracks.period, period));

  const items = await db
    .select({
      rank: lastfmTopTracks.rank,
      playcount: lastfmTopTracks.playcount,
      trackId: lastfmTracks.id,
      trackName: lastfmTracks.name,
      trackUrl: lastfmTracks.url,
      artistName: lastfmArtists.name,
    })
    .from(lastfmTopTracks)
    .innerJoin(lastfmTracks, eq(lastfmTopTracks.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .where(eq(lastfmTopTracks.period, period))
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
    })),
    pagination: paginate(page, limit, total),
  });
});

// GET /v1/listening/stats
listening.openapi(statsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

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

  // Build conditions
  const conditions = [];
  if (from) conditions.push(gte(lastfmScrobbles.scrobbledAt, from));
  if (to) conditions.push(lte(lastfmScrobbles.scrobbledAt, to));
  if (artistFilter)
    conditions.push(like(lastfmArtists.name, `%${artistFilter}%`));
  if (albumFilter) conditions.push(like(lastfmAlbums.name, `%${albumFilter}%`));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Count total
  const baseQuery = db
    .select({ count: sql<number>`count(*)` })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .leftJoin(lastfmAlbums, eq(lastfmTracks.albumId, lastfmAlbums.id));

  const [{ count: total }] = whereClause
    ? await baseQuery.where(whereClause)
    : await baseQuery;

  // Fetch page
  const dataQuery = db
    .select({
      scrobbledAt: lastfmScrobbles.scrobbledAt,
      trackName: lastfmTracks.name,
      trackUrl: lastfmTracks.url,
      trackId: lastfmTracks.id,
      artistName: lastfmArtists.name,
      artistId: lastfmArtists.id,
      albumName: lastfmAlbums.name,
      albumId: lastfmAlbums.id,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .leftJoin(lastfmAlbums, eq(lastfmTracks.albumId, lastfmAlbums.id))
    .orderBy(desc(lastfmScrobbles.scrobbledAt))
    .limit(limit)
    .offset(offset);

  const scrobbles = whereClause
    ? await dataQuery.where(whereClause)
    : await dataQuery;

  const albumIds = [
    ...new Set(
      scrobbles
        .map((s) => s.albumId)
        .filter((id): id is number => id !== null)
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
      track: { id: s.trackId, name: s.trackName, url: s.trackUrl },
      artist: { id: s.artistId, name: s.artistName },
      album: {
        id: s.albumId,
        name: s.albumName,
        image: s.albumId ? imageMap.get(String(s.albumId)) ?? null : null,
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
  const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') ?? '20')), 100);
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
    orderByClause = order === 'asc' ? asc(lastfmArtists.name) : desc(lastfmArtists.name);
  } else {
    orderByClause = order === 'asc' ? asc(lastfmArtists.playcount) : desc(lastfmArtists.playcount);
  }

  const items = await db
    .select({
      id: lastfmArtists.id,
      name: lastfmArtists.name,
      url: lastfmArtists.url,
      playcount: lastfmArtists.playcount,
    })
    .from(lastfmArtists)
    .where(whereClause)
    .orderBy(orderByClause)
    .limit(limit)
    .offset(offset);

  const artistIds = items.map((i) => String(i.id));
  const imageMap = await getImageAttachmentBatch(db, 'listening', 'artists', artistIds);

  return c.json({
    data: items.map((item) => ({
      id: item.id,
      name: item.name,
      playcount: item.playcount,
      url: item.url ?? '',
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
  const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') ?? '20')), 100);
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
    orderByClause = order === 'asc' ? asc(lastfmAlbums.name) : desc(lastfmAlbums.name);
  } else if (sort === 'recent') {
    orderByClause = order === 'asc' ? asc(lastfmAlbums.createdAt) : desc(lastfmAlbums.createdAt);
  } else {
    orderByClause = order === 'asc' ? asc(lastfmAlbums.playcount) : desc(lastfmAlbums.playcount);
  }

  const items = await db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      url: lastfmAlbums.url,
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
  const imageMap = await getImageAttachmentBatch(db, 'listening', 'albums', albumIds);

  return c.json({
    data: items.map((item) => ({
      id: item.id,
      name: item.name,
      artist: { id: item.artistId, name: item.artistName },
      playcount: item.playcount,
      url: item.url ?? '',
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

  // Get scrobble count
  const [scrobbleCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(eq(lastfmTracks.artistId, id));

  // Get top albums
  const topAlbums = await db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      playcount: lastfmAlbums.playcount,
    })
    .from(lastfmAlbums)
    .where(eq(lastfmAlbums.artistId, id))
    .orderBy(desc(lastfmAlbums.playcount))
    .limit(10);

  // Get top tracks
  const topTracks = await db
    .select({
      id: lastfmTracks.id,
      name: lastfmTracks.name,
      scrobbleCount: sql<number>`count(${lastfmScrobbles.id})`,
    })
    .from(lastfmTracks)
    .leftJoin(lastfmScrobbles, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(eq(lastfmTracks.artistId, id))
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

  return c.json({
    id: artist.id,
    name: artist.name,
    mbid: artist.mbid,
    url: artist.url,
    playcount: artist.playcount,
    scrobble_count: scrobbleCount.count,
    image: artistImage,
    top_albums: topAlbums.map((a) => ({
      id: a.id,
      name: a.name,
      playcount: a.playcount,
      image: albumImageMap.get(String(a.id)) ?? null,
    })),
    top_tracks: topTracks.map((t) => ({
      id: t.id,
      name: t.name,
      scrobble_count: t.scrobbleCount,
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
      playcount: lastfmAlbums.playcount,
      artistId: lastfmArtists.id,
      artistName: lastfmArtists.name,
    })
    .from(lastfmAlbums)
    .innerJoin(lastfmArtists, eq(lastfmAlbums.artistId, lastfmArtists.id))
    .where(eq(lastfmAlbums.id, id))
    .limit(1);

  if (!album) return notFound(c, 'Album not found') as any;

  // Get tracks on this album with scrobble counts
  const tracks = await db
    .select({
      id: lastfmTracks.id,
      name: lastfmTracks.name,
      scrobbleCount: sql<number>`count(${lastfmScrobbles.id})`,
    })
    .from(lastfmTracks)
    .leftJoin(lastfmScrobbles, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(eq(lastfmTracks.albumId, id))
    .groupBy(lastfmTracks.id)
    .orderBy(desc(sql`count(${lastfmScrobbles.id})`));

  const albumImage = await getImageAttachment(
    db,
    'listening',
    'albums',
    String(id)
  );

  return c.json({
    id: album.id,
    name: album.name,
    mbid: album.mbid,
    url: album.url,
    playcount: album.playcount,
    image: albumImage,
    artist: {
      id: album.artistId,
      name: album.artistName,
    },
    tracks: tracks.map((t) => ({
      id: t.id,
      name: t.name,
      scrobble_count: t.scrobbleCount,
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
    .where(
      and(
        gte(lastfmScrobbles.scrobbledAt, startDate),
        lte(lastfmScrobbles.scrobbledAt, endDate)
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

  const conditions = [];
  if (from) conditions.push(gte(lastfmScrobbles.scrobbledAt, from));
  if (to) conditions.push(lte(lastfmScrobbles.scrobbledAt, to));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  if (metric === 'scrobbles') {
    const baseQuery = db
      .select({
        month: sql<string>`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`,
        count: sql<number>`count(*)`,
      })
      .from(lastfmScrobbles)
      .groupBy(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`)
      .orderBy(asc(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`));

    const data = whereClause
      ? await baseQuery.where(whereClause)
      : await baseQuery;

    return c.json({
      metric,
      data: data.map((d) => ({ period: d.month, value: d.count })),
    });
  }

  if (metric === 'artists') {
    const baseQuery = db
      .select({
        month: sql<string>`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`,
        count: sql<number>`count(distinct ${lastfmTracks.artistId})`,
      })
      .from(lastfmScrobbles)
      .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
      .groupBy(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`)
      .orderBy(asc(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`));

    const data = whereClause
      ? await baseQuery.where(whereClause)
      : await baseQuery;

    return c.json({
      metric,
      data: data.map((d) => ({ period: d.month, value: d.count })),
    });
  }

  if (metric === 'albums') {
    const baseQuery = db
      .select({
        month: sql<string>`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`,
        count: sql<number>`count(distinct ${lastfmTracks.albumId})`,
      })
      .from(lastfmScrobbles)
      .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
      .groupBy(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`)
      .orderBy(asc(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`));

    const data = whereClause
      ? await baseQuery.where(whereClause)
      : await baseQuery;

    return c.json({
      metric,
      data: data.map((d) => ({ period: d.month, value: d.count })),
    });
  }

  // tracks
  const baseQuery = db
    .select({
      month: sql<string>`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`,
      count: sql<number>`count(distinct ${lastfmScrobbles.trackId})`,
    })
    .from(lastfmScrobbles)
    .groupBy(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`)
    .orderBy(asc(sql`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`));

  const data = whereClause
    ? await baseQuery.where(whereClause)
    : await baseQuery;

  return c.json({
    metric,
    data: data.map((d) => ({ period: d.month, value: d.count })),
  });
});

// GET /v1/listening/streaks
listening.openapi(streaksRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  // Get all unique scrobble dates ordered
  const dates = await db
    .select({
      date: sql<string>`date(${lastfmScrobbles.scrobbledAt})`,
      count: sql<number>`count(*)`,
    })
    .from(lastfmScrobbles)
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
  const dateRange = and(
    gte(lastfmScrobbles.scrobbledAt, startDate),
    lte(lastfmScrobbles.scrobbledAt, endDate)
  );

  // Total scrobbles
  const [{ count: totalScrobbles }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(lastfmScrobbles)
    .where(dateRange);

  // Unique counts
  const [uniqueCounts] = await db
    .select({
      artists: sql<number>`count(distinct ${lastfmTracks.artistId})`,
      albums: sql<number>`count(distinct ${lastfmTracks.albumId})`,
      tracks: sql<number>`count(distinct ${lastfmScrobbles.trackId})`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(dateRange);

  // Top artists
  const topArtists = await db
    .select({
      id: lastfmArtists.id,
      name: lastfmArtists.name,
      scrobbles: sql<number>`count(*)`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .where(dateRange)
    .groupBy(lastfmArtists.id)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  // Top albums
  const topAlbums = await db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      artistName: lastfmArtists.name,
      scrobbles: sql<number>`count(*)`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmAlbums, eq(lastfmTracks.albumId, lastfmAlbums.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .where(dateRange)
    .groupBy(lastfmAlbums.id)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  // Top tracks
  const topTracks = await db
    .select({
      id: lastfmTracks.id,
      name: lastfmTracks.name,
      artistName: lastfmArtists.name,
      scrobbles: sql<number>`count(*)`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .where(dateRange)
    .groupBy(lastfmTracks.id)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  // Monthly breakdown
  const monthlyBreakdown = await db
    .select({
      month: sql<string>`strftime('%Y-%m', ${lastfmScrobbles.scrobbledAt})`,
      scrobbles: sql<number>`count(*)`,
      artists: sql<number>`count(distinct ${lastfmTracks.artistId})`,
      albums: sql<number>`count(distinct ${lastfmTracks.albumId})`,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(dateRange)
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
    total_scrobbles: totalScrobbles,
    unique_artists: uniqueCounts.artists,
    unique_albums: uniqueCounts.albums,
    unique_tracks: uniqueCounts.tracks,
    top_artists: topArtists.map((a) => ({
      id: a.id,
      name: a.name,
      scrobbles: a.scrobbles,
      image: artistImageMap.get(String(a.id)) ?? null,
    })),
    top_albums: topAlbums.map((a) => ({
      id: a.id,
      name: a.name,
      artist: a.artistName,
      scrobbles: a.scrobbles,
      image: albumImageMap.get(String(a.id)) ?? null,
    })),
    top_tracks: topTracks.map((t) => ({
      id: t.id,
      name: t.name,
      artist: t.artistName,
      scrobbles: t.scrobbles,
    })),
    monthly: monthlyBreakdown.map((m) => ({
      month: m.month,
      scrobbles: m.scrobbles,
      unique_artists: m.artists,
      unique_albums: m.albums,
    })),
  });
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
      return badRequest(c, 'filter_type, pattern, and scope are required') as any;
    }

    const validTypes = ['holiday', 'audiobook', 'custom'];
    if (!validTypes.includes(body.filter_type)) {
      return badRequest(
        c,
        `Invalid filter_type. Valid: ${validTypes.join(', ')}`
      ) as any;
    }

    const validScopes = ['album', 'track', 'artist', 'artist_track', 'track_regex'];
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
    .json<{ type?: string; limit?: number }>()
    .catch(() => ({ type: undefined, limit: undefined }));

  const entityType = body.type || 'albums';
  if (!['albums', 'artists', 'all'].includes(entityType)) {
    return badRequest(c, 'Invalid type. Valid: albums, artists, all') as any;
  }
  const maxItems = Math.min(body.limit || 50, 200);

  const results: Record<string, unknown> = {};

  if (entityType === 'albums' || entityType === 'all') {
    const albumRows = await db
      .select({
        id: lastfmAlbums.id,
        name: lastfmAlbums.name,
        mbid: lastfmAlbums.mbid,
        artistName: lastfmArtists.name,
      })
      .from(lastfmAlbums)
      .innerJoin(lastfmArtists, eq(lastfmAlbums.artistId, lastfmArtists.id))
      .where(
        and(
          eq(lastfmAlbums.isFiltered, 0),
          sql`${lastfmAlbums.id} NOT IN (
            SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
            WHERE ${images.domain} = 'listening' AND ${images.entityType} = 'albums'
          )`
        )
      )
      .limit(maxItems);

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
    const artistRows = await db
      .select({
        id: lastfmArtists.id,
        name: lastfmArtists.name,
        mbid: lastfmArtists.mbid,
      })
      .from(lastfmArtists)
      .where(
        and(
          eq(lastfmArtists.isFiltered, 0),
          sql`${lastfmArtists.id} NOT IN (
            SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
            WHERE ${images.domain} = 'listening' AND ${images.entityType} = 'artists'
          )`
        )
      )
      .limit(maxItems);

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

export default listening;
