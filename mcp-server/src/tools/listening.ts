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

export function registerListeningTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_now_playing
  server.tool(
    'get_now_playing',
    'Get the track currently playing on Last.fm. Returns the song, artist, and album if something is playing.',
    {},
    READ_ONLY_ANNOTATIONS,
    async () =>
      withErrorHandling(async () => {
        const data = await client.get<{
          is_playing: boolean;
          track: {
            id: number;
            name: string;
          } | null;
          artist?: { name: string };
          album?: { name: string | null };
          scrobbled_at: string | null;
        }>('/listening/now-playing');

        if (!data.is_playing || !data.track) {
          return 'Nothing playing right now.';
        }

        const artist = data.artist?.name ?? 'Unknown Artist';
        const album = data.album?.name ? ` (from ${data.album.name})` : '';
        return `Now playing: "${data.track.name}" by ${artist}${album}`;
      })
  );

  // get_recent_listens
  server.tool(
    'get_recent_listens',
    'Get recently scrobbled tracks from Last.fm. Returns a list of recent plays with artist, album, and time. Supports date filtering.',
    {
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of recent tracks to return (default 10, max 50)'),
      ...dateFilterParams,
    },
    READ_ONLY_ANNOTATIONS,
    async ({ limit, date, from, to }) =>
      withErrorHandling(async () => {
        const data = await client.get<{
          data: Array<{
            track: { name: string };
            artist: { name: string };
            album: { name: string | null };
            scrobbled_at: string;
          }>;
        }>('/listening/recent', { limit, date, from, to });

        if (!data.data.length) return 'No recent listens found.';

        const lines = ['Recent listens:'];
        for (const [i, s] of data.data.entries()) {
          const album = s.album?.name ? ` -- ${s.album.name}` : '';
          lines.push(
            `${i + 1}. "${s.track.name}" by ${s.artist.name}${album} (${timeAgo(s.scrobbled_at)})`
          );
        }
        return lines.join('\n');
      })
  );

  // get_listening_stats
  server.tool(
    'get_listening_stats',
    'Get overall listening statistics from Last.fm including total scrobbles, unique artists, albums, tracks, and daily average. Supports date filtering for period-specific stats.',
    { ...dateFilterParams },
    READ_ONLY_ANNOTATIONS,
    async ({ date, from, to }) =>
      withErrorHandling(async () => {
        const data = await client.get<{
          total_scrobbles: number;
          unique_artists: number;
          unique_albums: number;
          unique_tracks: number;
          scrobbles_per_day: number;
          years_tracking: number;
        }>('/listening/stats', { date, from, to });

        return [
          'Listening Stats:',
          `- Total scrobbles: ${fmt(data.total_scrobbles)}`,
          `- Unique artists: ${fmt(data.unique_artists)}`,
          `- Unique albums: ${fmt(data.unique_albums)}`,
          `- Unique tracks: ${fmt(data.unique_tracks)}`,
          `- Average per day: ${data.scrobbles_per_day.toFixed(1)}`,
          `- Years tracking: ${data.years_tracking}`,
        ].join('\n');
      })
  );

  // get_top_artists
  server.tool(
    'get_top_artists',
    'Get top listened-to artists from Last.fm for a given time period. Returns ranked list with play counts.',
    {
      period: z
        .enum(['7day', '1month', '3month', '6month', '12month', 'overall'])
        .default('1month')
        .describe('Time period for rankings'),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of artists to return'),
      page: z.number().min(1).default(1).describe('Page number for pagination'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ period, limit, page }) =>
      withErrorHandling(async () => {
        const data = await client.get<{
          period: string;
          data: Array<{
            rank: number;
            name: string;
            playcount: number;
          }>;
        }>('/listening/top/artists', { period, limit, page });

        if (!data.data.length) return `No top artists for period: ${period}`;

        const lines = [`Top Artists (${period}):`];
        for (const a of data.data) {
          lines.push(`${a.rank}. ${a.name} -- ${fmt(a.playcount)} plays`);
        }
        return lines.join('\n');
      })
  );

  // get_top_albums
  server.tool(
    'get_top_albums',
    'Get top listened-to albums from Last.fm for a given time period. Returns ranked list with play counts.',
    {
      period: z
        .enum(['7day', '1month', '3month', '6month', '12month', 'overall'])
        .default('1month')
        .describe('Time period for rankings'),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of albums to return'),
      page: z.number().min(1).default(1).describe('Page number for pagination'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ period, limit, page }) =>
      withErrorHandling(async () => {
        const data = await client.get<{
          period: string;
          data: Array<{
            rank: number;
            name: string;
            detail: string;
            playcount: number;
          }>;
        }>('/listening/top/albums', { period, limit, page });

        if (!data.data.length) return `No top albums for period: ${period}`;

        const lines = [`Top Albums (${period}):`];
        for (const a of data.data) {
          lines.push(
            `${a.rank}. ${a.name} by ${a.detail} -- ${fmt(a.playcount)} plays`
          );
        }
        return lines.join('\n');
      })
  );

  // get_top_tracks
  server.tool(
    'get_top_tracks',
    'Get top listened-to tracks from Last.fm for a given time period. Returns ranked list with play counts.',
    {
      period: z
        .enum(['7day', '1month', '3month', '6month', '12month', 'overall'])
        .default('1month')
        .describe('Time period for rankings'),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of tracks to return'),
      page: z.number().min(1).default(1).describe('Page number for pagination'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ period, limit, page }) =>
      withErrorHandling(async () => {
        const data = await client.get<{
          period: string;
          data: Array<{
            rank: number;
            name: string;
            detail: string;
            playcount: number;
          }>;
        }>('/listening/top/tracks', { period, limit, page });

        if (!data.data.length) return `No top tracks for period: ${period}`;

        const lines = [`Top Tracks (${period}):`];
        for (const t of data.data) {
          lines.push(
            `${t.rank}. "${t.name}" by ${t.detail} -- ${fmt(t.playcount)} plays`
          );
        }
        return lines.join('\n');
      })
  );

  // get_listening_streaks
  server.tool(
    'get_listening_streaks',
    'Get listening streak data from Last.fm -- current consecutive days with scrobbles and the longest streak ever.',
    {},
    READ_ONLY_ANNOTATIONS,
    async () =>
      withErrorHandling(async () => {
        const data = await client.get<{
          current: {
            days: number;
            start_date: string | null;
            total_scrobbles: number;
          };
          longest: {
            days: number;
            start_date: string | null;
            end_date: string | null;
            total_scrobbles: number;
          };
        }>('/listening/streaks');

        return [
          'Listening Streaks:',
          '',
          `Current streak: ${data.current.days} days (${fmt(data.current.total_scrobbles)} scrobbles)`,
          data.current.start_date
            ? `  Started: ${formatDate(data.current.start_date)}`
            : '',
          '',
          `Longest streak: ${data.longest.days} days (${fmt(data.longest.total_scrobbles)} scrobbles)`,
          data.longest.start_date
            ? `  ${formatDate(data.longest.start_date)} -- ${formatDate(data.longest.end_date)}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
      })
  );

  // get_artist_details
  server.tool(
    'get_artist_details',
    'Get detailed information about a specific artist by ID, including play count, top albums, and top tracks.',
    { id: z.number().describe('Artist ID') },
    READ_ONLY_ANNOTATIONS,
    async ({ id }) =>
      withErrorHandling(async () => {
        const data = await client.get<{
          name: string;
          playcount: number;
          scrobble_count: number;
          genre: string | null;
          top_albums: Array<{ name: string; playcount: number }>;
          top_tracks: Array<{ name: string; scrobble_count: number }>;
        }>(`/listening/artists/${id}`);

        const lines = [
          `${data.name}`,
          `Total plays: ${fmt(data.playcount)}`,
          data.genre ? `Genre: ${data.genre}` : null,
          '',
        ].filter((l) => l !== null);

        if (data.top_albums.length) {
          lines.push('Top Albums:');
          for (const a of data.top_albums.slice(0, 5)) {
            lines.push(`  - ${a.name} (${fmt(a.playcount)} plays)`);
          }
          lines.push('');
        }

        if (data.top_tracks.length) {
          lines.push('Top Tracks:');
          for (const t of data.top_tracks.slice(0, 5)) {
            lines.push(`  - "${t.name}" (${fmt(t.scrobble_count)} plays)`);
          }
        }

        return lines.join('\n');
      })
  );

  // get_album_details
  server.tool(
    'get_album_details',
    'Get detailed information about a specific album by ID, including artist, play count, and track listing.',
    { id: z.number().describe('Album ID') },
    READ_ONLY_ANNOTATIONS,
    async ({ id }) =>
      withErrorHandling(async () => {
        const data = await client.get<{
          name: string;
          artist: { name: string };
          playcount: number;
          tracks: Array<{ name: string; scrobble_count: number }>;
        }>(`/listening/albums/${id}`);

        const lines = [
          `${data.name} by ${data.artist.name}`,
          `Total plays: ${fmt(data.playcount)}`,
          '',
        ];

        if (data.tracks.length) {
          lines.push('Tracks:');
          for (const [i, t] of data.tracks.entries()) {
            lines.push(
              `  ${i + 1}. "${t.name}" (${fmt(t.scrobble_count)} plays)`
            );
          }
        }

        return lines.join('\n');
      })
  );
}
