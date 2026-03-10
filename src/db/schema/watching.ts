import {
  integer,
  real,
  sqliteTable,
  text,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

export const movies = sqliteTable(
  'movies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    plexRatingKey: text('plex_rating_key').unique(),
    title: text('title').notNull(),
    year: integer('year'),
    tmdbId: integer('tmdb_id').unique(),
    imdbId: text('imdb_id').unique(),
    tagline: text('tagline'),
    summary: text('summary'),
    contentRating: text('content_rating'),
    runtime: integer('runtime'),
    posterPath: text('poster_path'),
    backdropPath: text('backdrop_path'),
    tmdbRating: real('tmdb_rating'),
    imageKey: text('image_key'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_movies_year').on(table.year),
    index('idx_movies_tmdb_id').on(table.tmdbId),
    index('idx_movies_user_id').on(table.userId),
  ]
);

export const genres = sqliteTable('genres', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
});

export const movieGenres = sqliteTable(
  'movie_genres',
  {
    movieId: integer('movie_id')
      .notNull()
      .references(() => movies.id),
    genreId: integer('genre_id')
      .notNull()
      .references(() => genres.id),
  },
  (table) => [
    primaryKey({ columns: [table.movieId, table.genreId] }),
    index('idx_movie_genres_genre_id').on(table.genreId),
  ]
);

export const directors = sqliteTable('directors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
});

export const movieDirectors = sqliteTable(
  'movie_directors',
  {
    movieId: integer('movie_id')
      .notNull()
      .references(() => movies.id),
    directorId: integer('director_id')
      .notNull()
      .references(() => directors.id),
  },
  (table) => [
    primaryKey({ columns: [table.movieId, table.directorId] }),
    index('idx_movie_directors_director_id').on(table.directorId),
  ]
);

export const watchHistory = sqliteTable(
  'watch_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    movieId: integer('movie_id')
      .notNull()
      .references(() => movies.id),
    watchedAt: text('watched_at').notNull(),
    source: text('source', { enum: ['plex', 'letterboxd', 'manual'] })
      .notNull()
      .default('plex'),
    userRating: real('user_rating'),
    percentComplete: real('percent_complete'),
    rewatch: integer('rewatch').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_watch_history_movie_id').on(table.movieId),
    index('idx_watch_history_watched_at').on(table.watchedAt),
    index('idx_watch_history_user_id').on(table.userId),
    index('idx_watch_history_source').on(table.source),
  ]
);

export const watchStats = sqliteTable(
  'watch_stats',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    totalMovies: integer('total_movies').notNull().default(0),
    totalWatchTimeS: integer('total_watch_time_s').notNull().default(0),
    moviesThisYear: integer('movies_this_year').notNull().default(0),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_watch_stats_user_id').on(table.userId)]
);

export const plexShows = sqliteTable(
  'plex_shows',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    plexRatingKey: text('plex_rating_key').notNull().unique(),
    title: text('title').notNull(),
    year: integer('year'),
    tmdbId: integer('tmdb_id'),
    summary: text('summary'),
    imageKey: text('image_key'),
    totalSeasons: integer('total_seasons'),
    totalEpisodes: integer('total_episodes'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_plex_shows_user_id').on(table.userId),
    index('idx_plex_shows_tmdb_id').on(table.tmdbId),
  ]
);

export const plexEpisodesWatched = sqliteTable(
  'plex_episodes_watched',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    showId: integer('show_id')
      .notNull()
      .references(() => plexShows.id),
    seasonNumber: integer('season_number').notNull(),
    episodeNumber: integer('episode_number').notNull(),
    title: text('title'),
    watchedAt: text('watched_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_plex_episodes_watched_show_id').on(table.showId),
    index('idx_plex_episodes_watched_watched_at').on(table.watchedAt),
    index('idx_plex_episodes_watched_user_id').on(table.userId),
    uniqueIndex('idx_plex_episodes_unique').on(
      table.showId,
      table.seasonNumber,
      table.episodeNumber,
      table.watchedAt
    ),
  ]
);
