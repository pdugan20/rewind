import { Hono } from 'hono';
import { eq, and, desc, sql, gte, lte, like, asc } from 'drizzle-orm';
import type { Env } from '../types/env.js';
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
} from '../db/schema/lastfm.js';
import { setCache } from '../lib/cache.js';
import { notFound, badRequest } from '../lib/errors.js';
import { LastfmClient } from '../services/lastfm/client.js';
import { syncListening } from '../services/lastfm/sync.js';
import type { LastfmPeriod } from '../services/lastfm/client.js';

const listening = new Hono<{ Bindings: Env }>();

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

// GET /v1/listening/now-playing
listening.get('/now-playing', async (c) => {
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
      imageKey: string | null;
    } | null = null;
    if (latestTrack.album['#text'] && artist) {
      const [album] = await db
        .select({
          id: lastfmAlbums.id,
          name: lastfmAlbums.name,
          imageKey: lastfmAlbums.imageKey,
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
          image_url: albumData?.imageKey ?? null,
          thumbhash: null,
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
listening.get('/recent', async (c) => {
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
      albumImageKey: lastfmAlbums.imageKey,
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .innerJoin(lastfmArtists, eq(lastfmTracks.artistId, lastfmArtists.id))
    .leftJoin(lastfmAlbums, eq(lastfmTracks.albumId, lastfmAlbums.id))
    .orderBy(desc(lastfmScrobbles.scrobbledAt))
    .limit(limit);

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
        image_url: s.albumImageKey ?? null,
        thumbhash: null,
      },
      scrobbled_at: s.scrobbledAt,
    })),
  });
});

// GET /v1/listening/top/artists
listening.get('/top/artists', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const period = (c.req.query('period') ?? '7day') as LastfmPeriod;
  if (!VALID_PERIODS.includes(period)) {
    return badRequest(c, `Invalid period. Valid: ${VALID_PERIODS.join(', ')}`);
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
      artistImageKey: lastfmArtists.imageKey,
    })
    .from(lastfmTopArtists)
    .innerJoin(lastfmArtists, eq(lastfmTopArtists.artistId, lastfmArtists.id))
    .where(eq(lastfmTopArtists.period, period))
    .orderBy(asc(lastfmTopArtists.rank))
    .limit(limit)
    .offset(offset);

  return c.json({
    period,
    data: items.map((item) => ({
      rank: item.rank,
      id: item.artistId,
      name: item.artistName,
      detail: '',
      playcount: item.playcount,
      image_url: item.artistImageKey ?? null,
      thumbhash: null,
      url: item.artistUrl ?? '',
    })),
    pagination: paginate(page, limit, total),
  });
});

// GET /v1/listening/top/albums
listening.get('/top/albums', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const period = (c.req.query('period') ?? '7day') as LastfmPeriod;
  if (!VALID_PERIODS.includes(period)) {
    return badRequest(c, `Invalid period. Valid: ${VALID_PERIODS.join(', ')}`);
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
      albumImageKey: lastfmAlbums.imageKey,
      artistName: lastfmArtists.name,
    })
    .from(lastfmTopAlbums)
    .innerJoin(lastfmAlbums, eq(lastfmTopAlbums.albumId, lastfmAlbums.id))
    .innerJoin(lastfmArtists, eq(lastfmAlbums.artistId, lastfmArtists.id))
    .where(eq(lastfmTopAlbums.period, period))
    .orderBy(asc(lastfmTopAlbums.rank))
    .limit(limit)
    .offset(offset);

  return c.json({
    period,
    data: items.map((item) => ({
      rank: item.rank,
      id: item.albumId,
      name: item.albumName,
      detail: item.artistName,
      playcount: item.playcount,
      image_url: item.albumImageKey ?? null,
      thumbhash: null,
      url: item.albumUrl ?? '',
    })),
    pagination: paginate(page, limit, total),
  });
});

// GET /v1/listening/top/tracks
listening.get('/top/tracks', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const period = (c.req.query('period') ?? '7day') as LastfmPeriod;
  if (!VALID_PERIODS.includes(period)) {
    return badRequest(c, `Invalid period. Valid: ${VALID_PERIODS.join(', ')}`);
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
      image_url: null,
      thumbhash: null,
      url: item.trackUrl ?? '',
    })),
    pagination: paginate(page, limit, total),
  });
});

// GET /v1/listening/stats
listening.get('/stats', async (c) => {
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
listening.get('/history', async (c) => {
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
      albumImageKey: lastfmAlbums.imageKey,
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

  return c.json({
    data: scrobbles.map((s) => ({
      track: { id: s.trackId, name: s.trackName, url: s.trackUrl },
      artist: { id: s.artistId, name: s.artistName },
      album: {
        id: s.albumId,
        name: s.albumName,
        image_url: s.albumImageKey ?? null,
        thumbhash: null,
      },
      scrobbled_at: s.scrobbledAt,
    })),
    pagination: paginate(page, limit, total),
  });
});

// GET /v1/listening/artists/:id
listening.get('/artists/:id', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) return badRequest(c, 'Invalid artist ID');

  const [artist] = await db
    .select()
    .from(lastfmArtists)
    .where(eq(lastfmArtists.id, id))
    .limit(1);

  if (!artist) return notFound(c, 'Artist not found');

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
      imageKey: lastfmAlbums.imageKey,
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

  return c.json({
    id: artist.id,
    name: artist.name,
    mbid: artist.mbid,
    url: artist.url,
    playcount: artist.playcount,
    scrobble_count: scrobbleCount.count,
    image_url: artist.imageKey ?? null,
    thumbhash: null,
    top_albums: topAlbums.map((a) => ({
      id: a.id,
      name: a.name,
      playcount: a.playcount,
      image_url: a.imageKey ?? null,
      thumbhash: null,
    })),
    top_tracks: topTracks.map((t) => ({
      id: t.id,
      name: t.name,
      scrobble_count: t.scrobbleCount,
    })),
  });
});

// GET /v1/listening/albums/:id
listening.get('/albums/:id', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) return badRequest(c, 'Invalid album ID');

  const [album] = await db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      mbid: lastfmAlbums.mbid,
      url: lastfmAlbums.url,
      playcount: lastfmAlbums.playcount,
      imageKey: lastfmAlbums.imageKey,
      artistId: lastfmArtists.id,
      artistName: lastfmArtists.name,
    })
    .from(lastfmAlbums)
    .innerJoin(lastfmArtists, eq(lastfmAlbums.artistId, lastfmArtists.id))
    .where(eq(lastfmAlbums.id, id))
    .limit(1);

  if (!album) return notFound(c, 'Album not found');

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

  return c.json({
    id: album.id,
    name: album.name,
    mbid: album.mbid,
    url: album.url,
    playcount: album.playcount,
    image_url: album.imageKey ?? null,
    thumbhash: null,
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
listening.get('/calendar', async (c) => {
  const db = createDb(c.env.DB);
  const currentYear = new Date().getFullYear();
  const yearParam = parseInt(c.req.query('year') ?? String(currentYear));

  if (isNaN(yearParam) || yearParam < 2000 || yearParam > currentYear + 1) {
    return badRequest(c, 'Invalid year');
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
listening.get('/trends', async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);

  const metric = c.req.query('metric') ?? 'scrobbles';
  const from = c.req.query('from');
  const to = c.req.query('to');

  if (!['scrobbles', 'artists', 'albums', 'tracks'].includes(metric)) {
    return badRequest(
      c,
      'Invalid metric. Valid: scrobbles, artists, albums, tracks'
    );
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
listening.get('/streaks', async (c) => {
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

// POST /v1/admin/sync/listening
listening.post('/admin/sync', async (c) => {
  const db = createDb(c.env.DB);
  const client = new LastfmClient(c.env.LASTFM_API_KEY, c.env.LASTFM_USERNAME);

  const body = await c.req
    .json<{ type?: string }>()
    .catch(() => ({ type: undefined }));
  const syncType = (body.type ?? 'scrobbles') as
    | 'scrobbles'
    | 'top_lists'
    | 'stats'
    | 'full'
    | 'backfill';

  const validTypes = ['scrobbles', 'top_lists', 'stats', 'full', 'backfill'];
  if (!validTypes.includes(syncType)) {
    return badRequest(c, `Invalid sync type. Valid: ${validTypes.join(', ')}`);
  }

  try {
    const result = await syncListening(db, client, { type: syncType });
    return c.json({
      status: 'completed',
      items_synced: result.itemsSynced,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, status: 500 }, 500);
  }
});

export default listening;
