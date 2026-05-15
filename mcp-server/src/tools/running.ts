import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from '../client.js';
import {
  withRichResponse,
  text,
  resourceLink,
  formatDate,
  timeAgo,
  fmt,
  READ_ONLY_ANNOTATIONS,
  dateFilterParams,
  type ContentBlock,
} from './helpers.js';
import {
  activitySchema,
  activityDetailsOutputSchema,
  runningStatsOutputSchema,
  recentRunsOutputSchema,
  personalRecordsOutputSchema,
  runningStreaksOutputSchema,
  activitySplitsOutputSchema,
  runningYearsOutputSchema,
} from './schemas/running.js';

// Types below are derived from the Zod output schemas (schemas/running.ts)
// so the declared schema and the TS type cannot drift.
type Activity = z.infer<typeof activitySchema>;

type ActivityDetail = z.infer<typeof activityDetailsOutputSchema>;

export function registerRunningTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_running_stats ──────────────────────────────────────────────
  server.registerTool(
    'get_running_stats',
    {
      title: 'Running stats',
      description:
        'Get overall running statistics from Strava including total runs, distance, elevation, duration, average pace, and Eddington number.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: runningStatsOutputSchema,
    },
    async () =>
      withRichResponse(async () => {
        type Stats = {
          total_runs: number;
          total_distance_mi: number;
          total_elevation_ft: number;
          total_duration: string;
          avg_pace: string | null;
          years_active: number;
          first_run: string | null;
          eddington_number: number;
        };
        const { data } = await client.get<{ data: Stats }>('/running/stats');

        const summary = [
          'Running Stats:',
          `- Total runs: ${fmt(data.total_runs)}`,
          `- Total distance: ${fmt(Math.round(data.total_distance_mi))} mi`,
          `- Total elevation: ${fmt(Math.round(data.total_elevation_ft))} ft`,
          `- Total time: ${data.total_duration}`,
          data.avg_pace ? `- Average pace: ${data.avg_pace}` : null,
          `- Years active: ${data.years_active}`,
          data.first_run
            ? `- Running since: ${formatDate(data.first_run)}`
            : null,
          `- Eddington number: ${data.eddington_number}`,
        ]
          .filter((l) => l !== null)
          .join('\n');

        return { content: [text(summary)], structuredContent: data };
      })
  );

  // get_recent_runs ────────────────────────────────────────────────
  server.registerTool(
    'get_recent_runs',
    {
      title: 'Recent runs',
      description:
        'Get recent running activities from Strava. Returns runs with ID, distance, pace, duration, location, and Strava activity resource links for top-N.',
      inputSchema: {
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe('Number of recent runs to return (max 50)'),
        page: z
          .number()
          .min(1)
          .default(1)
          .describe(
            'Page number for pagination. Combine with limit to page through longer windows.'
          ),
        ...dateFilterParams,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: recentRunsOutputSchema,
    },
    async ({ limit, page, date, from, to }) =>
      withRichResponse(async () => {
        const { data } = await client.get<{ data: Activity[] }>(
          '/running/recent',
          { limit, page, date, from, to }
        );

        if (!data.length) {
          return {
            content: [text('No recent runs found.')],
            structuredContent: { items: [] },
          };
        }

        const lines = ['Recent runs:'];
        for (const [i, r] of data.entries()) {
          const location = r.city && r.state ? ` in ${r.city}, ${r.state}` : '';
          const race = r.is_race ? ' [RACE]' : '';
          lines.push(
            `${i + 1}. ${r.name}${race} -- ${r.distance_mi.toFixed(1)} mi, ${r.pace}/mi, ${r.duration}${location} (${timeAgo(r.date)})`
          );
        }

        const topN = data.slice(0, 5);
        const links = topN
          .map((r) =>
            resourceLink(r.strava_url, `Strava -- ${r.name}`, {
              mimeType: 'text/html',
            })
          )
          .filter((b): b is NonNullable<typeof b> => b !== null);

        const content: ContentBlock[] = [text(lines.join('\n')), ...links];

        return { content, structuredContent: { items: data } };
      })
  );

  // get_personal_records ───────────────────────────────────────────
  server.registerTool(
    'get_personal_records',
    {
      title: 'Personal records',
      description:
        'Get personal running records (PRs) from Strava -- fastest times at standard distances like mile, 5K, 10K, half marathon, marathon.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: personalRecordsOutputSchema,
    },
    async () =>
      withRichResponse(async () => {
        type PR = {
          distance_label: string;
          time: string;
          pace: string;
          date: string;
          activity_name: string;
          activity_id: number;
        };
        const { data } = await client.get<{ data: PR[] }>('/running/prs');

        if (!data.length) {
          return {
            content: [text('No personal records found.')],
            structuredContent: { items: [] },
          };
        }

        const lines = ['Personal Records:'];
        for (const pr of data) {
          lines.push(
            `- ${pr.distance_label}: ${pr.time} (${pr.pace}/mi) -- ${pr.activity_name}, ${formatDate(pr.date)}`
          );
        }

        // Emit rewind://activity/{id} per PR so user can drill to Strava.
        const links = data
          .map((pr) =>
            resourceLink(
              `rewind://activity/${pr.activity_id}`,
              `${pr.distance_label} PR -- ${pr.activity_name}`,
              { mimeType: 'application/json' }
            )
          )
          .filter((b): b is NonNullable<typeof b> => b !== null);

        return {
          content: [text(lines.join('\n')), ...links],
          structuredContent: { items: data },
        };
      })
  );

  // get_running_streaks ────────────────────────────────────────────
  server.registerTool(
    'get_running_streaks',
    {
      title: 'Running streaks',
      description:
        'Get running streak data from Strava -- current consecutive days with runs and the longest streak ever.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: runningStreaksOutputSchema,
    },
    async () =>
      withRichResponse(async () => {
        type Streaks = {
          current: { days: number; start: string | null; end: string | null };
          longest: { days: number; start: string | null; end: string | null };
        };
        const { data } = await client.get<{ data: Streaks }>(
          '/running/streaks'
        );

        const summary = [
          'Running Streaks:',
          '',
          `Current streak: ${data.current.days} days`,
          data.current.start
            ? `  ${formatDate(data.current.start)} -- ${formatDate(data.current.end)}`
            : '',
          '',
          `Longest streak: ${data.longest.days} days`,
          data.longest.start
            ? `  ${formatDate(data.longest.start)} -- ${formatDate(data.longest.end)}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');

        return { content: [text(summary)], structuredContent: data };
      })
  );

  // get_activity_details ───────────────────────────────────────────
  server.registerTool(
    'get_activity_details',
    {
      title: 'Run',
      description:
        'Get detailed information about a specific running activity by ID, including distance, pace, heart rate, elevation, calories, and a Strava resource link.',
      inputSchema: {
        id: z
          .number()
          .describe(
            'Activity ID (from get_recent_runs or get_personal_records)'
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: activityDetailsOutputSchema,
    },
    async ({ id }) =>
      withRichResponse(async () => {
        const data = await client.get<ActivityDetail>(
          `/running/activities/${id}`
        );

        const lines = [
          `${data.name}${data.is_race ? ' [RACE]' : ''}`,
          `Date: ${formatDate(data.date)}`,
          `Distance: ${data.distance_mi.toFixed(2)} mi`,
          `Duration: ${data.duration}`,
          `Pace: ${data.pace}/mi`,
          `Elevation: ${fmt(Math.round(data.elevation_ft))} ft`,
          `Type: ${data.workout_type}`,
        ];

        if (data.city && data.state) {
          lines.push(`Location: ${data.city}, ${data.state}`);
        }
        if (data.heartrate_avg) {
          lines.push(
            `Heart rate: ${Math.round(data.heartrate_avg)} avg / ${data.heartrate_max ?? '?'} max bpm`
          );
        }
        if (data.cadence)
          lines.push(`Cadence: ${Math.round(data.cadence)} spm`);
        if (data.calories) lines.push(`Calories: ${fmt(data.calories)}`);

        const stravaLink = resourceLink(data.strava_url, 'Strava activity', {
          mimeType: 'text/html',
        });

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...(stravaLink ? [stravaLink] : []),
        ];

        return { content, structuredContent: data };
      })
  );

  // get_activity_splits ────────────────────────────────────────────
  server.registerTool(
    'get_activity_splits',
    {
      title: 'Run splits',
      description:
        'Get per-mile splits for a running activity. Shows pace, elevation, and heart rate for each mile. Get the activity ID from get_recent_runs.',
      inputSchema: {
        id: z
          .number()
          .describe(
            'Activity ID (from get_recent_runs or get_personal_records)'
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: activitySplitsOutputSchema,
    },
    async ({ id }) =>
      withRichResponse(async () => {
        type Split = {
          split: number;
          distance_mi: number;
          moving_time_s: number;
          elapsed_time_s: number;
          elevation_ft: number;
          pace: string;
          heartrate: number | null;
        };
        const { data } = await client.get<{ data: Split[] }>(
          `/running/activities/${id}/splits`
        );

        if (!data.length) {
          return {
            content: [text('No splits found for this activity.')],
            structuredContent: { activity_id: id, items: [] as Split[] },
          };
        }

        const lines = [`Mile splits for activity ${id}:`];
        for (const s of data) {
          const hr = s.heartrate ? ` | ${Math.round(s.heartrate)} bpm` : '';
          const elev =
            s.elevation_ft !== 0
              ? ` | ${s.elevation_ft > 0 ? '+' : ''}${Math.round(s.elevation_ft)} ft`
              : '';
          lines.push(`  Mile ${s.split}: ${s.pace}${elev}${hr}`);
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: { activity_id: id, items: data },
        };
      })
  );

  // get_running_years ──────────────────────────────────────────────
  server.registerTool(
    'get_running_years',
    {
      title: 'Running by year',
      description:
        'Get per-year summary of running activity: total runs, distance, elevation, duration, average pace, longest run, and race count for every year on record.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: runningYearsOutputSchema,
    },
    async () =>
      withRichResponse(async () => {
        type YearSummary = {
          year: number;
          total_runs: number;
          total_distance_mi: number;
          total_elevation_ft: number;
          total_duration_s: number;
          avg_pace: string | null;
          longest_run_mi: number | null;
          race_count: number;
        };
        const { data } = await client.get<{ data: YearSummary[] }>(
          '/running/stats/years'
        );

        if (!data.length) {
          return {
            content: [text('No yearly running data available.')],
            structuredContent: { items: [] },
          };
        }

        const lines = ['Running by year:'];
        for (const y of data) {
          lines.push(
            `  ${y.year}: ${fmt(y.total_runs)} runs, ${fmt(Math.round(y.total_distance_mi))} mi, longest ${y.longest_run_mi ?? '-'} mi, races: ${y.race_count}`
          );
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: { items: data },
        };
      })
  );
}
