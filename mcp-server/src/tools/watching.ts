import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from '../client.js';
import {
  withRichResponse,
  text,
  resourceLink,
  imageBlock,
  formatDate,
  timeAgo,
  fmt,
  formatStars,
  READ_ONLY_ANNOTATIONS,
  dateFilterParams,
  includeImagesParam,
  LIST_IMAGE_PX,
  type ContentBlock,
} from './helpers.js';
import { paginationSchema } from './schemas/shared.js';
import {
  recentWatchesOutputSchema,
  movieDetailsOutputSchema,
  watchingStatsOutputSchema,
  browseMoviesOutputSchema,
  watchingGenresOutputSchema,
  watchingDecadesOutputSchema,
  watchingDirectorsOutputSchema,
} from './schemas/watching.js';

const POSTER_TOP_N = 5;

// Types below are derived from the Zod output schemas (schemas/watching.ts)
// so the declared schema and the TS type cannot drift.
type RecentWatch = z.infer<typeof recentWatchesOutputSchema>['items'][number];

type MovieDetail = z.infer<typeof movieDetailsOutputSchema>;

type BrowseMovie = z.infer<typeof browseMoviesOutputSchema>['items'][number];

type Pagination = z.infer<ReturnType<typeof paginationSchema>>;

export function registerWatchingTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_recent_watches ─────────────────────────────────────────────
  // Registered via the modern server.registerTool so we can attach
  // `_meta.ui.resourceUri`. Hosts that support MCP Apps (Claude Desktop,
  // Claude web, VS Code Copilot) render the poster grid inline; others fall
  // back to the text + image + resource_link response.
  server.registerTool(
    'get_recent_watches',
    {
      title: 'Recent watches',
      description:
        'Get recently watched movies and TV shows from Plex and Letterboxd. Returns titles, ratings, watch dates, top-N posters, and Letterboxd review links where available. In MCP Apps hosts, renders an interactive poster grid inline.',
      inputSchema: {
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe('Number of recent watches to return (max 50)'),
        page: z
          .number()
          .min(1)
          .default(1)
          .describe(
            'Page number for pagination (1-indexed). Combine with limit to page through longer windows like "last month".'
          ),
        ...dateFilterParams,
        ...includeImagesParam,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: recentWatchesOutputSchema,
      _meta: {
        ui: { resourceUri: 'ui://rewind/recent-watches.html' },
        'ui/resourceUri': 'ui://rewind/recent-watches.html',
      },
    },
    async ({ limit, page, date, from, to, include_images }) =>
      withRichResponse(async () => {
        const { data: raw } = await client.get<{ data: RecentWatch[] }>(
          '/watching/recent',
          { limit, page, date, from, to }
        );

        // Dedup by movie id, keep the most recent watch event per movie.
        // `/v1/watching/recent` returns every watch event, which produces
        // duplicates when a film has both a Plex record and a Letterboxd
        // log (or a sync created multiple entries).
        const seen = new Map<number, RecentWatch>();
        for (const w of raw) {
          const existing = seen.get(w.movie.id);
          if (!existing) {
            seen.set(w.movie.id, w);
            continue;
          }
          const existingTs = Date.parse(existing.watched_at);
          const candidateTs = Date.parse(w.watched_at);
          // Prefer the record with a user_rating; otherwise the most recent.
          const prefer =
            (w.user_rating !== null && existing.user_rating === null) ||
            candidateTs > existingTs;
          if (prefer) seen.set(w.movie.id, w);
        }
        const data = Array.from(seen.values()).sort(
          (a, b) => Date.parse(b.watched_at) - Date.parse(a.watched_at)
        );

        if (!data.length) {
          return {
            content: [text('No recent watches found.')],
            structuredContent: { items: [] },
          };
        }

        const lines = ['Recent watches:'];
        for (const [i, w] of data.entries()) {
          const year = w.movie.year ? ` (${w.movie.year})` : '';
          const director = w.movie.director ? ` dir. ${w.movie.director}` : '';
          const rating =
            w.user_rating !== null ? ` -- ${formatStars(w.user_rating)}` : '';
          const rewatch = w.rewatch ? ' [rewatch]' : '';
          lines.push(
            `${i + 1}. ${w.movie.title}${year}${director}${rating}${rewatch} (${timeAgo(w.watched_at)})`
          );
        }

        const topN = data.slice(0, POSTER_TOP_N);

        const images = include_images
          ? await Promise.all(
              topN.map((w) => imageBlock(client, w.movie.image, LIST_IMAGE_PX))
            )
          : [];

        const links = topN
          .map((w) =>
            resourceLink(w.review_url, `Letterboxd -- ${w.movie.title}`, {
              mimeType: 'text/html',
            })
          )
          .filter((b): b is NonNullable<typeof b> => b !== null);

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...images.filter((b): b is NonNullable<typeof b> => b !== null),
          ...links,
        ];

        return {
          content,
          structuredContent: { items: data },
        };
      })
  );

  // get_movie_details ──────────────────────────────────────────────
  server.registerTool(
    'get_movie_details',
    {
      title: 'Movie',
      description:
        'Get detailed information about a specific movie by ID, including director, genres, rating, summary, watch history, poster image, and Letterboxd review links for rated watches.',
      inputSchema: {
        id: z.number().describe('Movie ID'),
        ...includeImagesParam,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: movieDetailsOutputSchema,
    },
    async ({ id, include_images }) =>
      withRichResponse(async () => {
        const data = await client.get<MovieDetail>(`/watching/movies/${id}`);

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
          data.tmdb_rating ? `TMDB: ${data.tmdb_rating.toFixed(1)}/10` : null,
          data.summary ? `\n${data.summary}` : null,
        ].filter((l) => l !== null);

        if (data.watch_history.length) {
          lines.push('', 'Watch History:');
          for (const w of data.watch_history) {
            const rating =
              w.user_rating !== null
                ? ` -- rated ${formatStars(w.user_rating)}`
                : '';
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

        const poster = include_images
          ? await imageBlock(client, data.image)
          : null;

        // Collect unique review URLs across the watch history
        const seen = new Set<string>();
        const reviewLinks = data.watch_history
          .map((w) => {
            if (!w.review_url || seen.has(w.review_url)) return null;
            seen.add(w.review_url);
            return resourceLink(
              w.review_url,
              `Letterboxd review (${formatDate(w.watched_at)})`,
              { mimeType: 'text/html' }
            );
          })
          .filter((b): b is NonNullable<typeof b> => b !== null);

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...(poster ? [poster] : []),
          ...reviewLinks,
        ];

        return { content, structuredContent: data };
      })
  );

  // get_watching_stats ─────────────────────────────────────────────
  server.registerTool(
    'get_watching_stats',
    {
      title: 'Watching stats',
      description:
        'Get overall watching statistics including total movies, watch time, movies this year, top genre, top director, TV show counts, and episode counts. Supports date filtering.',
      inputSchema: { ...dateFilterParams },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: watchingStatsOutputSchema,
    },
    async ({ date, from, to }) =>
      withRichResponse(async () => {
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

        const summary = [
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

        return {
          content: [text(summary)],
          structuredContent: data,
        };
      })
  );

  // browse_movies ──────────────────────────────────────────────────
  server.registerTool(
    'browse_movies',
    {
      title: 'Browse movies',
      description:
        'Browse the movie collection with filters for genre, decade, director, and year. Supports sorting, pagination, and returns top-N posters.',
      inputSchema: {
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
        year: z
          .string()
          .optional()
          .describe('Optional: filter by release year'),
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
        ...includeImagesParam,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: browseMoviesOutputSchema,
    },
    async ({
      genre,
      decade,
      director,
      year,
      sort,
      order,
      limit,
      page,
      include_images,
    }) =>
      withRichResponse(async () => {
        const data = await client.get<{
          data: BrowseMovie[];
          pagination: Pagination;
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

        if (!data.data.length) {
          return {
            content: [text('No movies found matching those filters.')],
            structuredContent: { items: [], pagination: data.pagination },
          };
        }

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
          const rating = m.tmdb_rating
            ? ` -- TMDB ${m.tmdb_rating.toFixed(1)}/10`
            : '';
          lines.push(`${num}. ${m.title}${yr}${dir}${rating}`);
        }

        const topN = data.data.slice(0, POSTER_TOP_N);
        const images = include_images
          ? await Promise.all(
              topN.map((m) => imageBlock(client, m.image, LIST_IMAGE_PX))
            )
          : [];

        // Emit a rewind://movie/{id} resource_link per item so the user can
        // drill into the full detail (Letterboxd review, watch history, etc.).
        const links = data.data
          .map((m) =>
            resourceLink(`rewind://movie/${m.id}`, `${m.title} (details)`, {
              mimeType: 'application/json',
            })
          )
          .filter((b): b is NonNullable<typeof b> => b !== null);

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...images.filter((b): b is NonNullable<typeof b> => b !== null),
          ...links,
        ];

        return {
          content,
          structuredContent: { items: data.data, pagination: data.pagination },
        };
      })
  );

  // get_watching_genres ────────────────────────────────────────────
  server.registerTool(
    'get_watching_genres',
    {
      title: 'Watching genres',
      description:
        'Get genre breakdown across all watched movies. Returns each genre with movie count and percentage of total watches.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: watchingGenresOutputSchema,
    },
    async () =>
      withRichResponse(async () => {
        const { data } = await client.get<{
          data: Array<{ name: string; count: number; percentage: number }>;
        }>('/watching/stats/genres');

        if (!data.length) {
          return {
            content: [text('No genre data available.')],
            structuredContent: { items: [] },
          };
        }

        const lines = ['Genre breakdown:'];
        for (const g of data) {
          lines.push(
            `- ${g.name}: ${fmt(g.count)} (${g.percentage.toFixed(1)}%)`
          );
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: { items: data },
        };
      })
  );

  // get_watching_decades ───────────────────────────────────────────
  server.registerTool(
    'get_watching_decades',
    {
      title: 'Watching decades',
      description:
        'Get decade breakdown across all watched movies. Returns each decade with movie count.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: watchingDecadesOutputSchema,
    },
    async () =>
      withRichResponse(async () => {
        const { data } = await client.get<{
          data: Array<{ decade: number; count: number }>;
        }>('/watching/stats/decades');

        if (!data.length) {
          return {
            content: [text('No decade data available.')],
            structuredContent: { items: [] },
          };
        }

        const lines = ['Decade breakdown:'];
        for (const d of data) {
          lines.push(`- ${d.decade}s: ${fmt(d.count)}`);
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: { items: data },
        };
      })
  );

  // get_watching_directors ─────────────────────────────────────────
  server.registerTool(
    'get_watching_directors',
    {
      title: 'Top directors',
      description:
        'Get top directors by watched-movie count. Returns directors ranked by how many of their films you have watched.',
      inputSchema: {
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(20)
          .describe('Number of directors to return'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: watchingDirectorsOutputSchema,
    },
    async ({ limit }) =>
      withRichResponse(async () => {
        const { data } = await client.get<{
          data: Array<{ name: string; count: number }>;
        }>('/watching/stats/directors', { limit });

        if (!data.length) {
          return {
            content: [text('No director data available.')],
            structuredContent: { items: [] },
          };
        }

        const lines = ['Top directors:'];
        for (const [i, d] of data.entries()) {
          lines.push(`${i + 1}. ${d.name} -- ${fmt(d.count)}`);
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: { items: data },
        };
      })
  );
}
