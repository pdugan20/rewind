/**
 * Output schemas for the watching-domain tools (issue #105, Phase 2).
 *
 * These schemas are the source of truth for the watching tools' return
 * shapes: `watching.ts` derives its `RecentWatch` / `MovieDetail` /
 * `BrowseMovie` / `Pagination` types from them via `z.infer`, so the
 * declared schema and the TypeScript type cannot drift.
 *
 * Every object schema uses `.passthrough()` so the JSON Schema advertised
 * to clients stays `additionalProperties`-open -- a field the Rewind API
 * adds later does not break client-side validation. See schemas/shared.ts.
 */
import { z } from 'zod';
import { imageSchema, paginationSchema } from './shared.js';

// --- Element schemas ------------------------------------------------------

/** A single watch event, as listed by get_recent_watches. */
export const recentWatchSchema = z
  .object({
    movie: z
      .object({
        id: z.number(),
        title: z.string(),
        year: z.number().nullable(),
        director: z.string().nullable(),
        tmdb_id: z.number().nullable(),
        // summary/tagline are detail-only fields; the recent-watches movie
        // sub-object omits them, so they are optional, not just nullable.
        summary: z.string().nullish(),
        tagline: z.string().nullish(),
        image: imageSchema(),
      })
      .passthrough(),
    watched_at: z.string(),
    user_rating: z.number().nullable(),
    rewatch: z.boolean(),
    source: z.string().nullable(),
    review: z.string().nullable(),
    review_url: z.string().nullable(),
  })
  .passthrough();

/** A movie row in a browse_movies list. */
export const browseMovieSchema = z
  .object({
    id: z.number(),
    title: z.string(),
    year: z.number().nullable(),
    director: z.string().nullable(),
    genres: z.array(z.string()),
    duration_min: z.number().nullable(),
    tmdb_id: z.number().nullable(),
    tmdb_rating: z.number().nullable(),
    image: imageSchema(),
  })
  .passthrough();

// --- Tool output schemas --------------------------------------------------

/**
 * outputSchema for get_recent_watches. The empty-state branch returns
 * `{ items: [] }`, which satisfies the same schema -- no union needed.
 */
export const recentWatchesOutputSchema = z
  .object({ items: z.array(recentWatchSchema) })
  .passthrough();

/**
 * outputSchema for get_movie_details. The tool returns the raw
 * `/watching/movies/:id` API response unchanged, so this schema describes
 * that response shape directly, including its embedded watch history.
 */
export const movieDetailsOutputSchema = z
  .object({
    id: z.number(),
    title: z.string(),
    year: z.number().nullable(),
    director: z.string().nullable(),
    directors: z.array(z.string()),
    genres: z.array(z.string()),
    duration_min: z.number().nullable(),
    rating: z.string().nullable(),
    tmdb_id: z.number().nullable(),
    tmdb_rating: z.number().nullable(),
    tagline: z.string().nullable(),
    summary: z.string().nullable(),
    imdb_id: z.string().nullable(),
    image: imageSchema(),
    watch_history: z.array(
      z
        .object({
          watched_at: z.string(),
          user_rating: z.number().nullable(),
          rewatch: z.boolean(),
          review: z.string().nullable(),
          review_url: z.string().nullable(),
          source: z.string().nullable(),
        })
        .passthrough()
    ),
  })
  .passthrough();

/** outputSchema for get_watching_stats (flat stats object). */
export const watchingStatsOutputSchema = z
  .object({
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
  })
  .passthrough();

/**
 * outputSchema for browse_movies. Both the populated and empty-state
 * branches return `{ items, pagination }` -- the empty branch carries an
 * empty `items` array but the same pagination block.
 */
export const browseMoviesOutputSchema = z
  .object({
    items: z.array(browseMovieSchema),
    pagination: paginationSchema(),
  })
  .passthrough();

/**
 * outputSchema for get_watching_genres. The empty-state branch returns
 * `{ items: [] }`, which satisfies the same schema.
 */
export const watchingGenresOutputSchema = z
  .object({
    items: z.array(
      z
        .object({
          name: z.string(),
          count: z.number(),
          percentage: z.number(),
        })
        .passthrough()
    ),
  })
  .passthrough();

/**
 * outputSchema for get_watching_decades. The empty-state branch returns
 * `{ items: [] }`, which satisfies the same schema.
 */
export const watchingDecadesOutputSchema = z
  .object({
    items: z.array(
      z
        .object({
          decade: z.number(),
          count: z.number(),
        })
        .passthrough()
    ),
  })
  .passthrough();

/**
 * outputSchema for get_watching_directors. The empty-state branch returns
 * `{ items: [] }`, which satisfies the same schema.
 */
export const watchingDirectorsOutputSchema = z
  .object({
    items: z.array(
      z
        .object({
          name: z.string(),
          count: z.number(),
        })
        .passthrough()
    ),
  })
  .passthrough();
