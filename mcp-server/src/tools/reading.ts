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

export function registerReadingTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_recent_reads
  server.tool(
    'get_recent_reads',
    'Get recently saved articles from Instapaper. Returns article titles, authors, domains, reading time, and status.',
    {
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of recent articles to return'),
      ...dateFilterParams,
    },
    READ_ONLY_ANNOTATIONS,
    async ({ limit, date, from, to }) =>
      withErrorHandling(async () => {
        const { data } = await client.get<{
          data: Array<{
            id: number;
            title: string;
            author: string | null;
            domain: string | null;
            estimated_read_min: number | null;
            status: string;
            progress: number;
            saved_at: string;
          }>;
        }>('/reading/recent', { limit, date, from, to });

        if (!data.length) return 'No recent articles found.';

        const lines = ['Recent reads:'];
        for (const [i, a] of data.entries()) {
          const author = a.author ? ` by ${a.author}` : '';
          const domain = a.domain ? ` (${a.domain})` : '';
          const readTime = a.estimated_read_min
            ? ` -- ${a.estimated_read_min} min read`
            : '';
          const status =
            a.status === 'reading'
              ? ` [${Math.round(a.progress * 100)}%]`
              : a.status === 'archived'
                ? ' [finished]'
                : '';
          lines.push(
            `${i + 1}. ${a.title}${author}${domain}${readTime}${status} (${timeAgo(a.saved_at)})`
          );
        }
        return lines.join('\n');
      })
  );

  // get_reading_highlights
  server.tool(
    'get_reading_highlights',
    'Get saved highlights from Instapaper articles. Returns the highlighted text, optional notes, and the source article.',
    {
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of highlights to return'),
      page: z.number().min(1).default(1).describe('Page number'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ limit, page }) =>
      withErrorHandling(async () => {
        const data = await client.get<{
          data: Array<{
            text: string;
            note: string | null;
            created_at: string;
            article: {
              title: string;
              author: string | null;
              domain: string | null;
            };
          }>;
          pagination: {
            page: number;
            total: number;
            total_pages: number;
          };
        }>('/reading/highlights', { limit, page });

        if (!data.data.length) return 'No highlights found.';

        const lines = [`Highlights (${fmt(data.pagination.total)} total):`];

        for (const h of data.data) {
          const source = h.article.author
            ? `${h.article.title} by ${h.article.author}`
            : h.article.title;
          lines.push('');
          lines.push(`"${h.text}"`);
          if (h.note) lines.push(`  Note: ${h.note}`);
          lines.push(`  -- ${source} (${formatDate(h.created_at)})`);
        }

        return lines.join('\n');
      })
  );

  // get_random_highlight
  server.tool(
    'get_random_highlight',
    'Get a single random highlight from saved Instapaper articles. Great for daily inspiration or reflection.',
    {},
    READ_ONLY_ANNOTATIONS,
    async () =>
      withErrorHandling(async () => {
        const data = await client.get<{
          text: string;
          note: string | null;
          created_at: string;
          article: {
            title: string;
            author: string | null;
            domain: string | null;
          };
        }>('/reading/highlights/random');

        const source = data.article.author
          ? `${data.article.title} by ${data.article.author}`
          : data.article.title;

        const lines = [`"${data.text}"`];
        if (data.note) lines.push(`Note: ${data.note}`);
        lines.push(`-- ${source}`);

        return lines.join('\n');
      })
  );

  // get_reading_stats
  server.tool(
    'get_reading_stats',
    'Get overall reading statistics from Instapaper including total articles, finished count, currently reading, highlights, and word count.',
    {},
    READ_ONLY_ANNOTATIONS,
    async () =>
      withErrorHandling(async () => {
        const data = await client.get<{
          total_articles: number;
          finished_count: number;
          currently_reading_count: number;
          total_highlights: number;
          total_word_count: number;
          avg_estimated_read_min: number;
        }>('/reading/stats');

        return [
          'Reading Stats:',
          `- Total articles: ${fmt(data.total_articles)}`,
          `- Finished: ${fmt(data.finished_count)}`,
          `- Currently reading: ${data.currently_reading_count}`,
          `- Total highlights: ${fmt(data.total_highlights)}`,
          `- Total words read: ${fmt(data.total_word_count)}`,
          `- Average read time: ${Math.round(data.avg_estimated_read_min)} min`,
        ].join('\n');
      })
  );
}
