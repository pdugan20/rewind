import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer): void {
  // Weekly summary prompt
  server.prompt(
    'weekly-summary',
    'Generate a summary of activity across all domains for the past week',
    {},
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              'Please summarize my activity from the past week across all domains. Use the following tools to gather the data:',
              '',
              "1. get_recent_listens (limit 20) -- what I've been listening to",
              '2. get_recent_runs (limit 10) -- any runs this week',
              "3. get_recent_watches (limit 10) -- movies or TV I've watched",
              "4. get_recent_reads (limit 10) -- articles I've been reading",
              '5. get_feed (limit 30, from: 7 days ago) -- unified activity',
              '',
              'Organize the summary by domain. Highlight patterns, notable items, and any streaks or milestones.',
              'Keep the tone casual and reflective. Use specific names, numbers, and dates from the data.',
            ].join('\n'),
          },
        },
      ],
    })
  );

  // Year in review prompt
  server.prompt(
    'year-in-review',
    'Generate a comprehensive year-in-review for a given year across all domains',
    {
      year: z.string().describe('The year to review (e.g. 2025)'),
    },
    ({ year }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Generate a year-in-review for ${year}. Gather data from all domains:`,
              '',
              '1. get_listening_stats -- overall listening numbers',
              `2. get_top_artists (period: 12month, limit: 10) -- top artists`,
              `3. get_top_albums (period: 12month, limit: 10) -- top albums`,
              '4. get_running_stats -- running totals',
              '5. get_watching_stats -- movie and TV totals',
              '6. get_collecting_stats -- collection growth',
              '7. get_reading_stats -- reading numbers',
              '',
              `Create a comprehensive but concise year-in-review for ${year}. Include:`,
              '- Key stats and totals per domain',
              '- Standout items (most-played artist, longest run, favorite movie, etc.)',
              '- Interesting patterns or changes from previous years if apparent',
              '- A brief overall reflection',
              '',
              'Format it as a readable narrative, not just a list of numbers.',
            ].join('\n'),
          },
        },
      ],
    })
  );

  // Compare periods prompt
  server.prompt(
    'compare-periods',
    'Compare activity between two time periods for a specific domain',
    {
      domain: z
        .string()
        .describe(
          'Domain to compare (listening, running, watching, collecting, reading)'
        ),
      period1: z
        .string()
        .describe(
          "First period description (e.g. 'January 2025', 'last month')"
        ),
      period2: z
        .string()
        .describe(
          "Second period description (e.g. 'January 2024', 'this month')"
        ),
    },
    ({ domain, period1, period2 }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Compare my ${domain} activity between ${period1} and ${period2}.`,
              '',
              `Use the appropriate tools for the ${domain} domain to gather data for both periods.`,
              'For each period, get stats, recent activity, and any relevant top lists.',
              '',
              'Present the comparison as:',
              '- Side-by-side key metrics',
              '- Notable differences and trends',
              '- Standout items unique to each period',
              '',
              'Keep the analysis specific and data-driven.',
            ].join('\n'),
          },
        },
      ],
    })
  );
}
