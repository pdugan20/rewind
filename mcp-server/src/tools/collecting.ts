import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from '../client.js';
import {
  withRichResponse,
  text,
  resourceLink,
  imageBlock,
  fmt,
  READ_ONLY_ANNOTATIONS,
  dateFilterParams,
  includeImagesParam,
  LIST_IMAGE_PX,
  type ContentBlock,
} from './helpers.js';
import {
  vinylItemSchema,
  mediaItemSchema,
  vinylCollectionOutputSchema,
  collectingStatsOutputSchema,
  physicalMediaOutputSchema,
  physicalMediaStatsOutputSchema,
} from './schemas/collecting.js';

const TOP_N = 5;

// Types below are derived from the Zod output schemas (schemas/collecting.ts)
// so the declared schema and the TS type cannot drift.
type VinylItem = z.infer<typeof vinylItemSchema>;

type MediaItem = z.infer<typeof mediaItemSchema>;

type CollectingStats = z.infer<typeof collectingStatsOutputSchema>;

type Pagination = {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
};

const FORMAT_LABEL: Record<string, string> = {
  bluray: 'Blu-ray',
  uhd_bluray: '4K UHD',
  hddvd: 'HD DVD',
};

export function registerCollectingTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_vinyl_collection ───────────────────────────────────────────
  server.registerTool(
    'get_vinyl_collection',
    {
      title: 'Vinyl collection',
      description:
        'Browse the vinyl record collection from Discogs. Returns records with artist, title, year, format, and label, plus top-N cover art and Discogs resource links. Supports search, filters, sort, and pagination.',
      inputSchema: {
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
        artist: z
          .string()
          .optional()
          .describe('Optional: filter by artist name'),
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
        page: z
          .number()
          .min(1)
          .default(1)
          .describe('Page number for pagination'),
        ...dateFilterParams,
        ...includeImagesParam,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: vinylCollectionOutputSchema,
    },
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
      include_images,
    }) =>
      withRichResponse(async () => {
        const data = await client.get<{
          data: VinylItem[];
          pagination: Pagination;
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

        if (!data.data.length) {
          return {
            content: [text('No vinyl records found.')],
            structuredContent: { items: [], pagination: data.pagination },
          };
        }

        const lines = [
          `Vinyl Collection (page ${data.pagination.page} of ${data.pagination.total_pages}, ${fmt(data.pagination.total)} total):`,
        ];

        for (const [i, r] of data.data.entries()) {
          const num =
            (data.pagination.page - 1) * data.pagination.limit + i + 1;
          const artistStr = r.artists.join(', ');
          const year = r.year ? ` (${r.year})` : '';
          const formatStr = r.format_detail
            ? ` [${r.format_detail}]`
            : ` [${r.format}]`;
          lines.push(
            `${num}. ${artistStr} -- ${r.title}${year}${formatStr} (${r.label})`
          );
        }

        if (data.pagination.total_pages > data.pagination.page) {
          lines.push(
            `\nPage ${data.pagination.page} of ${data.pagination.total_pages}. Use page=${data.pagination.page + 1} to see more.`
          );
        }

        const topN = data.data.slice(0, TOP_N);
        const images = include_images
          ? await Promise.all(
              topN.map((r) => imageBlock(client, r.image, LIST_IMAGE_PX))
            )
          : [];
        const links = topN
          .map((r) =>
            resourceLink(r.discogs_url, `Discogs -- ${r.title}`, {
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
          structuredContent: { items: data.data, pagination: data.pagination },
        };
      })
  );

  // get_collecting_stats ───────────────────────────────────────────
  server.registerTool(
    'get_collecting_stats',
    {
      title: 'Collection stats',
      description:
        'Get overall collection statistics including total items, format breakdown (vinyl, CD, cassette), unique artists, genre data, and year range. Supports date filtering.',
      inputSchema: { ...dateFilterParams },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: collectingStatsOutputSchema,
    },
    async ({ date, from, to }) =>
      withRichResponse(async () => {
        const { data } = await client.get<{ data: CollectingStats }>(
          '/collecting/stats',
          {
            date,
            from,
            to,
          }
        );

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

        return { content: [text(lines.join('\n'))], structuredContent: data };
      })
  );

  // get_physical_media ─────────────────────────────────────────────
  server.registerTool(
    'get_physical_media',
    {
      title: 'Physical media',
      description:
        'Browse the physical media collection (Blu-ray, 4K UHD, HD DVD). Search by title, filter by format. Returns top-N cover art and pagination.',
      inputSchema: {
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
        page: z
          .number()
          .min(1)
          .default(1)
          .describe('Page number for pagination'),
        ...includeImagesParam,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: physicalMediaOutputSchema,
    },
    async ({ query, media_type, limit, page, include_images }) =>
      withRichResponse(async () => {
        const data = await client.get<{
          data: MediaItem[];
          pagination: Pagination;
        }>('/collecting/media', { q: query, media_type, limit, page });

        if (!data.data.length) {
          return {
            content: [text('No physical media found.')],
            structuredContent: { items: [], pagination: data.pagination },
          };
        }

        const header = media_type
          ? `${FORMAT_LABEL[media_type] ?? media_type} Collection`
          : 'Physical Media Collection';

        const lines = [
          `${header} (page ${data.pagination.page} of ${data.pagination.total_pages}, ${fmt(data.pagination.total)} total):`,
        ];

        for (const [i, m] of data.data.entries()) {
          const num =
            (data.pagination.page - 1) * data.pagination.limit + i + 1;
          const year = m.year ? ` (${m.year})` : '';
          const formatStr = ` [${FORMAT_LABEL[m.media_type] ?? m.media_type}]`;
          const rating = m.tmdb_rating ? ` -- ${m.tmdb_rating}/10` : '';
          lines.push(`${num}. ${m.title}${year}${formatStr}${rating}`);
        }

        const topN = data.data.slice(0, TOP_N);
        const images = include_images
          ? await Promise.all(
              topN.map((m) => imageBlock(client, m.image, LIST_IMAGE_PX))
            )
          : [];

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...images.filter((b): b is NonNullable<typeof b> => b !== null),
        ];

        return {
          content,
          structuredContent: { items: data.data, pagination: data.pagination },
        };
      })
  );

  // get_physical_media_stats ───────────────────────────────────────
  server.registerTool(
    'get_physical_media_stats',
    {
      title: 'Physical media stats',
      description:
        'Get statistics for the physical media collection including total items and breakdown by format (Blu-ray, 4K UHD, HD DVD).',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: physicalMediaStatsOutputSchema,
    },
    async () =>
      withRichResponse(async () => {
        const { data } = await client.get<{
          data: Array<{ name: string; count: number }>;
        }>('/collecting/media/formats');

        const total = data.reduce((sum, f) => sum + f.count, 0);
        const lines = [
          'Physical Media Stats:',
          `- Total items: ${fmt(total)}`,
          '',
          'By format:',
        ];

        for (const f of data) {
          lines.push(`  ${FORMAT_LABEL[f.name] ?? f.name}: ${fmt(f.count)}`);
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: { total, formats: data },
        };
      })
  );
}
