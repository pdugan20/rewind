import { createRoute, z } from '@hono/zod-openapi';
import { eq, sql, desc, asc, and, count } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { setCache } from '../lib/cache.js';
import { DateFilterQuery, buildDateCondition } from '../lib/date-filters.js';
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
import { resolveImage } from '../services/images/pipeline.js';
import { getImageAttachment, getImageAttachmentBatch } from '../lib/images.js';
import type { ImageAttachment } from '../lib/images.js';
import { images } from '../db/schema/system.js';
import { createOpenAPIApp } from '../lib/openapi.js';
import {
  errorResponses,
  ImageAttachment as ImageAttachmentSchema,
  PaginationMeta,
} from '../lib/schemas/common.js';

const watching = createOpenAPIApp();

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

// ─── Schemas ─────────────────────────────────────────────────────────

const MovieSchema = z.object({
  id: z.number(),
  title: z.string(),
  year: z.number().nullable(),
  director: z.string().nullable(),
  directors: z.array(z.string()),
  genres: z.array(z.string()),
  duration_min: z.number().nullable(),
  rating: z.string().nullable(),
  image: ImageAttachmentSchema,
  imdb_id: z.string().nullable(),
  tmdb_id: z.number().nullable(),
  tmdb_rating: z.number().nullable(),
  tagline: z.string().nullable(),
  summary: z.string().nullable(),
});

const WatchEventSchema = z.object({
  movie: MovieSchema,
  watched_at: z.string(),
  source: z.string().nullable(),
  user_rating: z.number().nullable(),
  percent_complete: z.number().nullable(),
  rewatch: z.boolean(),
  review: z.string().nullable(),
  review_url: z.string().nullable(),
});

const WatchHistoryEntrySchema = z.object({
  id: z.number(),
  watched_at: z.string(),
  source: z.string().nullable(),
  user_rating: z.number().nullable(),
  percent_complete: z.number().nullable(),
  rewatch: z.boolean(),
  review: z.string().nullable(),
  review_url: z.string().nullable(),
});

const MovieDetailSchema = MovieSchema.extend({
  watch_history: z.array(WatchHistoryEntrySchema),
});

const WatchStatsSchema = z.object({
  total_movies: z.number(),
  total_watch_time_hours: z.number(),
  movies_this_year: z.number(),
  avg_per_month: z.number(),
  top_genre: z.string().nullable(),
  top_decade: z.number().nullable(),
  top_director: z.string().nullable(),
  total_shows: z.number(),
  total_episodes_watched: z.number(),
  episodes_this_year: z.number(),
});

const GenreStatSchema = z.object({
  name: z.string(),
  count: z.number(),
  percentage: z.number(),
});

const DecadeStatSchema = z.object({
  decade: z.number(),
  count: z.number(),
});

const DirectorStatSchema = z.object({
  name: z.string(),
  count: z.number(),
});

const CalendarEntrySchema = z.object({
  date: z.string(),
  count: z.number(),
});

const TrendEntrySchema = z.object({
  period: z.string(),
  count: z.number(),
});

const ShowSchema = z.object({
  id: z.number(),
  title: z.string(),
  year: z.number().nullable(),
  tmdb_id: z.number().nullable(),
  tmdb_rating: z.number().nullable(),
  content_rating: z.string().nullable(),
  summary: z.string().nullable(),
  image: ImageAttachmentSchema,
  total_seasons: z.number().nullable(),
  total_episodes: z.number().nullable(),
  episodes_watched: z.number(),
});

const EpisodeSchema = z.object({
  season: z.number(),
  episode: z.number(),
  title: z.string().nullable(),
  watched_at: z.string(),
});

const SeasonSchema = z.object({
  season_number: z.number(),
  episodes_watched: z.number(),
  episodes: z.array(EpisodeSchema),
});

const ShowDetailSchema = z.object({
  id: z.number(),
  title: z.string(),
  year: z.number().nullable(),
  tmdb_id: z.number().nullable(),
  tmdb_rating: z.number().nullable(),
  content_rating: z.string().nullable(),
  summary: z.string().nullable(),
  image: ImageAttachmentSchema,
  total_seasons: z.number().nullable(),
  total_episodes: z.number().nullable(),
  episodes_watched: z.number(),
  seasons: z.array(SeasonSchema),
});

const RatingEntrySchema = z.object({
  movie: z.object({
    id: z.number(),
    title: z.string(),
    year: z.number().nullable(),
    tmdb_id: z.number().nullable(),
    tmdb_rating: z.number().nullable(),
    image: ImageAttachmentSchema,
  }),
  user_rating: z.number().nullable(),
  watched_at: z.string(),
  source: z.string().nullable(),
});

const ReviewEntrySchema = z.object({
  movie: z.object({
    id: z.number(),
    title: z.string(),
    year: z.number().nullable(),
    tmdb_id: z.number().nullable(),
    image: ImageAttachmentSchema,
  }),
  user_rating: z.number().nullable(),
  review: z.string().nullable(),
  watched_at: z.string(),
  source: z.string().nullable(),
});

const WatchEventResultSchema = z.object({
  id: z.number(),
  movie_id: z.number(),
  watched_at: z.string(),
  source: z.string().nullable(),
  user_rating: z.number().nullable(),
  rewatch: z.boolean(),
});

// ─── Route definitions ──────────────────────────────────────────────

const recentRoute = createRoute({
  method: 'get',
  path: '/recent',
  operationId: 'getWatchingRecent',
  tags: ['Watching'],
  summary: 'Recent watches',
  description:
    'Returns most recently watched movies. Supports date filtering via date, from, and to params.',
  request: {
    query: z
      .object({
        limit: z.coerce.number().int().min(1).max(20).optional().default(5),
      })
      .merge(DateFilterQuery),
  },
  responses: {
    200: {
      description: 'Recent watches',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(WatchEventSchema) }),
          example: {
            data: [
              {
                movie: {
                  id: 15,
                  title: "Ferris Bueller's Day Off",
                  year: 1986,
                  director: 'John Hughes',
                  directors: ['John Hughes'],
                  genres: ['Comedy'],
                  duration_min: 103,
                  rating: 'PG-13',
                  image: {
                    url: 'https://cdn.rewind.rest/watching/movies/15/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
                    thumbhash: 'YRcKDQKadZh4d3Z4d3aHeAeAh4B3',
                    dominant_color: '#2a2a2a',
                    accent_color: '#c8a882',
                  },
                  imdb_id: 'tt0091042',
                  tmdb_id: 9377,
                  tmdb_rating: 7.6,
                  tagline: "One man's struggle to take it easy.",
                  summary:
                    'A high school wise guy is determined to have a day off from school, despite what the Principal thinks of that.',
                },
                watched_at: '2026-03-10T02:30:00.000Z',
                source: 'plex',
                user_rating: null,
                percent_complete: 100,
                rewatch: false,
                review: null,
                review_url: null,
              },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const moviesListRoute = createRoute({
  method: 'get',
  path: '/movies',
  operationId: 'listWatchingMovies',
  tags: ['Watching'],
  summary: 'List movies',
  description: 'Returns paginated list of movies with optional filters.',
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      genre: z.string().optional(),
      decade: z.string().optional(),
      director: z.string().optional(),
      year: z.string().optional(),
      sort: z.string().optional().default('watched_at'),
      order: z.string().optional().default('desc'),
    }),
  },
  responses: {
    200: {
      description: 'Movie list',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(MovieSchema),
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                id: 15,
                title: "Ferris Bueller's Day Off",
                year: 1986,
                director: 'John Hughes',
                directors: ['John Hughes'],
                genres: ['Comedy'],
                duration_min: 103,
                rating: 'PG-13',
                image: {
                  url: 'https://cdn.rewind.rest/watching/movies/15/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
                  thumbhash: 'YRcKDQKadZh4d3Z4d3aHeAeAh4B3',
                  dominant_color: '#2a2a2a',
                  accent_color: '#c8a882',
                },
                imdb_id: 'tt0091042',
                tmdb_id: 9377,
                tmdb_rating: 7.6,
                tagline: "One man's struggle to take it easy.",
                summary:
                  'A high school wise guy is determined to have a day off from school, despite what the Principal thinks of that.',
                last_watched_at: '2026-03-10T02:30:00.000Z',
              },
              {
                id: 200,
                title: 'Interstellar',
                year: 2014,
                director: 'Christopher Nolan',
                directors: ['Christopher Nolan'],
                genres: ['Science Fiction', 'Drama'],
                duration_min: 169,
                rating: 'PG-13',
                image: null,
                imdb_id: 'tt0816692',
                tmdb_id: 157336,
                tmdb_rating: 8.4,
                tagline: null,
                summary: null,
                last_watched_at: '2024-12-20T20:00:00.000Z',
              },
            ],
            pagination: { page: 1, limit: 20, total: 694, total_pages: 35 },
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const movieDetailRoute = createRoute({
  method: 'get',
  path: '/movies/{id}',
  operationId: 'getWatchingMovie',
  tags: ['Watching'],
  summary: 'Movie detail',
  description:
    'Returns full details for a single movie including watch history.',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Movie detail',
      content: {
        'application/json': {
          schema: MovieDetailSchema,
          example: {
            id: 15,
            title: "Ferris Bueller's Day Off",
            year: 1986,
            director: 'John Hughes',
            directors: ['John Hughes'],
            genres: ['Comedy'],
            duration_min: 103,
            rating: 'PG-13',
            image: {
              url: 'https://cdn.rewind.rest/watching/movies/15/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
              thumbhash: 'YRcKDQKadZh4d3Z4d3aHeAeAh4B3',
              dominant_color: '#2a2a2a',
              accent_color: '#c8a882',
            },
            imdb_id: 'tt0091042',
            tmdb_id: 9377,
            tmdb_rating: 7.6,
            tagline: "One man's struggle to take it easy.",
            summary:
              'A high school wise guy is determined to have a day off from school, despite what the Principal thinks of that.',
            watch_history: [
              {
                id: 1,
                watched_at: '2026-03-10T02:30:00.000Z',
                source: 'plex',
                user_rating: null,
                percent_complete: 100,
                rewatch: false,
                review: null,
                review_url: null,
              },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401, 404),
  },
});

const statsRoute = createRoute({
  method: 'get',
  path: '/stats',
  operationId: 'getWatchingStats',
  tags: ['Watching'],
  summary: 'Watch stats',
  description:
    'Returns aggregate watching statistics. Supports optional date filtering to scope stats to a time period.',
  request: {
    query: DateFilterQuery,
  },
  responses: {
    200: {
      description: 'Watch stats',
      content: {
        'application/json': {
          schema: z.object({ data: WatchStatsSchema }),
          example: {
            data: {
              total_movies: 773,
              total_watch_time_hours: 1507,
              movies_this_year: 27,
              avg_per_month: 8.1,
              top_genre: 'Drama',
              top_decade: 2000,
              top_director: 'Martin Scorsese',
              total_shows: 98,
              total_episodes_watched: 1572,
              episodes_this_year: 106,
            },
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const genreStatsRoute = createRoute({
  method: 'get',
  path: '/stats/genres',
  operationId: 'getWatchingStatsGenres',
  tags: ['Watching'],
  summary: 'Genre stats',
  description: 'Returns genre breakdown for all watched movies.',
  responses: {
    200: {
      description: 'Genre stats',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(GenreStatSchema) }),
          example: {
            data: [
              { name: 'Drama', count: 280, percentage: 36.2 },
              { name: 'Comedy', count: 195, percentage: 25.2 },
              { name: 'Action', count: 142, percentage: 18.4 },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const decadeStatsRoute = createRoute({
  method: 'get',
  path: '/stats/decades',
  operationId: 'getWatchingStatsDecades',
  tags: ['Watching'],
  summary: 'Decade stats',
  description: 'Returns decade breakdown for all watched movies.',
  responses: {
    200: {
      description: 'Decade stats',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(DecadeStatSchema) }),
          example: {
            data: [
              { decade: 2020, count: 185 },
              { decade: 2010, count: 210 },
              { decade: 2000, count: 145 },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const directorStatsRoute = createRoute({
  method: 'get',
  path: '/stats/directors',
  operationId: 'getWatchingStatsDirectors',
  tags: ['Watching'],
  summary: 'Director stats',
  description: 'Returns top directors by movie count.',
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    }),
  },
  responses: {
    200: {
      description: 'Director stats',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(DirectorStatSchema) }),
          example: {
            data: [
              { name: 'Martin Scorsese', count: 18 },
              { name: 'Steven Spielberg', count: 14 },
              { name: 'Christopher Nolan', count: 12 },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const calendarRoute = createRoute({
  method: 'get',
  path: '/calendar',
  operationId: 'getWatchingCalendar',
  tags: ['Watching'],
  summary: 'Watch calendar',
  description: 'Returns daily watch counts for a given year.',
  request: {
    query: z.object({
      year: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Calendar data',
      content: {
        'application/json': {
          schema: z.object({
            year: z.number(),
            data: z.array(CalendarEntrySchema),
          }),
          example: {
            year: 2026,
            data: [
              { date: '2026-03-10', count: 1 },
              { date: '2026-03-12', count: 2 },
              { date: '2026-03-14', count: 1 },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const trendsRoute = createRoute({
  method: 'get',
  path: '/trends',
  operationId: 'getWatchingTrends',
  tags: ['Watching'],
  summary: 'Watch trends',
  description:
    'Returns weekly or monthly watch counts. Supports date filtering via from/to params.',
  request: {
    query: z
      .object({
        period: z.string().optional().default('monthly'),
      })
      .merge(DateFilterQuery),
  },
  responses: {
    200: {
      description: 'Trend data',
      content: {
        'application/json': {
          schema: z.object({
            period: z.string(),
            data: z.array(TrendEntrySchema),
          }),
          example: {
            period: 'monthly',
            data: [
              { period: '2026-01', count: 8 },
              { period: '2026-02', count: 10 },
              { period: '2026-03', count: 9 },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const showsListRoute = createRoute({
  method: 'get',
  path: '/shows',
  operationId: 'listWatchingShows',
  tags: ['Watching'],
  summary: 'List TV shows',
  description: 'Returns paginated list of TV shows.',
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      sort: z.string().optional().default('title'),
      order: z.string().optional().default('asc'),
    }),
  },
  responses: {
    200: {
      description: 'Show list',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(ShowSchema),
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                id: 1,
                title: 'Band of Brothers',
                year: 2001,
                tmdb_id: 4613,
                tmdb_rating: 8.5,
                content_rating: 'TV-MA',
                summary: 'The story of Easy Company during WWII.',
                image: {
                  url: 'https://cdn.rewind.rest/watching/shows/1/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
                  thumbhash: 'YRcKDQKadZh4d3Z4d3aHeAeAh4B3',
                  dominant_color: '#2a2a2a',
                  accent_color: '#c8a882',
                },
                total_seasons: 1,
                total_episodes: 10,
                episodes_watched: 10,
              },
              {
                id: 2,
                title: 'Mad Men',
                year: 2007,
                tmdb_id: 1104,
                tmdb_rating: 8.2,
                content_rating: 'TV-14',
                summary: null,
                image: null,
                total_seasons: 7,
                total_episodes: 92,
                episodes_watched: 89,
              },
              {
                id: 3,
                title: 'Fallout',
                year: 2024,
                tmdb_id: 106379,
                tmdb_rating: 8.0,
                content_rating: 'TV-MA',
                summary: null,
                image: null,
                total_seasons: 1,
                total_episodes: 8,
                episodes_watched: 8,
              },
            ],
            pagination: { page: 1, limit: 20, total: 98, total_pages: 5 },
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const showDetailRoute = createRoute({
  method: 'get',
  path: '/shows/{id}',
  operationId: 'getWatchingShow',
  tags: ['Watching'],
  summary: 'Show detail',
  description:
    'Returns full details for a single TV show including watched episodes.',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Show detail',
      content: {
        'application/json': {
          schema: ShowDetailSchema,
          example: {
            id: 1,
            title: 'Band of Brothers',
            year: 2001,
            tmdb_id: 4613,
            tmdb_rating: 8.5,
            content_rating: 'TV-MA',
            summary: 'The story of Easy Company during WWII.',
            image: {
              url: 'https://cdn.rewind.rest/watching/shows/1/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
              thumbhash: 'YRcKDQKadZh4d3Z4d3aHeAeAh4B3',
              dominant_color: '#2a2a2a',
              accent_color: '#c8a882',
            },
            total_seasons: 1,
            total_episodes: 10,
            episodes_watched: 10,
            seasons: [
              {
                season_number: 1,
                episodes_watched: 10,
                episodes: [
                  {
                    season: 1,
                    episode: 1,
                    title: 'Currahee',
                    watched_at: '2024-01-15T20:00:00Z',
                  },
                  {
                    season: 1,
                    episode: 2,
                    title: 'Day of Days',
                    watched_at: '2024-01-16T20:00:00Z',
                  },
                ],
              },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401, 404),
  },
});

const seasonDetailRoute = createRoute({
  method: 'get',
  path: '/shows/{id}/seasons/{season}',
  operationId: 'getWatchingShowSeason',
  tags: ['Watching'],
  summary: 'Season detail',
  description: 'Returns watched episodes for a specific season of a show.',
  request: {
    params: z.object({
      id: z.string(),
      season: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Season detail',
      content: {
        'application/json': {
          schema: z.object({
            show_id: z.number(),
            show_title: z.string(),
            season_number: z.number(),
            episodes: z.array(EpisodeSchema),
          }),
          example: {
            show_id: 1,
            show_title: 'Band of Brothers',
            season_number: 1,
            episodes: [
              {
                season: 1,
                episode: 1,
                title: 'Currahee',
                watched_at: '2024-01-15T20:00:00Z',
              },
              {
                season: 1,
                episode: 2,
                title: 'Day of Days',
                watched_at: '2024-01-16T20:00:00Z',
              },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401, 404),
  },
});

const ratingsRoute = createRoute({
  method: 'get',
  path: '/ratings',
  operationId: 'listWatchingRatings',
  tags: ['Watching'],
  summary: 'Rated movies',
  description: 'Returns paginated list of movies with user ratings.',
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      sort: z.string().optional().default('rating'),
      order: z.string().optional().default('desc'),
    }),
  },
  responses: {
    200: {
      description: 'Rated movies',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(RatingEntrySchema),
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                movie: {
                  id: 50,
                  title: 'The Great Escape',
                  year: 1963,
                  tmdb_id: 5925,
                  tmdb_rating: 7.9,
                  image: null,
                },
                user_rating: 5,
                review_url: null,
                watched_at: '2025-08-10T20:00:00Z',
                source: 'letterboxd',
              },
              {
                movie: {
                  id: 200,
                  title: 'Interstellar',
                  year: 2014,
                  tmdb_id: 157336,
                  tmdb_rating: 8.4,
                  image: null,
                },
                user_rating: 5,
                review_url: null,
                watched_at: '2024-12-20T20:00:00Z',
                source: 'letterboxd',
              },
            ],
            pagination: { page: 1, limit: 20, total: 150, total_pages: 8 },
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const reviewsRoute = createRoute({
  method: 'get',
  path: '/reviews',
  operationId: 'listWatchingReviews',
  tags: ['Watching'],
  summary: 'Movie reviews',
  description: 'Returns paginated list of movies with user reviews.',
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    }),
  },
  responses: {
    200: {
      description: 'Movie reviews',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(ReviewEntrySchema),
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                movie: {
                  id: 50,
                  title: 'The Great Escape',
                  year: 1963,
                  tmdb_id: 5925,
                  image: null,
                },
                user_rating: 5,
                review: 'An absolute masterpiece of tension and camaraderie.',
                review_url:
                  'https://letterboxd.com/user/film/the-great-escape/',
                watched_at: '2025-08-10T20:00:00Z',
                source: 'letterboxd',
              },
            ],
            pagination: { page: 1, limit: 20, total: 25, total_pages: 2 },
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

const yearInReviewRoute = createRoute({
  method: 'get',
  path: '/year/{year}',
  operationId: 'getWatchingYearInReview',
  tags: ['Watching'],
  summary: 'Year in review',
  description:
    'Returns aggregate stats and top-rated movies for a specific year.',
  request: {
    params: z.object({ year: z.string() }),
  },
  responses: {
    200: {
      description: 'Year in review data',
      content: {
        'application/json': {
          schema: z.object({
            year: z.number(),
            total_movies: z.number(),
            genres: z.array(z.object({ name: z.string(), count: z.number() })),
            decades: z.array(DecadeStatSchema),
            monthly: z.array(
              z.object({ month: z.string(), count: z.number() })
            ),
            top_rated: z.array(
              z.object({
                movie: z.object({
                  id: z.number(),
                  title: z.string(),
                  year: z.number().nullable(),
                  tmdb_id: z.number().nullable(),
                  image: ImageAttachmentSchema,
                }),
                user_rating: z.number().nullable(),
                watched_at: z.string(),
              })
            ),
          }),
          example: {
            year: 2025,
            total_movies: 95,
            genres: [
              { name: 'Drama', count: 35 },
              { name: 'Action', count: 20 },
            ],
            decades: [
              { decade: 2020, count: 30 },
              { decade: 1960, count: 8 },
            ],
            monthly: [
              { month: '2025-01', count: 8 },
              { month: '2025-02', count: 10 },
              { month: '2025-03', count: 9 },
            ],
            top_rated: [
              {
                movie: {
                  id: 50,
                  title: 'The Great Escape',
                  year: 1963,
                  tmdb_id: 5925,
                  image: null,
                },
                user_rating: 5,
                watched_at: '2025-08-10T20:00:00Z',
              },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

const adminCreateMovieRoute = createRoute({
  method: 'post',
  path: '/admin/movies',
  operationId: 'adminWatchingCreateMovie',
  'x-hidden': true,
  tags: ['Watching', 'Admin'],
  summary: 'Add movie manually',
  description: 'Create a manual watch event by TMDB ID or title search.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            tmdb_id: z.number().optional(),
            title: z.string().optional(),
            year: z.number().optional(),
            watched_at: z.string().optional(),
            rating: z.number().optional(),
            rewatch: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Watch event created',
      content: { 'application/json': { schema: WatchEventResultSchema } },
    },
    ...errorResponses(400, 401, 404),
  },
});

const adminEditMovieRoute = createRoute({
  method: 'put',
  path: '/admin/movies/{id}',
  operationId: 'adminWatchingUpdateMovie',
  'x-hidden': true,
  tags: ['Watching', 'Admin'],
  summary: 'Edit watch event',
  description: 'Update fields on an existing watch event.',
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            watched_at: z.string().optional(),
            rating: z.number().optional(),
            rewatch: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Watch event updated',
      content: { 'application/json': { schema: WatchEventResultSchema } },
    },
    ...errorResponses(400, 401, 404),
  },
});

const adminDeleteMovieRoute = createRoute({
  method: 'delete',
  path: '/admin/movies/{id}',
  operationId: 'adminWatchingDeleteMovie',
  'x-hidden': true,
  tags: ['Watching', 'Admin'],
  summary: 'Delete watch event',
  description: 'Delete a watch event by ID.',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Watch event deleted',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            deleted_id: z.number(),
          }),
        },
      },
    },
    ...errorResponses(400, 401, 404),
  },
});

const adminBackfillImagesRoute = createRoute({
  method: 'post',
  path: '/admin/backfill-images',
  operationId: 'adminWatchingBackfillImages',
  'x-hidden': true,
  tags: ['Watching', 'Admin'],
  summary: 'Backfill images',
  description: 'Backfill missing images for movies and/or shows from TMDB.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            type: z.string().optional(),
            limit: z.number().optional(),
            offset: z.number().optional(),
            dry_run: z.boolean().optional(),
            force: z.boolean().optional(),
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

// ─── Recent watches ──────────────────────────────────────────────────

watching.openapi(recentRoute, async (c) => {
  setCache(c, 'realtime');
  const db = createDb(c.env.DB);
  const limit = Math.min(parseInt(c.req.query('limit') || '5'), 20);

  const dateCondition = buildDateCondition(watchHistory.watchedAt, {
    date: c.req.query('date'),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });

  const recentWatches = await db
    .select({
      watchId: watchHistory.id,
      watchedAt: watchHistory.watchedAt,
      source: watchHistory.source,
      userRating: watchHistory.userRating,
      percentComplete: watchHistory.percentComplete,
      rewatch: watchHistory.rewatch,
      review: watchHistory.review,
      reviewUrl: watchHistory.reviewUrl,
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
    .where(dateCondition)
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
        review: w.review ?? null,
        review_url: w.reviewUrl ?? null,
      };
    })
  );

  return c.json({ data }) as any;
});

// ─── Movies list ─────────────────────────────────────────────────────

watching.openapi(moviesListRoute, async (c) => {
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
  const useWatchedAtSort =
    sort === 'watched_at' || !['title', 'year', 'rating'].includes(sort);

  let orderByClause;
  if (sort === 'title') {
    orderByClause = order === 'asc' ? asc(movies.title) : desc(movies.title);
  } else if (sort === 'year') {
    orderByClause = order === 'asc' ? asc(movies.year) : desc(movies.year);
  } else if (sort === 'rating') {
    orderByClause =
      order === 'asc' ? asc(movies.tmdbRating) : desc(movies.tmdbRating);
  }

  // Join watch_history to include last_watched_at in the response.
  // Exclude Letterboxd entries without reviews — those are bulk-logged with
  // unreliable dates (the date is when it was entered, not when it was watched).
  const reliableWatchCondition = and(
    eq(movies.id, watchHistory.movieId),
    sql`(${watchHistory.source} != 'letterboxd' OR (${watchHistory.review} IS NOT NULL AND ${watchHistory.review} != ''))`
  );

  const lastWatched = sql<string>`MAX(${watchHistory.watchedAt})`.as(
    'last_watched'
  );

  let queryOrderBy;
  if (useWatchedAtSort) {
    queryOrderBy = order === 'asc' ? asc(lastWatched) : desc(lastWatched);
  } else {
    queryOrderBy = orderByClause!;
  }

  const results = await db
    .select({
      movie: movies,
      lastWatched,
    })
    .from(movies)
    .leftJoin(watchHistory, reliableWatchCondition)
    .where(whereClause)
    .groupBy(movies.id)
    .orderBy(queryOrderBy)
    .limit(limit)
    .offset(offset);

  const movieIds = results.map((r) => String(r.movie.id));
  const imageMap = await getImageAttachmentBatch(
    db,
    'watching',
    'movies',
    movieIds
  );

  const data = await Promise.all(
    results.map(async (r) => {
      const genreRows = await getMovieGenres(db, r.movie.id);
      const directorRows = await getMovieDirectors(db, r.movie.id);
      return {
        ...formatMovie(
          r.movie,
          genreRows.map((g) => g.name),
          directorRows.map((d) => d.name),
          imageMap.get(String(r.movie.id)) ?? null
        ),
        last_watched_at: r.lastWatched,
      };
    })
  );

  return c.json({
    data,
    pagination: paginate(page, limit, total),
  }) as any;
});

// ─── Movie detail ────────────────────────────────────────────────────

watching.openapi(movieDetailRoute, async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return badRequest(c, 'Invalid movie ID') as any;
  }

  const [movie] = await db
    .select()
    .from(movies)
    .where(eq(movies.id, id))
    .limit(1);

  if (!movie) {
    return notFound(c, 'Movie not found') as any;
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

  const firstWatchedAt =
    history.length > 0 ? history[history.length - 1].watchedAt : null;

  return c.json({
    ...formatMovie(
      movie,
      genreRows.map((g) => g.name),
      directorRows.map((d) => d.name),
      image
    ),
    first_watched_at: firstWatchedAt,
    watch_history: history.map((h) => ({
      id: h.id,
      watched_at: h.watchedAt,
      source: h.source,
      user_rating: h.userRating,
      percent_complete: h.percentComplete,
      rewatch: h.rewatch === 1,
    })),
  }) as any;
});

// ─── Stats ───────────────────────────────────────────────────────────

watching.openapi(statsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const dateCondition = buildDateCondition(watchHistory.watchedAt, {
    date: c.req.query('date'),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });

  // Date-scoped: compute live from watch_history
  if (dateCondition) {
    const [totals] = await db
      .select({
        totalMovies: sql<number>`count(distinct ${watchHistory.movieId})`,
        totalWatches: count(),
        totalRuntimeMin: sql<number>`coalesce(sum(${movies.runtime}), 0)`,
        minDate: sql<string>`min(${watchHistory.watchedAt})`,
        maxDate: sql<string>`max(${watchHistory.watchedAt})`,
      })
      .from(watchHistory)
      .innerJoin(movies, eq(watchHistory.movieId, movies.id))
      .where(dateCondition);

    // Top genre within date range
    const [topGenre] = await db
      .select({
        name: genres.name,
        total: count(),
      })
      .from(watchHistory)
      .innerJoin(movies, eq(watchHistory.movieId, movies.id))
      .innerJoin(movieGenres, eq(movies.id, movieGenres.movieId))
      .innerJoin(genres, eq(movieGenres.genreId, genres.id))
      .where(dateCondition)
      .groupBy(genres.name)
      .orderBy(desc(count()))
      .limit(1);

    // Top decade within date range
    const [topDecade] = await db
      .select({
        decade: sql<number>`(${movies.year} / 10) * 10`,
        total: count(),
      })
      .from(watchHistory)
      .innerJoin(movies, eq(watchHistory.movieId, movies.id))
      .where(and(dateCondition, sql`${movies.year} IS NOT NULL`))
      .groupBy(sql`(${movies.year} / 10) * 10`)
      .orderBy(desc(count()))
      .limit(1);

    // Top director within date range
    const [topDirector] = await db
      .select({
        name: directors.name,
        total: count(),
      })
      .from(watchHistory)
      .innerJoin(movies, eq(watchHistory.movieId, movies.id))
      .innerJoin(movieDirectors, eq(movies.id, movieDirectors.movieId))
      .innerJoin(directors, eq(movieDirectors.directorId, directors.id))
      .where(dateCondition)
      .groupBy(directors.name)
      .orderBy(desc(count()))
      .limit(1);

    const monthsInRange =
      totals.minDate && totals.maxDate
        ? Math.max(
            1,
            (new Date(totals.maxDate).getFullYear() -
              new Date(totals.minDate).getFullYear()) *
              12 +
              (new Date(totals.maxDate).getMonth() -
                new Date(totals.minDate).getMonth()) +
              1
          )
        : 1;

    return c.json({
      data: {
        total_movies: totals.totalMovies,
        total_watch_time_hours: Math.round(totals.totalRuntimeMin / 60),
        movies_this_year: 0,
        avg_per_month:
          Math.round((totals.totalMovies / monthsInRange) * 10) / 10,
        top_genre: topGenre?.name || null,
        top_decade: topDecade?.decade || null,
        top_director: topDirector?.name || null,
        total_shows: 0,
        total_episodes_watched: 0,
        episodes_this_year: 0,
      },
    }) as any;
  }

  // Lifetime: use pre-computed stats table
  const [stats] = await db
    .select()
    .from(watchStats)
    .where(eq(watchStats.userId, 1))
    .limit(1);

  if (!stats) {
    return c.json({
      data: {
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
      },
    }) as any;
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

  return c.json({
    data: {
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
    },
  }) as any;
});

// ─── Stats: Genres ───────────────────────────────────────────────────

watching.openapi(genreStatsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const genreStatsData = await db
    .select({
      name: genres.name,
      total: count(),
    })
    .from(movieGenres)
    .innerJoin(genres, eq(movieGenres.genreId, genres.id))
    .groupBy(genres.name)
    .orderBy(desc(count()));

  const totalMovies = genreStatsData.reduce((sum, g) => sum + g.total, 0);

  return c.json({
    data: genreStatsData.map((g) => ({
      name: g.name,
      count: g.total,
      percentage:
        totalMovies > 0 ? Math.round((g.total / totalMovies) * 1000) / 10 : 0,
    })),
  }) as any;
});

// ─── Stats: Decades ──────────────────────────────────────────────────

watching.openapi(decadeStatsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const decadeStatsData = await db
    .select({
      decade: sql<number>`(${movies.year} / 10) * 10`,
      total: count(),
    })
    .from(movies)
    .where(sql`${movies.year} IS NOT NULL`)
    .groupBy(sql`(${movies.year} / 10) * 10`)
    .orderBy(desc(sql<number>`(${movies.year} / 10) * 10`));

  return c.json({
    data: decadeStatsData.map((d) => ({
      decade: d.decade,
      count: d.total,
    })),
  }) as any;
});

// ─── Stats: Directors ────────────────────────────────────────────────

watching.openapi(directorStatsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);

  const directorStatsData = await db
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
    data: directorStatsData.map((d) => ({
      name: d.name,
      count: d.total,
    })),
  }) as any;
});

// ─── Calendar ────────────────────────────────────────────────────────

watching.openapi(calendarRoute, async (c) => {
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
  }) as any;
});

// ─── Trends ──────────────────────────────────────────────────────────

watching.openapi(trendsRoute, async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);
  const period = c.req.query('period') || 'monthly';

  const dateCondition = buildDateCondition(watchHistory.watchedAt, {
    date: c.req.query('date'),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });

  let groupExpr;
  if (period === 'weekly') {
    groupExpr = sql`substr(${watchHistory.watchedAt}, 1, 4) || '-W' || printf('%02d', cast((julianday(${watchHistory.watchedAt}) - julianday(substr(${watchHistory.watchedAt}, 1, 4) || '-01-01')) / 7 as integer) + 1)`;
  } else {
    // monthly
    groupExpr = sql`substr(${watchHistory.watchedAt}, 1, 7)`;
  }

  const baseQuery = db
    .select({
      period: groupExpr,
      total: count(),
    })
    .from(watchHistory)
    .groupBy(groupExpr)
    .orderBy(asc(groupExpr));

  const trendData = dateCondition
    ? await baseQuery.where(dateCondition)
    : await baseQuery;

  return c.json({
    period,
    data: trendData.map((t) => ({
      period: t.period,
      count: t.total,
    })),
  }) as any;
});

// ─── TV Shows ────────────────────────────────────────────────────────

watching.openapi(showsListRoute, async (c) => {
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
  }) as any;
});

// ─── Show detail ─────────────────────────────────────────────────────

watching.openapi(showDetailRoute, async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return badRequest(c, 'Invalid show ID') as any;
  }

  const [show] = await db
    .select()
    .from(plexShows)
    .where(eq(plexShows.id, id))
    .limit(1);

  if (!show) {
    return notFound(c, 'Show not found') as any;
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

  const firstWatchedAt =
    episodesWatched.length > 0 ? episodesWatched[0].watchedAt : null;

  return c.json({
    id: show.id,
    title: show.title,
    year: show.year,
    tmdb_id: show.tmdbId,
    tmdb_rating: show.tmdbRating,
    content_rating: show.contentRating,
    summary: show.summary,
    image,
    first_watched_at: firstWatchedAt,
    total_seasons: show.totalSeasons,
    total_episodes: show.totalEpisodes,
    episodes_watched: episodesWatched.length,
    seasons: Object.entries(seasons).map(([seasonNum, episodes]) => ({
      season_number: parseInt(seasonNum),
      episodes_watched: episodes.length,
      episodes,
    })),
  }) as any;
});

// ─── Season detail ───────────────────────────────────────────────────

watching.openapi(seasonDetailRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'));
  const season = parseInt(c.req.param('season'));

  if (isNaN(id) || isNaN(season)) {
    return badRequest(c, 'Invalid show ID or season number') as any;
  }

  const [show] = await db
    .select()
    .from(plexShows)
    .where(eq(plexShows.id, id))
    .limit(1);

  if (!show) {
    return notFound(c, 'Show not found') as any;
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
  }) as any;
});

// ─── Ratings ────────────────────────────────────────────────────────

watching.openapi(ratingsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const page = Math.max(parseInt(c.req.query('page') || '1'), 1);
  const limit = Math.min(
    Math.max(parseInt(c.req.query('limit') || '20'), 1),
    100
  );
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
    orderByClause =
      order === 'asc'
        ? asc(watchHistory.watchedAt)
        : desc(watchHistory.watchedAt);
  } else {
    orderByClause =
      order === 'asc'
        ? asc(watchHistory.userRating)
        : desc(watchHistory.userRating);
  }

  const rows = await db
    .select({
      watchId: watchHistory.id,
      watchedAt: watchHistory.watchedAt,
      userRating: watchHistory.userRating,
      reviewUrl: watchHistory.reviewUrl,
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
  const imageMap = await getImageAttachmentBatch(
    db,
    'watching',
    'movies',
    movieIds
  );

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
      review_url: r.reviewUrl ?? null,
      watched_at: r.watchedAt,
      source: r.source,
    })),
    pagination: paginate(page, limit, total),
  }) as any;
});

// ─── Reviews ────────────────────────────────────────────────────────

watching.openapi(reviewsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const page = Math.max(parseInt(c.req.query('page') || '1'), 1);
  const limit = Math.min(
    Math.max(parseInt(c.req.query('limit') || '20'), 1),
    100
  );
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
      reviewUrl: watchHistory.reviewUrl,
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
  const imageMap = await getImageAttachmentBatch(
    db,
    'watching',
    'movies',
    movieIds
  );

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
      review_url: r.reviewUrl ?? null,
      watched_at: r.watchedAt,
      source: r.source,
    })),
    pagination: paginate(page, limit, total),
  }) as any;
});

// ─── Year in Review ─────────────────────────────────────────────────

watching.openapi(yearInReviewRoute, async (c) => {
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
  const imageMap = await getImageAttachmentBatch(
    db,
    'watching',
    'movies',
    movieIds
  );

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
  }) as any;
});

// ─── Admin: Manual movie entry ───────────────────────────────────────

watching.openapi(adminCreateMovieRoute, async (c) => {
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
    return badRequest(c, 'Either tmdb_id or title is required') as any;
  }

  const tmdbClient = new TmdbClient(c.env.TMDB_API_KEY);

  const result = await resolveMovie(db, tmdbClient, {
    tmdbId: body.tmdb_id,
    title: body.title || '',
    year: body.year,
  });

  if (!result) {
    return notFound(c, 'No matching movie found on TMDB') as any;
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
    ) as any;
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
  ) as any;
});

// ─── Admin: Edit watch event ─────────────────────────────────────────

watching.openapi(adminEditMovieRoute, async (c) => {
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return badRequest(c, 'Invalid watch event ID') as any;
  }

  const [existing] = await db
    .select()
    .from(watchHistory)
    .where(eq(watchHistory.id, id))
    .limit(1);

  if (!existing) {
    return notFound(c, 'Watch event not found') as any;
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
    return badRequest(c, 'No fields to update') as any;
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
  }) as any;
});

// ─── Admin: Delete watch event ───────────────────────────────────────

watching.openapi(adminDeleteMovieRoute, async (c) => {
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return badRequest(c, 'Invalid watch event ID') as any;
  }

  const [existing] = await db
    .select()
    .from(watchHistory)
    .where(eq(watchHistory.id, id))
    .limit(1);

  if (!existing) {
    return notFound(c, 'Watch event not found') as any;
  }

  await db.delete(watchHistory).where(eq(watchHistory.id, id));

  // Update stats
  await computeWatchStats(db);

  return c.json({ success: true, deleted_id: id }) as any;
});

// ─── Admin: Backfill images ─────────────────────────────────────────

watching.openapi(adminBackfillImagesRoute, async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req
    .json<{
      type?: string;
      limit?: number;
      offset?: number;
      dry_run?: boolean;
      force?: boolean;
    }>()
    .catch(() => ({
      type: undefined,
      limit: undefined,
      offset: undefined,
      dry_run: undefined,
      force: undefined,
    }));

  const entityType = body.type || 'movies';
  if (!['movies', 'shows', 'all'].includes(entityType)) {
    return badRequest(c, 'Invalid type. Valid: movies, shows, all') as any;
  }
  const maxItems = Math.min(body.limit || 50, 200);
  const itemOffset = Math.max(body.offset || 0, 0);
  const dryRun = body.dry_run === true;
  const force = body.force === true;

  const results: Record<string, unknown> = {};

  if (entityType === 'movies' || entityType === 'all') {
    // Get movies with tmdb_id; force mode includes movies that already have images
    const movieRows = await db
      .select({
        id: movies.id,
        title: movies.title,
        tmdbId: movies.tmdbId,
      })
      .from(movies)
      .where(
        force
          ? sql`${movies.tmdbId} IS NOT NULL`
          : sql`${movies.tmdbId} IS NOT NULL AND ${movies.id} NOT IN (
            SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
            WHERE ${images.domain} = 'watching' AND ${images.entityType} = 'movies'
          )`
      )
      .orderBy(asc(movies.id))
      .offset(itemOffset)
      .limit(maxItems);

    if (dryRun) {
      // Resolve images from TMDB without fetching/uploading — return URLs for review
      const preview = [];
      for (const m of movieRows) {
        const candidates = await resolveImage(
          {
            domain: 'watching',
            entityType: 'movies',
            entityId: String(m.id),
            tmdbId: String(m.tmdbId),
          },
          c.env
        );
        preview.push({
          id: m.id,
          title: m.title,
          tmdb_id: m.tmdbId,
          candidates: candidates.map((img) => ({
            source: img.source,
            url: img.url,
          })),
        });
      }
      results.movies = { total: movieRows.length, preview };
    } else {
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
  }

  if (entityType === 'shows' || entityType === 'all') {
    // Get shows with tmdb_id; force mode includes shows that already have images
    const showRows = await db
      .select({
        id: plexShows.id,
        title: plexShows.title,
        tmdbId: plexShows.tmdbId,
      })
      .from(plexShows)
      .where(
        force
          ? sql`${plexShows.tmdbId} IS NOT NULL`
          : sql`${plexShows.tmdbId} IS NOT NULL AND ${plexShows.id} NOT IN (
            SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
            WHERE ${images.domain} = 'watching' AND ${images.entityType} = 'shows'
          )`
      )
      .orderBy(asc(plexShows.id))
      .offset(itemOffset)
      .limit(maxItems);

    if (dryRun) {
      const preview = [];
      for (const s of showRows) {
        const candidates = await resolveImage(
          {
            domain: 'watching',
            entityType: 'shows',
            entityId: String(s.id),
            tmdbId: String(s.tmdbId),
          },
          c.env
        );
        preview.push({
          id: s.id,
          title: s.title,
          tmdb_id: s.tmdbId,
          candidates: candidates.map((img) => ({
            source: img.source,
            url: img.url,
          })),
        });
      }
      results.shows = { total: showRows.length, preview };
    } else {
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
  }

  return c.json({ success: true, dry_run: dryRun, results }) as any;
});

export default watching;
