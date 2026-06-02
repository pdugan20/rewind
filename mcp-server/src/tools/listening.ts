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
import { imageSchema } from './schemas/shared.js';
import {
  scrobbleSchema,
  topItemSchema,
  nowPlayingOutputSchema,
  recentListensOutputSchema,
  listeningStatsOutputSchema,
  topListOutputSchema,
  topTracksOutputSchema,
  listeningStreaksOutputSchema,
  albumDetailsOutputSchema,
  listeningGenresOutputSchema,
  artistDetailsOutputSchema,
} from './schemas/listening.js';

const TOP_N = 5;

// Types below are derived from the Zod output schemas (schemas/listening.ts)
// so the declared schema and the TS type cannot drift. ArtistDetail is left
// hand-written: it describes the raw API response, which get_artist_details
// transforms into a different card-shaped payload before returning.
type Image = z.infer<ReturnType<typeof imageSchema>>;

type NowPlaying = z.infer<typeof nowPlayingOutputSchema>;

type Scrobble = z.infer<typeof scrobbleSchema>;

type TopItem = z.infer<typeof topItemSchema>;

type ArtistDetail = {
  id: number;
  name: string;
  mbid: string | null;
  url: string | null;
  apple_music_url: string | null;
  playcount: number;
  scrobble_count: number;
  first_scrobbled_at: string | null;
  last_played_at: string | null;
  all_time_rank: number | null;
  distinct_tracks: number;
  distinct_albums: number;
  genre: string | null;
  tags: Array<{ name: string; count: number }> | null;
  bio_summary: string | null;
  bio_content: string | null;
  bio_synced_at: string | null;
  image: Image;
  sparkline: {
    granularity: 'day' | 'week' | 'month' | 'year';
    points: Array<{ at: string; count: number }>;
  } | null;
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
    album_id: number | null;
    album_name: string | null;
    scrobble_count: number;
    apple_music_url: string | null;
    preview_url: string | null;
    image: Image;
  }>;
  similar_artists: Array<{
    id: number;
    name: string;
    your_scrobble_count: number;
    similarity_score: number;
    image: Image;
  }>;
};

type AlbumDetail = z.infer<typeof albumDetailsOutputSchema>;

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
  server.registerTool(
    'get_now_playing',
    {
      title: 'Now playing',
      description:
        'Get the track currently playing (or most recently scrobbled) on Last.fm. Returns track + artist + album, album cover image, and Apple Music resource link.',
      inputSchema: { ...includeImagesParam },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: nowPlayingOutputSchema,
    },
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
  server.registerTool(
    'get_recent_listens',
    {
      title: 'Recent listens',
      description:
        'Get recently scrobbled tracks from Last.fm, with top-N album covers and Apple Music resource links. Supports date filtering.',
      inputSchema: {
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
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: recentListensOutputSchema,
    },
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
  server.registerTool(
    'get_listening_stats',
    {
      title: 'Listening stats',
      description:
        'Get overall listening statistics from Last.fm including total scrobbles, unique artists, albums, tracks, and daily average. Supports date filtering.',
      inputSchema: { ...dateFilterParams },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: listeningStatsOutputSchema,
    },
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
        'Get top listened-to artists for a time window, with top-N artist images and Apple Music links. Use `period` for vague-recent queries ("lately", "this week") — defaults to \'1month\' (rolling 28 days). Use `date`/`from`/`to` for calendar queries ("in February", "last month", "this year") — date filter overrides period when both are supplied. In MCP Apps hosts, renders an interactive artist portrait grid inline.',
      inputSchema: {
        period: z
          .enum(PERIOD_ENUM)
          .default('1month')
          .describe(
            'Rolling time period for rankings. Use for "lately"/"this week" style queries. Ignored when date/from/to is supplied.'
          ),
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
        ...dateFilterParams,
        ...includeImagesParam,
        include_sparklines: z
          .boolean()
          .default(true)
          .describe(
            'When true (default), attach a `sparkline` (granularity + zero-filled play-count points) to each artist. Supported for period in {7day, 1month, 3month, 6month, 12month}. Set false to keep responses small.'
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: topListOutputSchema,
      _meta: {
        ui: { resourceUri: 'ui://rewind/top-artists.html' },
        'ui/resourceUri': 'ui://rewind/top-artists.html',
      },
    },
    async ({
      period,
      limit,
      page,
      date,
      from,
      to,
      include_images,
      include_sparklines,
    }) =>
      withRichResponse(async () => {
        const data = await client.get<{ period: string; data: TopItem[] }>(
          '/listening/top/artists',
          {
            period,
            limit,
            page,
            date,
            from,
            to,
            ...(include_sparklines ? { include_sparklines: 'true' } : {}),
          }
        );

        if (!data.data.length) {
          return {
            content: [text(`No top artists for period: ${period}`)],
            structuredContent: data,
          };
        }

        const lines = [`Top Artists (${period}):`];
        for (const a of data.data) {
          const linkUrl = a.apple_music_url ?? a.url ?? null;
          const nameMd = linkUrl ? `[${a.name}](${linkUrl})` : a.name;
          lines.push(`${a.rank}. ${nameMd} -- ${fmt(a.playcount)} plays`);
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
      outputSchema: topListOutputSchema,
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
          const linkUrl = a.apple_music_url ?? a.url ?? null;
          const nameMd = linkUrl ? `[${a.name}](${linkUrl})` : a.name;
          lines.push(
            `${a.rank}. ${nameMd} by ${a.detail} -- ${fmt(a.playcount)} plays`
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
  // Accepts an optional artist_id (or artist_name substring resolver) so
  // the model can answer "what Olivia Rodrigo songs have I been listening to
  // lately" by composing this tool with the period filter — preferred over
  // calling get_artist_details and reading its capped embedded top_tracks.
  //
  // Migrated to server.registerTool to attach _meta.ui.resourceUri so MCP
  // Apps hosts (Claude Desktop / iOS) render the interactive top-tracks
  // card inline. Phase 4 winner: list-style with toggle to album-grouped.
  server.registerTool(
    'get_top_tracks',
    {
      title: 'Top tracks',
      description:
        'Top listened-to tracks for a time window, with top-N Apple Music links. Optional `artist_id` or `artist_name` filters to a single artist\'s catalog — useful for \'what X songs have I been listening to lately\' queries. Use `period` for vague-recent queries ("lately", "this week") — defaults to \'1month\' (rolling 28 days). Use `date`/`from`/`to` for calendar queries ("in February", "last month", "this year") — date filter overrides period when both are supplied. In MCP Apps hosts, renders an interactive top-tracks card with a List | By album toggle.',
      inputSchema: {
        period: z
          .enum(PERIOD_ENUM)
          .default('1month')
          .describe(
            'Rolling time period for rankings. Use for "lately"/"this week" style queries. Ignored when date/from/to is supplied.'
          ),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe('Number of tracks to return'),
        page: z
          .number()
          .min(1)
          .default(1)
          .describe('Page number for pagination'),
        artist_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Filter to a single artist. Stable id from get_artist_details or get_top_artists. Composes with period and date filters.'
          ),
        artist_name: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Substring match against artist names (case-insensitive). Resolves to the highest-playcount match. Use only if no artist_id is available; passing both is a 400.'
          ),
        ...dateFilterParams,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: topTracksOutputSchema,
      _meta: {
        ui: { resourceUri: 'ui://rewind/top-tracks.html' },
        'ui/resourceUri': 'ui://rewind/top-tracks.html',
      },
    },
    async ({ period, limit, page, artist_id, artist_name, date, from, to }) =>
      withRichResponse(async () => {
        const data = await client.get<{
          period: string;
          artist_id: number | null;
          data: TopItem[];
        }>('/listening/top/tracks', {
          period,
          limit,
          page,
          date,
          from,
          to,
          ...(artist_id !== undefined ? { artist_id } : {}),
          ...(artist_name !== undefined ? { artist_name } : {}),
        });

        if (!data.data.length) {
          const scope =
            data.artist_id !== null ? ` for artist id ${data.artist_id}` : '';
          return {
            content: [text(`No top tracks${scope} for period: ${period}`)],
            structuredContent: data,
          };
        }

        const scope =
          data.artist_id !== null && data.data.length
            ? ` by ${data.data[0].detail}`
            : '';
        const lines = [`Top Tracks (${period})${scope}:`];
        for (const t of data.data) {
          const linkUrl = t.apple_music_url ?? t.url ?? null;
          const nameMd = linkUrl ? `[${t.name}](${linkUrl})` : `"${t.name}"`;
          // When filtering to a single artist, drop the redundant "by X"
          // suffix that would repeat on every line.
          const byPart = data.artist_id !== null ? '' : ` by ${t.detail}`;
          lines.push(
            `${t.rank}. ${nameMd}${byPart} -- ${fmt(t.playcount)} plays`
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
  server.registerTool(
    'get_listening_streaks',
    {
      title: 'Listening streaks',
      description:
        'Get listening streak data from Last.fm -- current consecutive days with scrobbles and the longest streak ever.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: listeningStreaksOutputSchema,
    },
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
  // Registered via server.registerTool so we can attach `_meta.ui.resourceUri`.
  // Hosts that support MCP Apps render an interactive single-artist card
  // inline; others fall back to the text + image + resource_link response.
  //
  // structuredContent uses the DESIGN.md nested shape: { artist, listening_stats,
  // sparkline, top_tracks, top_albums, similar_artists }. Bio is lazy-filled
  // by the route handler on first call (~200ms additional latency once,
  // instant thereafter).
  server.registerTool(
    'get_artist_details',
    {
      title: 'Artist',
      description:
        "Detailed listening profile for one artist: stats, rank, top tracks and albums, similar artists, and a yearly play sparkline. Includes bio, first/last played, and total scrobbles. Use for natural-language queries like 'tell me about my X listening history'. In MCP Apps hosts, renders an interactive artist card inline.",
      inputSchema: {
        id: z.number().describe('Artist ID'),
        ...includeImagesParam,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: artistDetailsOutputSchema,
      _meta: {
        ui: { resourceUri: 'ui://rewind/artist.html' },
        'ui/resourceUri': 'ui://rewind/artist.html',
      },
    },
    async ({ id, include_images }) =>
      withRichResponse(async () => {
        const data = await client.get<ArtistDetail>(`/listening/artists/${id}`);

        const lines = [
          data.name,
          `Total plays: ${fmt(data.playcount)}${data.all_time_rank ? ` (#${data.all_time_rank} all-time)` : ''}`,
          data.genre ? `Genre: ${data.genre}` : null,
          data.first_scrobbled_at
            ? `First scrobbled: ${formatDate(data.first_scrobbled_at)}`
            : null,
          data.last_played_at
            ? `Last played: ${timeAgo(data.last_played_at)}`
            : null,
          data.distinct_tracks
            ? `${fmt(data.distinct_tracks)} distinct tracks across ${fmt(data.distinct_albums)} albums`
            : null,
          '',
        ].filter((l) => l !== null);

        if (data.bio_summary) {
          lines.push(data.bio_summary, '');
        }

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
          lines.push('');
        }

        if (data.similar_artists.length) {
          lines.push('Similar artists you also listen to:');
          for (const s of data.similar_artists.slice(0, 5)) {
            lines.push(
              `  - ${s.name} (${fmt(s.your_scrobble_count)} of your plays)`
            );
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

        // structuredContent: nested DESIGN.md shape. Top tracks capped at 10,
        // top albums at 5, similar artists at 5. The model gets the data;
        // the card renders the rich layout from it.
        const structuredContent = {
          artist: {
            id: data.id,
            name: data.name,
            mbid: data.mbid,
            url: data.url,
            apple_music_url: data.apple_music_url,
            apple_music_id: null,
            genre: data.genre,
            tags: (data.tags ?? []).map((t) => t.name).slice(0, 5),
            bio_summary: data.bio_summary,
            bio_content: data.bio_content,
            image: data.image,
          },
          listening_stats: {
            total_scrobbles: data.scrobble_count,
            first_scrobble_at: data.first_scrobbled_at,
            last_played_at: data.last_played_at,
            all_time_rank: data.all_time_rank,
            distinct_tracks: data.distinct_tracks,
            distinct_albums: data.distinct_albums,
          },
          sparkline: data.sparkline,
          top_tracks: data.top_tracks.slice(0, 10).map((t, i) => ({
            rank: i + 1,
            id: t.id,
            name: t.name,
            album_id: t.album_id,
            album_name: t.album_name,
            scrobble_count: t.scrobble_count,
            apple_music_url: t.apple_music_url,
            preview_url: t.preview_url,
            image: t.image,
          })),
          top_albums: data.top_albums.slice(0, 5).map((a, i) => ({
            rank: i + 1,
            id: a.id,
            name: a.name,
            playcount: a.playcount,
            apple_music_url: a.apple_music_url,
            image: a.image,
          })),
          similar_artists: data.similar_artists.slice(0, 5),
        };

        return { content, structuredContent };
      })
  );

  // get_album_details ──────────────────────────────────────────────
  server.registerTool(
    'get_album_details',
    {
      title: 'Album',
      description:
        'Get detailed information about a specific album by ID: artist, play count, track listing, cover art, and Apple Music link.',
      inputSchema: {
        id: z.number().describe('Album ID'),
        ...includeImagesParam,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: albumDetailsOutputSchema,
    },
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
  server.registerTool(
    'get_listening_genres',
    {
      title: 'Listening genres',
      description:
        'Get genre breakdown over time from Last.fm listening history, grouped by week/month/year. Designed for stacked chart visualization.',
      inputSchema: {
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
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: listeningGenresOutputSchema,
    },
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
