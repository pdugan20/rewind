import { Hono } from 'hono';
import { eq, sql, desc, asc, and, count } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import { createDb } from '../db/client.js';
import { setCache } from '../lib/cache.js';
import { notFound, badRequest } from '../lib/errors.js';
import {
  movies,
  genres,
  movieGenres,
  directors,
  movieDirectors,
  watchHistory,
  watchStats,
  plexShows,
  plexEpisodesWatched,
} from '../db/schema/watching.js';
import { computeWatchStats } from '../services/plex/sync.js';
import { TmdbClient } from '../services/watching/tmdb.js';
import { resolveMovie } from '../services/watching/resolve-movie.js';
import { backfillImages } from '../services/images/backfill.js';
import type { BackfillItem } from '../services/images/backfill.js';
import {
  getImageAttachment,
  getImageAttachmentBatch,
} from '../lib/images.js';
import type { ImageAttachment } from '../lib/images.js';
import { images } from '../db/schema/system.js';

const watching = new Hono<{ Bindings: Env }>();

// ─── Helper functions ────────────────────────────────────────────────

type Database = ReturnType<typeof createDb>;

function paginate(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    total_pages: Math.ceil(total / limit),
  };
}

function getMovieDirectors(db: Database, movieId: number) {
  return db
    .select({ name: directors.name })
    .from(movieDirectors)
    .innerJoin(directors, eq(movieDirectors.directorId, directors.id))
    .where(eq(movieDirectors.movieId, movieId));
}

function getMovieGenres(db: Database, movieId: number) {
  return db
    .select({ name: genres.name })
    .from(movieGenres)
    .innerJoin(genres, eq(movieGenres.genreId, genres.id))
    .where(eq(movieGenres.movieId, movieId));
}

interface MovieRow {
  id: number;
  title: string;
  year: number | null;
  runtime: number | null;
  contentRating: string | null;
  tmdbId: number | null;
  imdbId: string | null;
  tmdbRating: number | null;
  tagline: string | null;
  summary: string | null;
}

function formatMovie(
  movie: MovieRow,
  genreNames: string[],
  directorNames: string[],
  image: ImageAttachment | null = null
) {
  return {
    id: movie.id,
    title: movie.title,
    year: movie.year,
    director: directorNames[0] || null,
    directors: directorNames,
    genres: genreNames,
    duration_min: movie.runtime,
    rating: movie.contentRating,
    image,
    imdb_id: movie.imdbId,
    tmdb_id: movie.tmdbId,
    tmdb_rating: movie.tmdbRating,
    tagline: movie.tagline,
    summary: movie.summary,
  };
}

// ─── Recent watches ──────────────────────────────────────────────────

watching.get('/recent', async (c) => {
  setCache(c, 'realtime');
  const db = createDb(c.env.DB);
  const limit = Math.min(parseInt(c.req.query('limit') || '5'), 20);

  const recentWatches = await db
    .select({
      watchId: watchHistory.id,
      watchedAt: watchHistory.watchedAt,
      source: watchHistory.source,
      userRating: watchHistory.userRating,
      percentComplete: watchHistory.percentComplete,
      rewatch: watchHistory.rewatch,
      movieId: movies.id,
      title: movies.title,
      year: movies.year,
      runtime: movies.runtime,
      contentRating: movies.contentRating,
      tmdbId: movies.tmdbId,
      imdbId: movies.imdbId,
      tmdbRating: movies.tmdbRating,
      tagline: movies.tagline,
      summary: movies.summary,
    })
    .from(watchHistory)
    .innerJoin(movies, eq(watchHistory.movieId, movies.id))
    .orderBy(desc(watchHistory.watchedAt))
    .limit(limit);

  const movieIds = recentWatches.map((w) => String(w.movieId));
  const imageMap = await getImageAttachmentBatch(
    db,
    'watching',
    'movies',
    movieIds
  );

  const data = await Promise.all(
    recentWatches.map(async (w) => {
      const genreRows = await getMovieGenres(db, w.movieId);
      const directorRows = await getMovieDirectors(db, w.movieId);
      return {
        movie: formatMovie(
          {
            id: w.movieId,
            title: w.title,
            year: w.year,
            runtime: w.runtime,
            contentRating: w.contentRating,
            tmdbId: w.tmdbId,
            imdbId: w.imdbId,
            tmdbRating: w.tmdbRating,
            tagline: w.tagline,
            summary: w.summary,
          },
          genreRows.map((g) => g.name),
          directorRows.map((d) => d.name),
          imageMap.get(String(w.movieId)) ?? null
        ),
        watched_at: w.watchedAt,
        source: w.source,
        user_rating: w.userRating,
        percent_complete: w.percentComplete,
        rewatch: w.rewatch === 1,
      };
    })
  );

  return c.json({ data });
});

// ─── Movies list ─────────────────────────────────────────────────────

watching.get('/movies', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const page = Math.max(parseInt(c.req.query('page') || '1'), 1);
  const limit = Math.min(
    Math.max(parseInt(c.req.query('limit') || '20'), 1),
    100
  );
  const offset = (page - 1) * limit;
  const genre = c.req.query('genre');
  const decade = c.req.query('decade');
  const director = c.req.query('director');
  const year = c.req.query('year');
  const sort = c.req.query('sort') || 'watched_at';
  const order = c.req.query('order') || 'desc';

  // Build conditions
  const conditions = [];
  if (genre) {
    conditions.push(
      sql`${movies.id} IN (
        SELECT ${movieGenres.movieId} FROM ${movieGenres}
        INNER JOIN ${genres} ON ${movieGenres.genreId} = ${genres.id}
        WHERE ${genres.name} = ${genre}
      )`
    );
  }
  if (decade) {
    const decadeNum = parseInt(decade);
    conditions.push(
      sql`${movies.year} >= ${decadeNum} AND ${movies.year} < ${decadeNum + 10}`
    );
  }
  if (director) {
    conditions.push(
      sql`${movies.id} IN (
        SELECT ${movieDirectors.movieId} FROM ${movieDirectors}
        INNER JOIN ${directors} ON ${movieDirectors.directorId} = ${directors.id}
        WHERE ${directors.name} = ${director}
      )`
    );
  }
  if (year) {
    conditions.push(eq(movies.year, parseInt(year)));
  }

  // Count total
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalResult] = await db
    .select({ total: count() })
    .from(movies)
    .where(whereClause);

  const total = totalResult?.total || 0;

  // Determine sort column
  let orderByClause;
  if (sort === 'title') {
    orderByClause = order === 'asc' ? asc(movies.title) : desc(movies.title);
  } else if (sort === 'year') {
    orderByClause = order === 'asc' ? asc(movies.year) : desc(movies.year);
  } else if (sort === 'rating') {
    orderByClause =
      order === 'asc' ? asc(movies.tmdbRating) : desc(movies.tmdbRating);
  } else {
    // Default: sort by most recent watch
    orderByClause = desc(movies.createdAt);
  }

  const movieRows = await db
    .select()
    .from(movies)
    .where(whereClause)
    .orderBy(orderByClause)
    .limit(limit)
    .offset(offset);

  const movieIds = movieRows.map((m) => String(m.id));
  const imageMap = await getImageAttachmentBatch(
    db,
    'watching',
    'movies',
    movieIds
  );

  const data = await Promise.all(
    movieRows.map(async (m) => {
      const genreRows = await getMovieGenres(db, m.id);
      const directorRows = await getMovieDirectors(db, m.id);
      return formatMovie(
        m,
        genreRows.map((g) => g.name),
        directorRows.map((d) => d.name),
        imageMap.get(String(m.id)) ?? null
      );
    })
  );

  return c.json({
    data,
    pagination: paginate(page, limit, total),
  });
});

// ─── Movie detail ────────────────────────────────────────────────────

watching.get('/movies/:id', async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return badRequest(c, 'Invalid movie ID');
  }

  const [movie] = await db
    .select()
    .from(movies)
    .where(eq(movies.id, id))
    .limit(1);

  if (!movie) {
    return notFound(c, 'Movie not found');
  }

  const [genreRows, directorRows, image] = await Promise.all([
    getMovieGenres(db, id),
    getMovieDirectors(db, id),
    getImageAttachment(db, 'watching', 'movies', String(id)),
  ]);

  // Get watch history for this movie
  const history = await db
    .select()
    .from(watchHistory)
    .where(eq(watchHistory.movieId, id))
    .orderBy(desc(watchHistory.watchedAt));

  return c.json({
    ...formatMovie(
      movie,
      genreRows.map((g) => g.name),
      directorRows.map((d) => d.name),
      image
    ),
    watch_history: history.map((h) => ({
      id: h.id,
      watched_at: h.watchedAt,
      source: h.source,
      user_rating: h.userRating,
      percent_complete: h.percentComplete,
      rewatch: h.rewatch === 1,
    })),
  });
});

// ─── Stats ───────────────────────────────────────────────────────────

watching.get('/stats', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const [stats] = await db
    .select()
    .from(watchStats)
    .where(eq(watchStats.userId, 1))
    .limit(1);

  if (!stats) {
    return c.json({ data: {
      total_movies: 0,
      total_watch_time_hours: 0,
      movies_this_year: 0,
      avg_per_month: 0,
      top_genre: null,
      top_decade: null,
      top_director: null,
      total_shows: 0,
      total_episodes_watched: 0,
      episodes_this_year: 0,
    } });
  }

  // Top genre
  const [topGenre] = await db
    .select({
      name: genres.name,
      total: count(),
    })
    .from(movieGenres)
    .innerJoin(genres, eq(movieGenres.genreId, genres.id))
    .groupBy(genres.name)
    .orderBy(desc(count()))
    .limit(1);

  // Top decade
  const [topDecade] = await db
    .select({
      decade: sql<number>`(${movies.year} / 10) * 10`,
      total: count(),
    })
    .from(movies)
    .where(sql`${movies.year} IS NOT NULL`)
    .groupBy(sql`(${movies.year} / 10) * 10`)
    .orderBy(desc(count()))
    .limit(1);

  // Top director
  const [topDirector] = await db
    .select({
      name: directors.name,
      total: count(),
    })
    .from(movieDirectors)
    .innerJoin(directors, eq(movieDirectors.directorId, directors.id))
    .groupBy(directors.name)
    .orderBy(desc(count()))
    .limit(1);

  // Calculate avg per month based on first watch
  const [firstWatch] = await db
    .select({ earliest: sql<string>`min(${watchHistory.watchedAt})` })
    .from(watchHistory);

  let avgPerMonth = 0;
  if (firstWatch?.earliest) {
    const firstDate = new Date(firstWatch.earliest);
    const now = new Date();
    const months =
      (now.getFullYear() - firstDate.getFullYear()) * 12 +
      (now.getMonth() - firstDate.getMonth()) +
      1;
    avgPerMonth =
      months > 0
        ? Math.round((stats.totalMovies / months) * 10) / 10
        : stats.totalMovies;
  }

  return c.json({ data: {
    total_movies: stats.totalMovies,
    total_watch_time_hours: Math.round(stats.totalWatchTimeS / 3600),
    movies_this_year: stats.moviesThisYear,
    avg_per_month: avgPerMonth,
    top_genre: topGenre?.name || null,
    top_decade: topDecade?.decade || null,
    top_director: topDirector?.name || null,
    total_shows: stats.totalShows,
    total_episodes_watched: stats.totalEpisodesWatched,
    episodes_this_year: stats.episodesThisYear,
  } });
});

// ─── Stats: Genres ───────────────────────────────────────────────────

watching.get('/stats/genres', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const genreStats = await db
    .select({
      name: genres.name,
      total: count(),
    })
    .from(movieGenres)
    .innerJoin(genres, eq(movieGenres.genreId, genres.id))
    .groupBy(genres.name)
    .orderBy(desc(count()));

  const totalMovies = genreStats.reduce((sum, g) => sum + g.total, 0);

  return c.json({
    data: genreStats.map((g) => ({
      name: g.name,
      count: g.total,
      percentage:
        totalMovies > 0 ? Math.round((g.total / totalMovies) * 1000) / 10 : 0,
    })),
  });
});

// ─── Stats: Decades ──────────────────────────────────────────────────

watching.get('/stats/decades', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const decadeStats = await db
    .select({
      decade: sql<number>`(${movies.year} / 10) * 10`,
      total: count(),
    })
    .from(movies)
    .where(sql`${movies.year} IS NOT NULL`)
    .groupBy(sql`(${movies.year} / 10) * 10`)
    .orderBy(desc(sql<number>`(${movies.year} / 10) * 10`));

  return c.json({
    data: decadeStats.map((d) => ({
      decade: d.decade,
      count: d.total,
    })),
  });
});

// ─── Stats: Directors ────────────────────────────────────────────────

watching.get('/stats/directors', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);

  const directorStats = await db
    .select({
      name: directors.name,
      total: count(),
    })
    .from(movieDirectors)
    .innerJoin(directors, eq(movieDirectors.directorId, directors.id))
    .groupBy(directors.name)
    .orderBy(desc(count()))
    .limit(limit);

  return c.json({
    data: directorStats.map((d) => ({
      name: d.name,
      count: d.total,
    })),
  });
});

// ─── Calendar ────────────────────────────────────────────────────────

watching.get('/calendar', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const year = c.req.query('year') || String(new Date().getFullYear());

  const calendarData = await db
    .select({
      date: sql<string>`substr(${watchHistory.watchedAt}, 1, 10)`,
      total: count(),
    })
    .from(watchHistory)
    .where(sql`substr(${watchHistory.watchedAt}, 1, 4) = ${year}`)
    .groupBy(sql`substr(${watchHistory.watchedAt}, 1, 10)`)
    .orderBy(asc(sql`substr(${watchHistory.watchedAt}, 1, 10)`));

  return c.json({
    year: parseInt(year),
    data: calendarData.map((d) => ({
      date: d.date,
      count: d.total,
    })),
  });
});

// ─── Trends ──────────────────────────────────────────────────────────

watching.get('/trends', async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);
  const period = c.req.query('period') || 'monthly';

  let groupExpr;
  if (period === 'weekly') {
    groupExpr = sql`substr(${watchHistory.watchedAt}, 1, 4) || '-W' || printf('%02d', cast((julianday(${watchHistory.watchedAt}) - julianday(substr(${watchHistory.watchedAt}, 1, 4) || '-01-01')) / 7 as integer) + 1)`;
  } else {
    // monthly
    groupExpr = sql`substr(${watchHistory.watchedAt}, 1, 7)`;
  }

  const trendData = await db
    .select({
      period: groupExpr,
      total: count(),
    })
    .from(watchHistory)
    .groupBy(groupExpr)
    .orderBy(asc(groupExpr));

  return c.json({
    period,
    data: trendData.map((t) => ({
      period: t.period,
      count: t.total,
    })),
  });
});

// ─── TV Shows ────────────────────────────────────────────────────────

watching.get('/shows', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const page = Math.max(parseInt(c.req.query('page') || '1'), 1);
  const limit = Math.min(
    Math.max(parseInt(c.req.query('limit') || '20'), 1),
    100
  );
  const offset = (page - 1) * limit;
  const sort = c.req.query('sort') || 'title';
  const order = c.req.query('order') || 'asc';

  const [totalResult] = await db.select({ total: count() }).from(plexShows);

  const total = totalResult?.total || 0;

  let orderByClause;
  if (sort === 'year') {
    orderByClause =
      order === 'asc' ? asc(plexShows.year) : desc(plexShows.year);
  } else {
    orderByClause =
      order === 'asc' ? asc(plexShows.title) : desc(plexShows.title);
  }

  const showRows = await db
    .select()
    .from(plexShows)
    .orderBy(orderByClause)
    .limit(limit)
    .offset(offset);

  const showIds = showRows.map((s) => String(s.id));
  const imageMap = await getImageAttachmentBatch(
    db,
    'watching',
    'shows',
    showIds
  );

  const data = await Promise.all(
    showRows.map(async (show) => {
      const [epCount] = await db
        .select({ total: count() })
        .from(plexEpisodesWatched)
        .where(eq(plexEpisodesWatched.showId, show.id));

      return {
        id: show.id,
        title: show.title,
        year: show.year,
        tmdb_id: show.tmdbId,
        tmdb_rating: show.tmdbRating,
        content_rating: show.contentRating,
        summary: show.summary,
        image: imageMap.get(String(show.id)) ?? null,
        total_seasons: show.totalSeasons,
        total_episodes: show.totalEpisodes,
        episodes_watched: epCount?.total || 0,
      };
    })
  );

  return c.json({
    data,
    pagination: paginate(page, limit, total),
  });
});

// ─── Show detail ─────────────────────────────────────────────────────

watching.get('/shows/:id', async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return badRequest(c, 'Invalid show ID');
  }

  const [show] = await db
    .select()
    .from(plexShows)
    .where(eq(plexShows.id, id))
    .limit(1);

  if (!show) {
    return notFound(c, 'Show not found');
  }

  // Get episodes and image metadata in parallel
  const [episodesWatched, image] = await Promise.all([
    db
      .select()
      .from(plexEpisodesWatched)
      .where(eq(plexEpisodesWatched.showId, id))
      .orderBy(
        asc(plexEpisodesWatched.seasonNumber),
        asc(plexEpisodesWatched.episodeNumber)
      ),
    getImageAttachment(db, 'watching', 'shows', String(id)),
  ]);

  // Group by season
  const seasons: Record<
    number,
    {
      season: number;
      episode: number;
      title: string | null;
      watched_at: string;
    }[]
  > = {};

  for (const ep of episodesWatched) {
    if (!seasons[ep.seasonNumber]) {
      seasons[ep.seasonNumber] = [];
    }
    seasons[ep.seasonNumber].push({
      season: ep.seasonNumber,
      episode: ep.episodeNumber,
      title: ep.title,
      watched_at: ep.watchedAt,
    });
  }

  return c.json({
    id: show.id,
    title: show.title,
    year: show.year,
    tmdb_id: show.tmdbId,
    tmdb_rating: show.tmdbRating,
    content_rating: show.contentRating,
    summary: show.summary,
    image,
    total_seasons: show.totalSeasons,
    total_episodes: show.totalEpisodes,
    episodes_watched: episodesWatched.length,
    seasons: Object.entries(seasons).map(([seasonNum, episodes]) => ({
      season_number: parseInt(seasonNum),
      episodes_watched: episodes.length,
      episodes,
    })),
  });
});

// ─── Season detail ───────────────────────────────────────────────────

watching.get('/shows/:id/seasons/:season', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'));
  const season = parseInt(c.req.param('season'));

  if (isNaN(id) || isNaN(season)) {
    return badRequest(c, 'Invalid show ID or season number');
  }

  const [show] = await db
    .select()
    .from(plexShows)
    .where(eq(plexShows.id, id))
    .limit(1);

  if (!show) {
    return notFound(c, 'Show not found');
  }

  const episodesWatched = await db
    .select()
    .from(plexEpisodesWatched)
    .where(
      and(
        eq(plexEpisodesWatched.showId, id),
        eq(plexEpisodesWatched.seasonNumber, season)
      )
    )
    .orderBy(asc(plexEpisodesWatched.episodeNumber));

  return c.json({
    show_id: show.id,
    show_title: show.title,
    season_number: season,
    episodes: episodesWatched.map((ep) => ({
      season: ep.seasonNumber,
      episode: ep.episodeNumber,
      title: ep.title,
      watched_at: ep.watchedAt,
    })),
  });
});

// ─── Ratings ────────────────────────────────────────────────────────

watching.get('/ratings', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const page = Math.max(parseInt(c.req.query('page') || '1'), 1);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20'), 1), 100);
  const offset = (page - 1) * limit;
  const sort = c.req.query('sort') || 'rating';
  const order = c.req.query('order') || 'desc';

  const whereClause = sql`${watchHistory.userRating} IS NOT NULL`;

  const [totalResult] = await db
    .select({ total: count() })
    .from(watchHistory)
    .where(whereClause);
  const total = totalResult?.total || 0;

  let orderByClause;
  if (sort === 'date') {
    orderByClause = order === 'asc' ? asc(watchHistory.watchedAt) : desc(watchHistory.watchedAt);
  } else {
    orderByClause = order === 'asc' ? asc(watchHistory.userRating) : desc(watchHistory.userRating);
  }

  const rows = await db
    .select({
      watchId: watchHistory.id,
      watchedAt: watchHistory.watchedAt,
      userRating: watchHistory.userRating,
      source: watchHistory.source,
      movieId: movies.id,
      title: movies.title,
      year: movies.year,
      tmdbId: movies.tmdbId,
      tmdbRating: movies.tmdbRating,
    })
    .from(watchHistory)
    .innerJoin(movies, eq(watchHistory.movieId, movies.id))
    .where(whereClause)
    .orderBy(orderByClause)
    .limit(limit)
    .offset(offset);

  const movieIds = rows.map((r) => String(r.movieId));
  const imageMap = await getImageAttachmentBatch(db, 'watching', 'movies', movieIds);

  return c.json({
    data: rows.map((r) => ({
      movie: {
        id: r.movieId,
        title: r.title,
        year: r.year,
        tmdb_id: r.tmdbId,
        tmdb_rating: r.tmdbRating,
        image: imageMap.get(String(r.movieId)) ?? null,
      },
      user_rating: r.userRating,
      watched_at: r.watchedAt,
      source: r.source,
    })),
    pagination: paginate(page, limit, total),
  });
});

// ─── Reviews ────────────────────────────────────────────────────────

watching.get('/reviews', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const page = Math.max(parseInt(c.req.query('page') || '1'), 1);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20'), 1), 100);
  const offset = (page - 1) * limit;

  const whereClause = sql`${watchHistory.review} IS NOT NULL AND ${watchHistory.review} != ''`;

  const [totalResult] = await db
    .select({ total: count() })
    .from(watchHistory)
    .where(whereClause);
  const total = totalResult?.total || 0;

  const rows = await db
    .select({
      watchId: watchHistory.id,
      watchedAt: watchHistory.watchedAt,
      userRating: watchHistory.userRating,
      review: watchHistory.review,
      source: watchHistory.source,
      movieId: movies.id,
      title: movies.title,
      year: movies.year,
      tmdbId: movies.tmdbId,
    })
    .from(watchHistory)
    .innerJoin(movies, eq(watchHistory.movieId, movies.id))
    .where(whereClause)
    .orderBy(desc(watchHistory.watchedAt))
    .limit(limit)
    .offset(offset);

  const movieIds = rows.map((r) => String(r.movieId));
  const imageMap = await getImageAttachmentBatch(db, 'watching', 'movies', movieIds);

  return c.json({
    data: rows.map((r) => ({
      movie: {
        id: r.movieId,
        title: r.title,
        year: r.year,
        tmdb_id: r.tmdbId,
        image: imageMap.get(String(r.movieId)) ?? null,
      },
      user_rating: r.userRating,
      review: r.review,
      watched_at: r.watchedAt,
      source: r.source,
    })),
    pagination: paginate(page, limit, total),
  });
});

// ─── Year in Review ─────────────────────────────────────────────────

watching.get('/year/:year', async (c) => {
  const db = createDb(c.env.DB);
  const currentYear = new Date().getFullYear();
  const year = parseInt(c.req.param('year'));

  if (isNaN(year) || year < 2000 || year > currentYear + 1) {
    return badRequest(c, 'Invalid year');
  }

  if (year < currentYear) {
    setCache(c, 'long');
  } else {
    setCache(c, 'medium');
  }

  const yearStr = String(year);

  // Movies watched this year
  const yearCondition = sql`substr(${watchHistory.watchedAt}, 1, 4) = ${yearStr}`;

  const [{ total: totalMovies }] = await db
    .select({ total: count() })
    .from(watchHistory)
    .where(yearCondition);

  // Genre breakdown
  const genreBreakdown = await db
    .select({
      name: genres.name,
      total: count(),
    })
    .from(watchHistory)
    .innerJoin(movies, eq(watchHistory.movieId, movies.id))
    .innerJoin(movieGenres, eq(movies.id, movieGenres.movieId))
    .innerJoin(genres, eq(movieGenres.genreId, genres.id))
    .where(yearCondition)
    .groupBy(genres.name)
    .orderBy(desc(count()))
    .limit(10);

  // Monthly counts
  const monthlyCounts = await db
    .select({
      month: sql<string>`substr(${watchHistory.watchedAt}, 1, 7)`,
      total: count(),
    })
    .from(watchHistory)
    .where(yearCondition)
    .groupBy(sql`substr(${watchHistory.watchedAt}, 1, 7)`)
    .orderBy(asc(sql`substr(${watchHistory.watchedAt}, 1, 7)`));

  // Top-rated movies this year
  const topRated = await db
    .select({
      movieId: movies.id,
      title: movies.title,
      year: movies.year,
      tmdbId: movies.tmdbId,
      userRating: watchHistory.userRating,
      watchedAt: watchHistory.watchedAt,
    })
    .from(watchHistory)
    .innerJoin(movies, eq(watchHistory.movieId, movies.id))
    .where(and(yearCondition, sql`${watchHistory.userRating} IS NOT NULL`))
    .orderBy(desc(watchHistory.userRating))
    .limit(10);

  // Decade breakdown
  const decadeBreakdown = await db
    .select({
      decade: sql<number>`(${movies.year} / 10) * 10`,
      total: count(),
    })
    .from(watchHistory)
    .innerJoin(movies, eq(watchHistory.movieId, movies.id))
    .where(and(yearCondition, sql`${movies.year} IS NOT NULL`))
    .groupBy(sql`(${movies.year} / 10) * 10`)
    .orderBy(desc(count()));

  const movieIds = topRated.map((r) => String(r.movieId));
  const imageMap = await getImageAttachmentBatch(db, 'watching', 'movies', movieIds);

  return c.json({
    year,
    total_movies: totalMovies,
    genres: genreBreakdown.map((g) => ({ name: g.name, count: g.total })),
    decades: decadeBreakdown.map((d) => ({ decade: d.decade, count: d.total })),
    monthly: monthlyCounts.map((m) => ({ month: m.month, count: m.total })),
    top_rated: topRated.map((r) => ({
      movie: {
        id: r.movieId,
        title: r.title,
        year: r.year,
        tmdb_id: r.tmdbId,
        image: imageMap.get(String(r.movieId)) ?? null,
      },
      user_rating: r.userRating,
      watched_at: r.watchedAt,
    })),
  });
});

// ─── Admin: Sync ─────────────────────────────────────────────────────
// POST /v1/admin/sync/watching -- moved to admin-sync.ts
// Old path /v1/watching/admin/sync/watching redirects via admin-sync.ts

// ─── Admin: Manual movie entry ───────────────────────────────────────

watching.post('/admin/watching/movies', async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{
    tmdb_id?: number;
    title?: string;
    year?: number;
    watched_at?: string;
    rating?: number;
    rewatch?: boolean;
  }>();

  if (!body.tmdb_id && !body.title) {
    return badRequest(c, 'Either tmdb_id or title is required');
  }

  const tmdbClient = new TmdbClient(c.env.TMDB_API_KEY);

  const result = await resolveMovie(db, tmdbClient, {
    tmdbId: body.tmdb_id,
    title: body.title || '',
    year: body.year,
  });

  if (!result) {
    return notFound(c, 'No matching movie found on TMDB');
  }

  const movieId = result.id;

  const watchedAt = body.watched_at || new Date().toISOString();

  // Dedup check
  const watchDate = watchedAt.substring(0, 10);
  const dupCheck = await db
    .select({ id: watchHistory.id })
    .from(watchHistory)
    .where(
      and(
        eq(watchHistory.movieId, movieId),
        sql`substr(${watchHistory.watchedAt}, 1, 10) = ${watchDate}`
      )
    )
    .limit(1);

  if (dupCheck.length > 0) {
    return c.json(
      {
        error: 'Duplicate watch event for this movie on this date',
        status: 409,
      },
      409
    );
  }

  const [watchEvent] = await db
    .insert(watchHistory)
    .values({
      movieId,
      watchedAt,
      source: 'manual',
      userRating: body.rating || null,
      rewatch: body.rewatch ? 1 : 0,
    })
    .returning();

  // Update stats
  await computeWatchStats(db);

  return c.json(
    {
      id: watchEvent.id,
      movie_id: movieId,
      watched_at: watchEvent.watchedAt,
      source: watchEvent.source,
      user_rating: watchEvent.userRating,
      rewatch: watchEvent.rewatch === 1,
    },
    201
  );
});

// ─── Admin: Edit watch event ─────────────────────────────────────────

watching.put('/admin/watching/movies/:id', async (c) => {
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return badRequest(c, 'Invalid watch event ID');
  }

  const [existing] = await db
    .select()
    .from(watchHistory)
    .where(eq(watchHistory.id, id))
    .limit(1);

  if (!existing) {
    return notFound(c, 'Watch event not found');
  }

  const body = await c.req.json<{
    watched_at?: string;
    rating?: number;
    rewatch?: boolean;
  }>();

  const updates: Record<string, unknown> = {};
  if (body.watched_at !== undefined) updates.watchedAt = body.watched_at;
  if (body.rating !== undefined) updates.userRating = body.rating;
  if (body.rewatch !== undefined) updates.rewatch = body.rewatch ? 1 : 0;

  if (Object.keys(updates).length === 0) {
    return badRequest(c, 'No fields to update');
  }

  await db.update(watchHistory).set(updates).where(eq(watchHistory.id, id));

  const [updated] = await db
    .select()
    .from(watchHistory)
    .where(eq(watchHistory.id, id))
    .limit(1);

  return c.json({
    id: updated.id,
    movie_id: updated.movieId,
    watched_at: updated.watchedAt,
    source: updated.source,
    user_rating: updated.userRating,
    rewatch: updated.rewatch === 1,
  });
});

// ─── Admin: Delete watch event ───────────────────────────────────────

// eslint-disable-next-line drizzle/enforce-delete-with-where -- this is a Hono route, not a Drizzle delete
watching.delete('/admin/watching/movies/:id', async (c) => {
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return badRequest(c, 'Invalid watch event ID');
  }

  const [existing] = await db
    .select()
    .from(watchHistory)
    .where(eq(watchHistory.id, id))
    .limit(1);

  if (!existing) {
    return notFound(c, 'Watch event not found');
  }

  await db.delete(watchHistory).where(eq(watchHistory.id, id));

  // Update stats
  await computeWatchStats(db);

  return c.json({ success: true, deleted_id: id });
});

// ─── Admin: Backfill images ─────────────────────────────────────────

watching.post('/admin/watching/backfill-images', async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req
    .json<{ type?: string; limit?: number }>()
    .catch(() => ({ type: undefined, limit: undefined }));

  const entityType = body.type || 'movies';
  if (!['movies', 'shows', 'all'].includes(entityType)) {
    return badRequest(c, 'Invalid type. Valid: movies, shows, all');
  }
  const maxItems = Math.min(body.limit || 50, 200);

  const results: Record<string, unknown> = {};

  if (entityType === 'movies' || entityType === 'all') {
    // Get movies with tmdb_id that don't have images yet
    const movieRows = await db
      .select({
        id: movies.id,
        tmdbId: movies.tmdbId,
      })
      .from(movies)
      .where(
        sql`${movies.tmdbId} IS NOT NULL AND ${movies.id} NOT IN (
        SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
        WHERE ${images.domain} = 'watching' AND ${images.entityType} = 'movies'
      )`
      )
      .limit(maxItems);

    const movieItems: BackfillItem[] = movieRows.map((m) => ({
      entityId: String(m.id),
      tmdbId: String(m.tmdbId),
    }));

    const movieResult = await backfillImages(
      db,
      c.env,
      'watching',
      'movies',
      movieItems,
      { batchSize: 5, delayMs: 500 }
    );
    results.movies = movieResult;
  }

  if (entityType === 'shows' || entityType === 'all') {
    // Get shows with tmdb_id that don't have images yet
    const showRows = await db
      .select({
        id: plexShows.id,
        tmdbId: plexShows.tmdbId,
      })
      .from(plexShows)
      .where(
        sql`${plexShows.tmdbId} IS NOT NULL AND ${plexShows.id} NOT IN (
        SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
        WHERE ${images.domain} = 'watching' AND ${images.entityType} = 'shows'
      )`
      )
      .limit(maxItems);

    const showItems: BackfillItem[] = showRows.map((s) => ({
      entityId: String(s.id),
      tmdbId: String(s.tmdbId),
    }));

    const showResult = await backfillImages(
      db,
      c.env,
      'watching',
      'shows',
      showItems,
      { batchSize: 5, delayMs: 500 }
    );
    results.shows = showResult;
  }

  return c.json({ success: true, results });
});

export default watching;
