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
  READ_ONLY_ANNOTATIONS,
  dateFilterParams,
  includeImagesParam,
  LIST_IMAGE_PX,
  type ContentBlock,
} from './helpers.js';

const TOP_N = 5;

type Image = {
  cdn_url?: string | null;
  url?: string | null;
  thumbhash?: string | null;
  dominant_color?: string | null;
  accent_color?: string | null;
} | null;

type NowPlaying = {
  is_playing: boolean;
  track: {
    name: string;
    artist: { id: number | null; name: string; apple_music_url: string | null };
    album: { id: number | null; name: string | null; image: Image };
    url: string | null;
    apple_music_url: string | null;
    preview_url: string | null;
  } | null;
  scrobbled_at: string | null;
};

type Scrobble = {
  track: {
    id: number;
    name: string;
    url: string | null;
    apple_music_url: string | null;
    preview_url: string | null;
  };
  artist: { id: number; name: string };
  album: { id: number | null; name: string | null; image: Image };
  scrobbled_at: string;
};

type TopItem = {
  rank: number;
  id: number;
  name: string;
  detail: string;
  playcount: number;
  image: Image;
  url: string;
  apple_music_url: string | null;
  preview_url?: string | null;
};

type ArtistDetail = {
  id: number;
  name: string;
  mbid: string | null;
  url: string | null;
  apple_music_url: string | null;
  playcount: number;
  scrobble_count: number;
  genre: string | null;
  image: Image;
  top_albums: Array<{
    id: number;
    name: string;
    playcount: number;
    apple_music_url: string | null;
    image: Image;
  }>;
  top_tracks: Array<{
    id: number;
    name: string;
    scrobble_count: number;
    apple_music_url: string | null;
    preview_url: string | null;
  }>;
};

type AlbumDetail = {
  id: number;
  name: string;
  mbid: string | null;
  url: string | null;
  apple_music_url: string | null;
  playcount: number;
  image: Image;
  artist: { id: number; name: string };
  tracks: Array<{
    id: number;
    name: string;
    scrobble_count: number;
    apple_music_url: string | null;
    preview_url: string | null;
  }>;
};

const PERIOD_ENUM = [
  '7day',
  '1month',
  '3month',
  '6month',
  '12month',
  'overall',
] as const;

export function registerListeningTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_now_playing ────────────────────────────────────────────────
  server.tool(
    'get_now_playing',
    'Get the track currently playing (or most recently scrobbled) on Last.fm. Returns track + artist + album, album cover image, and Apple Music resource link.',
    { ...includeImagesParam },
    READ_ONLY_ANNOTATIONS,
    async ({ include_images }) =>
      withRichResponse(async () => {
        const data = await client.get<NowPlaying>('/listening/now-playing');

        if (!data.is_playing || !data.track) {
          return {
            content: [text('Nothing playing right now.')],
            structuredContent: data,
          };
        }

        const t = data.track;
        const albumPart = t.album.name ? ` (from ${t.album.name})` : '';
        const summary = `Now playing: "${t.name}" by ${t.artist.name}${albumPart}`;

        const cover = include_images
          ? await imageBlock(client, t.album.image)
          : null;

        const links = [
          resourceLink(t.apple_music_url, 'Apple Music -- track', {
            mimeType: 'text/html',
          }),
          resourceLink(t.artist.apple_music_url, 'Apple Music -- artist', {
            mimeType: 'text/html',
          }),
          resourceLink(t.url, 'Last.fm -- track', { mimeType: 'text/html' }),
        ].filter((b): b is NonNullable<typeof b> => b !== null);

        const content: ContentBlock[] = [
          text(summary),
          ...(cover ? [cover] : []),
          ...links,
        ];

        return { content, structuredContent: data };
      })
  );

  // get_recent_listens ─────────────────────────────────────────────
  server.tool(
    'get_recent_listens',
    'Get recently scrobbled tracks from Last.fm, with top-N album covers and Apple Music resource links. Supports date filtering.',
    {
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of recent tracks to return (default 10, max 50)'),
      page: z
        .number()
        .min(1)
        .default(1)
        .describe(
          'Page number for pagination. Combine with limit to page through longer windows.'
        ),
      ...dateFilterParams,
      ...includeImagesParam,
    },
    READ_ONLY_ANNOTATIONS,
    async ({ limit, page, date, from, to, include_images }) =>
      withRichResponse(async () => {
        const { data } = await client.get<{ data: Scrobble[] }>(
          '/listening/recent',
          { limit, page, date, from, to }
        );

        if (!data.length) {
          return {
            content: [text('No recent listens found.')],
            structuredContent: { items: [] },
          };
        }

        const lines = ['Recent listens:'];
        for (const [i, s] of data.entries()) {
          const album = s.album?.name ? ` -- ${s.album.name}` : '';
          lines.push(
            `${i + 1}. "${s.track.name}" by ${s.artist.name}${album} (${timeAgo(s.scrobbled_at)})`
          );
        }

        const topN = data.slice(0, TOP_N);
        const images = include_images
          ? await Promise.all(
              topN.map((s) => imageBlock(client, s.album.image, LIST_IMAGE_PX))
            )
          : [];
        const links = topN
          .map((s) =>
            resourceLink(
              s.track.apple_music_url,
              `Apple Music -- ${s.track.name}`,
              { mimeType: 'text/html' }
            )
          )
          .filter((b): b is NonNullable<typeof b> => b !== null);

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...images.filter((b): b is NonNullable<typeof b> => b !== null),
          ...links,
        ];

        return { content, structuredContent: { items: data } };
      })
  );

  // get_listening_stats ────────────────────────────────────────────
  server.tool(
    'get_listening_stats',
    'Get overall listening statistics from Last.fm including total scrobbles, unique artists, albums, tracks, and daily average. Supports date filtering.',
    { ...dateFilterParams },
    READ_ONLY_ANNOTATIONS,
    async ({ date, from, to }) =>
      withRichResponse(async () => {
        const data = await client.get<{
          total_scrobbles: number;
          unique_artists: number;
          unique_albums: number;
          unique_tracks: number;
          registered_date: string | null;
          years_tracking: number;
          scrobbles_per_day: number;
        }>('/listening/stats', { date, from, to });

        const summary = [
          'Listening Stats:',
          `- Total scrobbles: ${fmt(data.total_scrobbles)}`,
          `- Unique artists: ${fmt(data.unique_artists)}`,
          `- Unique albums: ${fmt(data.unique_albums)}`,
          `- Unique tracks: ${fmt(data.unique_tracks)}`,
          `- Average per day: ${data.scrobbles_per_day.toFixed(1)}`,
          `- Years tracking: ${data.years_tracking}`,
        ].join('\n');

        return { content: [text(summary)], structuredContent: data };
      })
  );

  // get_top_artists ────────────────────────────────────────────────
  // Registered via server.registerTool so we can attach `_meta.ui.resourceUri`.
  // MCP Apps hosts render an interactive artist portrait grid inline; others
  // fall back to the text + image + resource_link response.
  server.registerTool(
    'get_top_artists',
    {
      title: 'Top artists',
      description:
        'Get top listened-to artists from Last.fm for a given time period, with top-N artist images and Apple Music links. In MCP Apps hosts, renders an interactive artist portrait grid inline.',
      inputSchema: {
        period: z
          .enum(PERIOD_ENUM)
          .default('1month')
          .describe('Time period for rankings'),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe('Number of artists to return'),
        page: z
          .number()
          .min(1)
          .default(1)
          .describe('Page number for pagination'),
        ...includeImagesParam,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ui: { resourceUri: 'ui://rewind/top-artists.html' },
        'ui/resourceUri': 'ui://rewind/top-artists.html',
      },
    },
    async ({ period, limit, page, include_images }) =>
      withRichResponse(async () => {
        const data = await client.get<{ period: string; data: TopItem[] }>(
          '/listening/top/artists',
          { period, limit, page }
        );

        if (!data.data.length) {
          return {
            content: [text(`No top artists for period: ${period}`)],
            structuredContent: data,
          };
        }

        const lines = [`Top Artists (${period}):`];
        for (const a of data.data) {
          lines.push(`${a.rank}. ${a.name} -- ${fmt(a.playcount)} plays`);
        }

        const topN = data.data.slice(0, TOP_N);
        const images = include_images
          ? await Promise.all(
              topN.map((a) => imageBlock(client, a.image, LIST_IMAGE_PX))
            )
          : [];
        const links = topN
          .map((a) =>
            resourceLink(a.apple_music_url, `Apple Music -- ${a.name}`, {
              mimeType: 'text/html',
            })
          )
          .filter((b): b is NonNullable<typeof b> => b !== null);

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...images.filter((b): b is NonNullable<typeof b> => b !== null),
          ...links,
        ];

        return { content, structuredContent: data };
      })
  );

  // get_top_albums ─────────────────────────────────────────────────
  // Registered via server.registerTool so we can attach `_meta.ui.resourceUri`.
  // MCP Apps hosts render an interactive album cover grid inline; others
  // fall back to the text + image + resource_link response.
  server.registerTool(
    'get_top_albums',
    {
      title: 'Top albums',
      description:
        'Get top listened-to albums from Last.fm for a given time period, with top-N covers and Apple Music links. In MCP Apps hosts, renders an interactive album cover grid inline.',
      inputSchema: {
        period: z
          .enum(PERIOD_ENUM)
          .default('1month')
          .describe('Time period for rankings'),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe('Number of albums to return'),
        page: z
          .number()
          .min(1)
          .default(1)
          .describe('Page number for pagination'),
        ...includeImagesParam,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ui: { resourceUri: 'ui://rewind/top-albums.html' },
        'ui/resourceUri': 'ui://rewind/top-albums.html',
      },
    },
    async ({ period, limit, page, include_images }) =>
      withRichResponse(async () => {
        const data = await client.get<{ period: string; data: TopItem[] }>(
          '/listening/top/albums',
          { period, limit, page }
        );

        if (!data.data.length) {
          return {
            content: [text(`No top albums for period: ${period}`)],
            structuredContent: data,
          };
        }

        const lines = [`Top Albums (${period}):`];
        for (const a of data.data) {
          lines.push(
            `${a.rank}. ${a.name} by ${a.detail} -- ${fmt(a.playcount)} plays`
          );
        }

        const topN = data.data.slice(0, TOP_N);
        const images = include_images
          ? await Promise.all(
              topN.map((a) => imageBlock(client, a.image, LIST_IMAGE_PX))
            )
          : [];
        const links = topN
          .map((a) =>
            resourceLink(a.apple_music_url, `Apple Music -- ${a.name}`, {
              mimeType: 'text/html',
            })
          )
          .filter((b): b is NonNullable<typeof b> => b !== null);

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...images.filter((b): b is NonNullable<typeof b> => b !== null),
          ...links,
        ];

        return { content, structuredContent: data };
      })
  );

  // get_top_tracks ─────────────────────────────────────────────────
  server.tool(
    'get_top_tracks',
    'Get top listened-to tracks from Last.fm for a given time period, with top-N Apple Music links.',
    {
      period: z
        .enum(PERIOD_ENUM)
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
      withRichResponse(async () => {
        const data = await client.get<{ period: string; data: TopItem[] }>(
          '/listening/top/tracks',
          { period, limit, page }
        );

        if (!data.data.length) {
          return {
            content: [text(`No top tracks for period: ${period}`)],
            structuredContent: data,
          };
        }

        const lines = [`Top Tracks (${period}):`];
        for (const t of data.data) {
          lines.push(
            `${t.rank}. "${t.name}" by ${t.detail} -- ${fmt(t.playcount)} plays`
          );
        }

        const topN = data.data.slice(0, TOP_N);
        const links = topN
          .map((t) =>
            resourceLink(t.apple_music_url, `Apple Music -- ${t.name}`, {
              mimeType: 'text/html',
            })
          )
          .filter((b): b is NonNullable<typeof b> => b !== null);

        const content: ContentBlock[] = [text(lines.join('\n')), ...links];

        return { content, structuredContent: data };
      })
  );

  // get_listening_streaks ──────────────────────────────────────────
  server.tool(
    'get_listening_streaks',
    'Get listening streak data from Last.fm -- current consecutive days with scrobbles and the longest streak ever.',
    {},
    READ_ONLY_ANNOTATIONS,
    async () =>
      withRichResponse(async () => {
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

        const summary = [
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

        return { content: [text(summary)], structuredContent: data };
      })
  );

  // get_artist_details ─────────────────────────────────────────────
  server.tool(
    'get_artist_details',
    'Get detailed information about a specific artist by ID: play count, top albums, top tracks, artist image, and Apple Music link.',
    { id: z.number().describe('Artist ID'), ...includeImagesParam },
    READ_ONLY_ANNOTATIONS,
    async ({ id, include_images }) =>
      withRichResponse(async () => {
        const data = await client.get<ArtistDetail>(`/listening/artists/${id}`);

        const lines = [
          data.name,
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

        const artistImage = include_images
          ? await imageBlock(client, data.image)
          : null;

        const links = [
          resourceLink(data.apple_music_url, 'Apple Music -- artist', {
            mimeType: 'text/html',
          }),
          resourceLink(data.url, 'Last.fm -- artist', {
            mimeType: 'text/html',
          }),
        ].filter((b): b is NonNullable<typeof b> => b !== null);

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...(artistImage ? [artistImage] : []),
          ...links,
        ];

        return { content, structuredContent: data };
      })
  );

  // get_album_details ──────────────────────────────────────────────
  server.tool(
    'get_album_details',
    'Get detailed information about a specific album by ID: artist, play count, track listing, cover art, and Apple Music link.',
    { id: z.number().describe('Album ID'), ...includeImagesParam },
    READ_ONLY_ANNOTATIONS,
    async ({ id, include_images }) =>
      withRichResponse(async () => {
        const data = await client.get<AlbumDetail>(`/listening/albums/${id}`);

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

        const cover = include_images
          ? await imageBlock(client, data.image)
          : null;

        const links = [
          resourceLink(data.apple_music_url, 'Apple Music -- album', {
            mimeType: 'text/html',
          }),
          resourceLink(data.url, 'Last.fm -- album', { mimeType: 'text/html' }),
        ].filter((b): b is NonNullable<typeof b> => b !== null);

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...(cover ? [cover] : []),
          ...links,
        ];

        return { content, structuredContent: data };
      })
  );

  // get_listening_genres ───────────────────────────────────────────
  server.tool(
    'get_listening_genres',
    'Get genre breakdown over time from Last.fm listening history, grouped by week/month/year. Designed for stacked chart visualization.',
    {
      group_by: z
        .enum(['week', 'month', 'year'])
        .default('month')
        .describe('Grouping period (default: month)'),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe(
          'Max genres to return -- rest grouped as "Other" (default 10)'
        ),
      ...dateFilterParams,
    },
    READ_ONLY_ANNOTATIONS,
    async ({ group_by, limit, date, from, to }) =>
      withRichResponse(async () => {
        type GenrePeriod = {
          period: string;
          genres: Record<string, number>;
          total: number;
        };
        const { data } = await client.get<{ data: GenrePeriod[] }>(
          '/listening/genres',
          { group_by, limit, date, from, to }
        );

        if (!data.length) {
          return {
            content: [text('No genre data available.')],
            structuredContent: {
              items: [] as GenrePeriod[],
              group_by,
            },
          };
        }

        const lines = [`Genre breakdown by ${group_by}:`];
        for (const row of data) {
          const top = Object.entries(row.genres)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([name, count]) => `${name}=${count}`)
            .join(', ');
          lines.push(`  ${row.period}: total ${fmt(row.total)}; top: ${top}`);
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: { items: data, group_by },
        };
      })
  );
}
