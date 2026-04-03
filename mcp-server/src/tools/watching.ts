import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from '../client.js';
import {
  withErrorHandling,
  formatDate,
  timeAgo,
  fmt,
  READ_ONLY_ANNOTATIONS,
  dateFilterParams,
} from './helpers.js';

export function registerWatchingTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_recent_watches
  server.tool(
    'get_recent_watches',
    'Get recently watched movies and TV shows from Plex and Letterboxd. Returns titles, ratings, and watch dates.',
    {
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of recent watches to return'),
      ...dateFilterParams,
    },
    READ_ONLY_ANNOTATIONS,
    async ({ limit, date, from, to }) =>
      withErrorHandling(async () => {
        const { data } = await client.get<{
          data: Array<{
            movie: {
              title: string;
              year: number | null;
              director: string | null;
            };
            watched_at: string;
            user_rating: number | null;
            rewatch: boolean;
            source: string | null;
          }>;
        }>('/watching/recent', { limit, date, from, to });

        if (!data.length) return 'No recent watches found.';

        const lines = ['Recent watches:'];
        for (const [i, w] of data.entries()) {
          const year = w.movie.year ? ` (${w.movie.year})` : '';
          const director = w.movie.director ? ` dir. ${w.movie.director}` : '';
          const rating =
            w.user_rating !== null ? ` -- ${w.user_rating}/10` : '';
          const rewatch = w.rewatch ? ' [rewatch]' : '';
          lines.push(
            `${i + 1}. ${w.movie.title}${year}${director}${rating}${rewatch} (${timeAgo(w.watched_at)})`
          );
        }
        return lines.join('\n');
      })
  );

  // get_movie_details
  server.tool(
    'get_movie_details',
    'Get detailed information about a specific movie by ID, including director, genres, rating, summary, and watch history.',
    { id: z.number().describe('Movie ID') },
    READ_ONLY_ANNOTATIONS,
    async ({ id }) =>
      withErrorHandling(async () => {
        const data = await client.get<{
          title: string;
          year: number | null;
          director: string | null;
          directors: string[];
          genres: string[];
          duration_min: number | null;
          rating: string | null;
          tmdb_rating: number | null;
          tagline: string | null;
          summary: string | null;
          imdb_id: string | null;
          watch_history: Array<{
            watched_at: string;
            user_rating: number | null;
            rewatch: boolean;
            review: string | null;
            source: string | null;
          }>;
        }>(`/watching/movies/${id}`);

        const lines = [
          `${data.title}${data.year ? ` (${data.year})` : ''}`,
          data.tagline ? `"${data.tagline}"` : null,
          '',
          data.directors.length
            ? `Director${data.directors.length > 1 ? 's' : ''}: ${data.directors.join(', ')}`
            : null,
          data.genres.length ? `Genres: ${data.genres.join(', ')}` : null,
          data.duration_min ? `Runtime: ${data.duration_min} min` : null,
          data.rating ? `Rated: ${data.rating}` : null,
          data.tmdb_rating ? `TMDB: ${data.tmdb_rating}/10` : null,
          data.summary ? `\n${data.summary}` : null,
        ].filter((l) => l !== null);

        if (data.watch_history.length) {
          lines.push('', 'Watch History:');
          for (const w of data.watch_history) {
            const rating =
              w.user_rating !== null ? ` -- rated ${w.user_rating}/10` : '';
            const rewatch = w.rewatch ? ' [rewatch]' : '';
            const source = w.source ? ` via ${w.source}` : '';
            lines.push(
              `  - ${formatDate(w.watched_at)}${rating}${rewatch}${source}`
            );
            if (w.review) {
              lines.push(
                `    Review: ${w.review.slice(0, 200)}${w.review.length > 200 ? '...' : ''}`
              );
            }
          }
        }

        return lines.join('\n');
      })
  );

  // get_watching_stats
  server.tool(
    'get_watching_stats',
    'Get overall watching statistics including total movies, watch time, movies this year, top genre, top director, TV show counts, and episode counts. Supports date filtering.',
    { ...dateFilterParams },
    READ_ONLY_ANNOTATIONS,
    async ({ date, from, to }) =>
      withErrorHandling(async () => {
        const { data } = await client.get<{
          data: {
            total_movies: number;
            total_watch_time_hours: number;
            movies_this_year: number;
            avg_per_month: number;
            top_genre: string | null;
            top_decade: number | null;
            top_director: string | null;
            total_shows: number;
            total_episodes_watched: number;
            episodes_this_year: number;
          };
        }>('/watching/stats', { date, from, to });

        return [
          'Watching Stats:',
          '',
          'Movies:',
          `- Total movies: ${fmt(data.total_movies)}`,
          `- Total watch time: ${fmt(Math.round(data.total_watch_time_hours))} hours`,
          `- Movies this year: ${data.movies_this_year}`,
          `- Average per month: ${data.avg_per_month.toFixed(1)}`,
          data.top_genre ? `- Top genre: ${data.top_genre}` : null,
          data.top_director ? `- Top director: ${data.top_director}` : null,
          data.top_decade ? `- Top decade: ${data.top_decade}s` : null,
          '',
          'TV Shows:',
          `- Total shows: ${fmt(data.total_shows)}`,
          `- Total episodes: ${fmt(data.total_episodes_watched)}`,
          `- Episodes this year: ${data.episodes_this_year}`,
        ]
          .filter((l) => l !== null)
          .join('\n');
      })
  );

  // browse_movies
  server.tool(
    'browse_movies',
    'Browse the movie collection with filters for genre, decade, director, and year. Supports sorting and pagination.',
    {
      genre: z
        .string()
        .optional()
        .describe(
          "Optional: filter by genre (e.g. 'Horror', 'Comedy', 'Drama')"
        ),
      decade: z
        .string()
        .optional()
        .describe("Optional: filter by decade (e.g. '1990', '2000')"),
      director: z
        .string()
        .optional()
        .describe('Optional: filter by director name'),
      year: z.string().optional().describe('Optional: filter by release year'),
      sort: z
        .string()
        .optional()
        .describe(
          'Optional: sort by field (default: watched_at). Options: watched_at, title, year, rating'
        ),
      order: z
        .enum(['asc', 'desc'])
        .optional()
        .describe('Optional: sort order (default: desc)'),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of movies to return'),
      page: z.number().min(1).default(1).describe('Page number'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ genre, decade, director, year, sort, order, limit, page }) =>
      withErrorHandling(async () => {
        const data = await client.get<{
          data: Array<{
            id: number;
            title: string;
            year: number | null;
            director: string | null;
            genres: string[];
            duration_min: number | null;
            tmdb_rating: number | null;
          }>;
          pagination: {
            page: number;
            limit: number;
            total: number;
            total_pages: number;
          };
        }>('/watching/movies', {
          genre,
          decade,
          director,
          year,
          sort,
          order,
          limit,
          page,
        });

        if (!data.data.length) return 'No movies found matching those filters.';

        const filters = [genre, decade, director, year].filter(Boolean);
        const header = filters.length
          ? `Movies (filtered: ${filters.join(', ')})`
          : `Movies (page ${data.pagination.page} of ${data.pagination.total_pages})`;

        const lines = [`${header} -- ${fmt(data.pagination.total)} total:`];
        for (const [i, m] of data.data.entries()) {
          const num =
            (data.pagination.page - 1) * data.pagination.limit + i + 1;
          const yr = m.year ? ` (${m.year})` : '';
          const dir = m.director ? ` dir. ${m.director}` : '';
          const rating = m.tmdb_rating ? ` -- ${m.tmdb_rating}/10` : '';
          lines.push(`${num}. [ID: ${m.id}] ${m.title}${yr}${dir}${rating}`);
        }

        return lines.join('\n');
      })
  );
}
