import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from '../client.js';
import {
  withErrorHandling,
  formatDate,
  timeAgo,
  fmt,
  READ_ONLY_ANNOTATIONS,
} from './helpers.js';

export function registerRunningTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_running_stats
  server.tool(
    'get_running_stats',
    'Get overall running statistics from Strava including total runs, distance, elevation, duration, average pace, and Eddington number.',
    {},
    READ_ONLY_ANNOTATIONS,
    async () =>
      withErrorHandling(async () => {
        const { data } = await client.get<{
          data: {
            total_runs: number;
            total_distance_mi: number;
            total_elevation_ft: number;
            total_duration: string;
            avg_pace: string | null;
            years_active: number;
            first_run: string | null;
            eddington_number: number;
          };
        }>('/running/stats');

        return [
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
      })
  );

  // get_recent_runs
  server.tool(
    'get_recent_runs',
    'Get recent running activities from Strava. Returns a list of runs with ID, distance, pace, duration, and location. Use the ID with get_activity_details or get_activity_splits for more info.',
    {
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of recent runs to return'),
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
    async ({ limit, date, from, to }) =>
      withErrorHandling(async () => {
        const { data } = await client.get<{
          data: Array<{
            id: number;
            name: string;
            date: string;
            distance_mi: number;
            duration: string;
            pace: string;
            elevation_ft: number;
            city: string | null;
            state: string | null;
            is_race: boolean;
          }>;
        }>('/running/recent', { limit, date, from, to });

        if (!data.length) return 'No recent runs found.';

        const lines = ['Recent runs:'];
        for (const [i, r] of data.entries()) {
          const location = r.city && r.state ? ` in ${r.city}, ${r.state}` : '';
          const race = r.is_race ? ' [RACE]' : '';
          lines.push(
            `${i + 1}. [ID: ${r.id}] ${r.name}${race} -- ${r.distance_mi.toFixed(1)} mi, ${r.pace}/mi, ${r.duration}${location} (${timeAgo(r.date)})`
          );
        }
        return lines.join('\n');
      })
  );

  // get_personal_records
  server.tool(
    'get_personal_records',
    'Get personal running records (PRs) from Strava -- fastest times at standard distances like mile, 5K, 10K, half marathon, marathon.',
    {},
    READ_ONLY_ANNOTATIONS,
    async () =>
      withErrorHandling(async () => {
        const { data } = await client.get<{
          data: Array<{
            distance_label: string;
            time: string;
            pace: string;
            date: string;
            activity_name: string;
            activity_id: number;
          }>;
        }>('/running/prs');

        if (!data.length) return 'No personal records found.';

        const lines = ['Personal Records:'];
        for (const pr of data) {
          lines.push(
            `- ${pr.distance_label}: ${pr.time} (${pr.pace}/mi) -- ${pr.activity_name} [ID: ${pr.activity_id}], ${formatDate(pr.date)}`
          );
        }
        return lines.join('\n');
      })
  );

  // get_running_streaks
  server.tool(
    'get_running_streaks',
    'Get running streak data from Strava -- current consecutive days with runs and the longest streak ever.',
    {},
    READ_ONLY_ANNOTATIONS,
    async () =>
      withErrorHandling(async () => {
        const { data } = await client.get<{
          data: {
            current: { days: number; start: string | null; end: string | null };
            longest: { days: number; start: string | null; end: string | null };
          };
        }>('/running/streaks');

        return [
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
      })
  );

  // get_activity_details
  server.tool(
    'get_activity_details',
    'Get detailed information about a specific running activity by ID, including distance, pace, heart rate, elevation, and calories. Get the ID from get_recent_runs.',
    {
      id: z
        .number()
        .describe('Activity ID (from get_recent_runs or get_personal_records)'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ id }) =>
      withErrorHandling(async () => {
        const data = await client.get<{
          name: string;
          date: string;
          distance_mi: number;
          duration: string;
          pace: string;
          elevation_ft: number;
          heartrate_avg: number | null;
          heartrate_max: number | null;
          cadence: number | null;
          calories: number | null;
          suffer_score: number | null;
          city: string | null;
          state: string | null;
          is_race: boolean;
          workout_type: string;
          strava_url: string | null;
        }>(`/running/activities/${id}`);

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
        if (data.strava_url) lines.push(`Strava: ${data.strava_url}`);

        return lines.join('\n');
      })
  );

  // get_activity_splits
  server.tool(
    'get_activity_splits',
    'Get per-mile splits for a running activity. Shows pace, elevation, and heart rate for each mile. Get the activity ID from get_recent_runs.',
    {
      id: z
        .number()
        .describe('Activity ID (from get_recent_runs or get_personal_records)'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ id }) =>
      withErrorHandling(async () => {
        const { data } = await client.get<{
          data: Array<{
            split: number;
            distance_mi: number;
            moving_time_s: number;
            elapsed_time_s: number;
            elevation_ft: number;
            pace: string;
            heartrate: number | null;
          }>;
        }>(`/running/activities/${id}/splits`);

        if (!data.length) return 'No splits found for this activity.';

        const lines = [`Mile splits for activity ${id}:`];
        for (const s of data) {
          const hr = s.heartrate ? ` | ${Math.round(s.heartrate)} bpm` : '';
          const elev =
            s.elevation_ft !== 0
              ? ` | ${s.elevation_ft > 0 ? '+' : ''}${Math.round(s.elevation_ft)} ft`
              : '';
          lines.push(`  Mile ${s.split}: ${s.pace}${elev}${hr}`);
        }

        return lines.join('\n');
      })
  );
}
