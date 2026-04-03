import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from '../client.js';
import {
  withErrorHandling,
  timeAgo,
  fmt,
  READ_ONLY_ANNOTATIONS,
} from './helpers.js';

export function registerCrossDomainTools(
  server: McpServer,
  client: RewindClient
): void {
  // search
  server.tool(
    'search',
    'Search across all domains (listening, running, watching, collecting, reading) using full-text search. Returns matching artists, albums, movies, articles, runs, and more.',
    {
      query: z.string().describe('Search query text'),
      domain: z
        .enum(['listening', 'running', 'watching', 'collecting', 'reading'])
        .optional()
        .describe('Optional: filter results to a single domain'),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of results to return'),
      page: z.number().min(1).default(1).describe('Page number for pagination'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ query, domain, limit, page }) =>
      withErrorHandling(async () => {
        const params: Record<string, string | number> = {
          q: query,
          limit,
          page,
        };
        if (domain) params.domain = domain;

        const data = await client.get<{
          data: Array<{
            domain: string;
            entity_type: string;
            title: string;
            subtitle: string | null;
          }>;
          pagination: { total: number };
        }>('/search', params);

        if (!data.data.length)
          return `No results found for "${query}"${domain ? ` in ${domain}` : ''}.`;

        const lines = [
          `Search results for "${query}" (${fmt(data.pagination.total)} total):`,
        ];

        for (const [i, r] of data.data.entries()) {
          const sub = r.subtitle ? ` -- ${r.subtitle}` : '';
          lines.push(
            `${i + 1}. [${r.domain}/${r.entity_type}] ${r.title}${sub}`
          );
        }

        return lines.join('\n');
      })
  );

  // get_feed
  server.tool(
    'get_feed',
    'Get the unified activity feed across all domains. Returns a chronological list of recent activities (listens, runs, watches, reads, collection adds). Supports date filtering.',
    {
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of feed items to return'),
      domain: z
        .enum(['listening', 'running', 'watching', 'collecting', 'reading'])
        .optional()
        .describe('Optional: filter feed to a single domain'),
      date: z
        .string()
        .optional()
        .describe('Optional: filter to a specific date (YYYY-MM-DD)'),
      from: z
        .string()
        .optional()
        .describe('Optional: start of date range (ISO 8601)'),
      to: z
        .string()
        .optional()
        .describe('Optional: end of date range (ISO 8601)'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ limit, domain, date, from, to }) =>
      withErrorHandling(async () => {
        const params: Record<string, string | number | undefined> = {
          limit,
          date,
          from,
          to,
        };

        const path = domain ? `/feed/domain/${domain}` : '/feed';
        const data = await client.get<{
          data: Array<{
            domain: string;
            event_type: string;
            occurred_at: string;
            title: string;
            subtitle: string | null;
          }>;
          pagination: { has_more: boolean };
        }>(path, params);

        if (!data.data.length)
          return 'No feed activity found for the given filters.';

        const lines = ['Activity Feed:'];
        for (const item of data.data) {
          const sub = item.subtitle ? ` -- ${item.subtitle}` : '';
          lines.push(
            `- [${item.domain}] ${item.title}${sub} (${timeAgo(item.occurred_at)})`
          );
        }

        if (data.pagination.has_more) {
          lines.push(
            '\nMore items available. Increase limit or narrow date range.'
          );
        }

        return lines.join('\n');
      })
  );

  // get_on_this_day
  server.tool(
    'get_on_this_day',
    "Get historical 'on this day' items -- what happened on a given date in previous years across all domains. Defaults to today. Great for nostalgia and reflection.",
    {
      month: z
        .number()
        .min(1)
        .max(12)
        .optional()
        .describe('Optional: month (1-12). Defaults to current month.'),
      day: z
        .number()
        .min(1)
        .max(31)
        .optional()
        .describe('Optional: day (1-31). Defaults to current day.'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ month, day }) =>
      withErrorHandling(async () => {
        const params: Record<string, number | undefined> = { month, day };
        const data = await client.get<{
          month: number;
          day: number;
          years: Array<{
            year: number;
            items: Array<{
              domain: string;
              event_type: string;
              title: string;
              subtitle: string | null;
            }>;
          }>;
        }>('/feed/on-this-day', params);

        if (!data.years.length) return "No 'on this day' history found.";

        const lines = [`On This Day (${data.month}/${data.day}):`];

        for (const yearGroup of data.years) {
          lines.push('');
          lines.push(`${yearGroup.year}:`);
          for (const item of yearGroup.items) {
            const sub = item.subtitle ? ` -- ${item.subtitle}` : '';
            lines.push(`  - [${item.domain}] ${item.title}${sub}`);
          }
        }

        return lines.join('\n');
      })
  );
}
