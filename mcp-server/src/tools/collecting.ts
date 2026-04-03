import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from '../client.js';
import {
  withErrorHandling,
  fmt,
  READ_ONLY_ANNOTATIONS,
  dateFilterParams,
} from './helpers.js';

export function registerCollectingTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_vinyl_collection
  server.tool(
    'get_vinyl_collection',
    'Browse the vinyl record collection from Discogs. Returns records with artist, title, year, format, and label. Supports search by artist or title, and pagination.',
    {
      query: z
        .string()
        .optional()
        .describe(
          "Optional: search by artist or album title (e.g. 'Beastie Boys', 'Dark Side')"
        ),
      format: z
        .string()
        .optional()
        .describe(
          "Optional: filter by format (e.g. 'Vinyl', 'CD', 'Cassette')"
        ),
      genre: z.string().optional().describe('Optional: filter by genre'),
      artist: z.string().optional().describe('Optional: filter by artist name'),
      sort: z
        .string()
        .optional()
        .describe(
          'Optional: sort field (default: date_added). Options: date_added, title, year, artist'
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
        .describe('Number of records to return'),
      page: z.number().min(1).default(1).describe('Page number for pagination'),
      ...dateFilterParams,
    },
    READ_ONLY_ANNOTATIONS,
    async ({
      query,
      format,
      genre,
      artist,
      sort,
      order,
      limit,
      page,
      date,
      from,
      to,
    }) =>
      withErrorHandling(async () => {
        const data = await client.get<{
          data: Array<{
            id: number;
            title: string;
            artists: string[];
            year: number | null;
            format: string;
            format_detail: string;
            label: string;
            genres: string[];
            date_added: string | null;
          }>;
          pagination: {
            page: number;
            limit: number;
            total: number;
            total_pages: number;
          };
        }>('/collecting/vinyl', {
          q: query,
          format,
          genre,
          artist,
          sort,
          order,
          limit,
          page,
          date,
          from,
          to,
        });

        if (!data.data.length) return 'No vinyl records found.';

        const lines = [
          `Vinyl Collection (page ${data.pagination.page} of ${data.pagination.total_pages}, ${fmt(data.pagination.total)} total):`,
        ];

        for (const [i, r] of data.data.entries()) {
          const num =
            (data.pagination.page - 1) * data.pagination.limit + i + 1;
          const artist = r.artists.join(', ');
          const year = r.year ? ` (${r.year})` : '';
          const format = r.format_detail
            ? ` [${r.format_detail}]`
            : ` [${r.format}]`;
          lines.push(
            `${num}. ${artist} -- ${r.title}${year}${format} (${r.label})`
          );
        }

        if (data.pagination.total_pages > data.pagination.page) {
          lines.push(
            `\nPage ${data.pagination.page} of ${data.pagination.total_pages}. Use page=${data.pagination.page + 1} to see more.`
          );
        }

        return lines.join('\n');
      })
  );

  // get_collecting_stats
  server.tool(
    'get_collecting_stats',
    'Get overall collection statistics including total items, format breakdown (vinyl, CD, cassette), unique artists, genre data, and year range. Supports date filtering.',
    { ...dateFilterParams },
    READ_ONLY_ANNOTATIONS,
    async ({ date, from, to }) =>
      withErrorHandling(async () => {
        const { data } = await client.get<{
          data: {
            total_items: number;
            by_format: Record<string, number>;
            wantlist_count: number | null;
            unique_artists: number | null;
            top_genre: string | null;
            oldest_release_year: number | null;
            newest_release_year: number | null;
            added_this_year: number | null;
          };
        }>('/collecting/stats', { date, from, to });

        const lines = [
          'Collection Stats:',
          `- Total items: ${fmt(data.total_items)}`,
        ];

        if (data.by_format && Object.keys(data.by_format).length) {
          lines.push('- By format:');
          for (const [format, count] of Object.entries(data.by_format)) {
            lines.push(`    ${format}: ${fmt(count as number)}`);
          }
        }

        if (data.unique_artists)
          lines.push(`- Unique artists: ${fmt(data.unique_artists)}`);
        if (data.top_genre) lines.push(`- Top genre: ${data.top_genre}`);
        if (data.wantlist_count)
          lines.push(`- Wantlist: ${fmt(data.wantlist_count)}`);
        if (data.oldest_release_year && data.newest_release_year) {
          lines.push(
            `- Year range: ${data.oldest_release_year} -- ${data.newest_release_year}`
          );
        }
        if (data.added_this_year)
          lines.push(`- Added this year: ${data.added_this_year}`);

        return lines.join('\n');
      })
  );

  // get_physical_media
  server.tool(
    'get_physical_media',
    'Browse the physical media collection (Blu-ray, 4K UHD, HD DVD). Search by title, filter by format. Supports pagination.',
    {
      query: z
        .string()
        .optional()
        .describe(
          "Optional: search by title (e.g. 'Princess Bride', 'Kubrick')"
        ),
      media_type: z
        .enum(['bluray', 'uhd_bluray', 'hddvd'])
        .optional()
        .describe('Optional: filter by format (bluray, uhd_bluray, hddvd)'),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of items to return'),
      page: z.number().min(1).default(1).describe('Page number for pagination'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ query, media_type, limit, page }) =>
      withErrorHandling(async () => {
        const data = await client.get<{
          data: Array<{
            id: number;
            title: string;
            year: number | null;
            media_type: string;
            tmdb_rating: number | null;
            collected_at: string | null;
          }>;
          pagination: {
            page: number;
            limit: number;
            total: number;
            total_pages: number;
          };
        }>('/collecting/media', { q: query, media_type, limit, page });

        if (!data.data.length) return 'No physical media found.';

        const formatLabel: Record<string, string> = {
          bluray: 'Blu-ray',
          uhd_bluray: '4K UHD',
          hddvd: 'HD DVD',
        };

        const header = media_type
          ? `${formatLabel[media_type] ?? media_type} Collection`
          : 'Physical Media Collection';

        const lines = [
          `${header} (page ${data.pagination.page} of ${data.pagination.total_pages}, ${fmt(data.pagination.total)} total):`,
        ];

        for (const [i, m] of data.data.entries()) {
          const num =
            (data.pagination.page - 1) * data.pagination.limit + i + 1;
          const year = m.year ? ` (${m.year})` : '';
          const format = ` [${formatLabel[m.media_type] ?? m.media_type}]`;
          const rating = m.tmdb_rating ? ` -- ${m.tmdb_rating}/10` : '';
          lines.push(`${num}. ${m.title}${year}${format}${rating}`);
        }

        return lines.join('\n');
      })
  );

  // get_physical_media_stats
  server.tool(
    'get_physical_media_stats',
    'Get statistics for the physical media collection including total items and breakdown by format (Blu-ray, 4K UHD, HD DVD).',
    {},
    READ_ONLY_ANNOTATIONS,
    async () =>
      withErrorHandling(async () => {
        const { data } = await client.get<{
          data: Array<{
            name: string;
            count: number;
          }>;
        }>('/collecting/media/formats');

        const formatLabel: Record<string, string> = {
          bluray: 'Blu-ray',
          uhd_bluray: '4K UHD',
          hddvd: 'HD DVD',
        };

        const total = data.reduce((sum, f) => sum + f.count, 0);
        const lines = [
          'Physical Media Stats:',
          `- Total items: ${fmt(total)}`,
          '',
          'By format:',
        ];

        for (const f of data) {
          lines.push(`  ${formatLabel[f.name] ?? f.name}: ${fmt(f.count)}`);
        }

        return lines.join('\n');
      })
  );
}
