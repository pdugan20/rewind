import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from '../client.js';
import {
  withRichResponse,
  text,
  imageBlock,
  formatDate,
  fmt,
  READ_ONLY_ANNOTATIONS,
  includeImagesParam,
  LIST_IMAGE_PX,
  type ContentBlock,
} from './helpers.js';

// ─── Types ───────────────────────────────────────────────────────────

type Photo = {
  cdn_url?: string | null;
  url?: string | null;
  thumbhash?: string | null;
  dominant_color?: string | null;
  accent_color?: string | null;
} | null;

type Venue = {
  id: number;
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  capacity: number | null;
} | null;

type Player = {
  id: number;
  league: string;
  mlb_stats_id: number | null;
  espn_id: string | null;
  full_name: string;
  primary_position: string | null;
  primary_number: string | null;
  birth_date: string | null;
  birth_country: string | null;
  bats: string | null;
  throws: string | null;
  primary_team_id: number | null;
  debut_date: string | null;
  photo_silo: Photo;
  photo_full: Photo;
};

type Appearance = {
  player: Player;
  team_id: number | null;
  is_home: boolean;
  batting_line: Record<string, unknown> | null;
  pitching_line: Record<string, unknown> | null;
  fielding_line: Record<string, unknown> | null;
  decision: 'W' | 'L' | 'SV' | 'HLD' | 'BS' | null;
  notable: boolean;
};

type AttendedEvent = {
  id: number;
  category: 'sports' | 'music' | 'arts';
  event_type: string;
  event_date: string;
  event_datetime: string | null;
  title: string;
  subtitle: string | null;
  external_id: string | null;
  external_source: string | null;
  event_data: Record<string, unknown> | null;
  notes: string | null;
  attended: boolean;
  venue: Venue;
  tickets: unknown[];
};

type AttendedEventDetail = AttendedEvent & {
  players: Appearance[];
};

type AttendedSeasonResponse = {
  league: string;
  season: number;
  attended_count: number;
  wins: number;
  losses: number;
  data: AttendedEvent[];
};

type Pagination = {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
};

type AttendingStats = {
  total_events: number;
  attended_events: number;
  by_category: Array<{ category: string; count: number }>;
  by_event_type: Array<{ event_type: string; count: number }>;
  by_year: Array<{ year: string; count: number }>;
};

// ─── Tool registration ───────────────────────────────────────────────

export function registerAttendingTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_attended_events ─────────────────────────────────────────────
  server.tool(
    'get_attended_events',
    'List events you bought tickets for: sports games, concerts, theater. Filterable by category (sports/music/arts), event_type (mlb_game, concert, etc.), season, year, and venue. Includes events you bought tickets for but did not attend (attended=false).',
    {
      page: z.number().min(1).default(1).describe('Page number, 1-indexed.'),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe('Items per page (max 100).'),
      category: z
        .enum(['sports', 'music', 'arts'])
        .optional()
        .describe('Top-level category filter.'),
      event_type: z
        .string()
        .optional()
        .describe('Specific type, e.g. "mlb_game", "concert", "ncaaf_game".'),
      season: z
        .number()
        .int()
        .optional()
        .describe('Sports season year (e.g. 2024).'),
      year: z
        .number()
        .int()
        .optional()
        .describe('Calendar year filter on event_date.'),
      venue_id: z.number().int().optional().describe('Filter by venue id.'),
      attended: z
        .number()
        .int()
        .min(0)
        .max(1)
        .optional()
        .describe(
          '1 = only attended, 0 = only unattended (purchased but missed). Omit to return both.'
        ),
    },
    READ_ONLY_ANNOTATIONS,
    async ({
      page,
      limit,
      category,
      event_type,
      season,
      year,
      venue_id,
      attended,
    }) =>
      withRichResponse(async () => {
        const data = await client.get<{
          data: AttendedEvent[];
          pagination: Pagination;
        }>('/attending/events', {
          page,
          limit,
          category,
          event_type,
          season,
          year,
          venue_id,
          attended,
        });

        if (!data.data.length) {
          return {
            content: [text('No attended events match those filters.')],
            structuredContent: data,
          };
        }

        const lines = [
          `Attended events (page ${page} of ${data.pagination.total_pages}, ${data.pagination.total} total):`,
        ];
        for (const [i, e] of data.data.entries()) {
          const date = formatDate(e.event_date);
          const venue = e.venue ? ` @ ${e.venue.name}` : '';
          const score = e.subtitle ? ` -- ${e.subtitle}` : '';
          const noShow = e.attended ? '' : ' [no-show]';
          lines.push(
            `${i + 1}. ${date} -- ${e.title}${venue}${score}${noShow}`
          );
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: data,
        };
      })
  );

  // get_attended_season ─────────────────────────────────────────────
  // Drives the season-grid card UI in MCP Apps hosts.
  server.registerTool(
    'get_attended_season',
    {
      title: 'Attended sports season',
      description:
        'Get every game you attended (or hold tickets for) in a given league + season, with W/L record. league is a slug like "mlb", "nfl", "ncaaf", "nba", "wnba". In MCP Apps hosts, renders an interactive season grid with score, attendance, and notable performers.',
      inputSchema: {
        league: z
          .string()
          .describe(
            'League slug (lowercase): "mlb", "nfl", "nba", "wnba", "ncaaf", "ncaab", "mls".'
          ),
        season: z
          .number()
          .int()
          .describe('Season year (e.g. 2024 for the 2024 MLB season).'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ui: { resourceUri: 'ui://rewind/attended-season.html' },
        'ui/resourceUri': 'ui://rewind/attended-season.html',
      },
    },
    async ({ league, season }) =>
      withRichResponse(async () => {
        const data = await client.get<AttendedSeasonResponse>(
          `/attending/seasons/${league}/${season}`
        );

        if (!data.data.length) {
          return {
            content: [
              text(`No attended ${league.toUpperCase()} games in ${season}.`),
            ],
            structuredContent: data,
          };
        }

        const lines = [
          `${league.toUpperCase()} ${season}: ${data.attended_count} games attended (${data.wins}-${data.losses})`,
          '',
        ];
        for (const e of data.data) {
          const date = formatDate(e.event_date);
          const venue = e.venue ? ` @ ${e.venue.name}` : '';
          const score = e.subtitle ? ` -- ${e.subtitle}` : '';
          const noShow = e.attended ? '' : ' [no-show]';
          lines.push(`${date}: ${e.title}${venue}${score}${noShow}`);
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: data,
        };
      })
  );

  // get_attended_player ─────────────────────────────────────────────
  server.tool(
    'get_attended_player',
    'Get details for a player you have watched play in person, including bio (position, jersey, debut), photos, and every attended event in which they appeared with their stat line for that game.',
    {
      id: z.number().int().describe('Player id.'),
      ...includeImagesParam,
    },
    READ_ONLY_ANNOTATIONS,
    async ({ id, include_images }) =>
      withRichResponse(async () => {
        const data = await client.get<
          Player & {
            appearances: Array<{
              event_id: number;
              event_date: string;
              title: string;
              team_id: number | null;
              is_home: boolean;
              batting_line: Record<string, unknown> | null;
              pitching_line: Record<string, unknown> | null;
              decision: 'W' | 'L' | 'SV' | 'HLD' | 'BS' | null;
              notable: boolean;
            }>;
          }
        >(`/attending/players/${id}`);

        const bio = [
          `${data.full_name}${data.primary_number ? ` #${data.primary_number}` : ''}${data.primary_position ? ` (${data.primary_position})` : ''}`,
          data.bats || data.throws
            ? `Bats: ${data.bats ?? '?'}, Throws: ${data.throws ?? '?'}`
            : null,
          data.debut_date ? `MLB debut: ${formatDate(data.debut_date)}` : null,
          data.birth_country ? `From: ${data.birth_country}` : null,
        ].filter((l) => l !== null);

        const lines = [bio.join('\n')];
        if (data.appearances.length) {
          lines.push(
            '',
            `${data.appearances.length} attended games featuring this player:`
          );
          for (const a of data.appearances.slice(0, 25)) {
            const date = formatDate(a.event_date);
            const stat = summarizeAppearance(a);
            const decision = a.decision ? ` (${a.decision})` : '';
            lines.push(`${date}: ${a.title}${decision} -- ${stat}`);
          }
          if (data.appearances.length > 25) {
            lines.push(`... and ${data.appearances.length - 25} more.`);
          }
        }

        const images: ContentBlock[] = [];
        if (include_images) {
          const silo = await imageBlock(client, data.photo_silo, LIST_IMAGE_PX);
          if (silo) images.push(silo);
        }

        return {
          content: [text(lines.join('\n')), ...images],
          structuredContent: data,
        };
      })
  );

  // get_attending_stats ─────────────────────────────────────────────
  server.tool(
    'get_attending_stats',
    'Aggregate counts of attended events broken down by category, event_type, and year.',
    {},
    READ_ONLY_ANNOTATIONS,
    async () =>
      withRichResponse(async () => {
        const data = await client.get<AttendingStats>('/attending/stats');

        const lines = [
          `Total events: ${fmt(data.total_events)} (${fmt(data.attended_events)} attended)`,
          '',
          'By category:',
          ...data.by_category.map((r) => `  ${r.category}: ${fmt(r.count)}`),
          '',
          'By event type:',
          ...data.by_event_type.map(
            (r) => `  ${r.event_type}: ${fmt(r.count)}`
          ),
          '',
          'By year:',
          ...data.by_year
            .slice(0, 15)
            .map((r) => `  ${r.year}: ${fmt(r.count)}`),
        ];

        return {
          content: [text(lines.join('\n'))],
          structuredContent: data,
        };
      })
  );

  // get_attended_event ──────────────────────────────────────────────
  server.tool(
    'get_attended_event',
    'Get a single attended event in full detail, including venue, tickets, and per-player stat lines (for sports). Use this when the user asks "who was on that team" or "what happened in that game".',
    {
      id: z.number().int().describe('Event id.'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ id }) =>
      withRichResponse(async () => {
        const data = await client.get<AttendedEventDetail>(
          `/attending/events/${id}`
        );

        const date = formatDate(data.event_date);
        const venue = data.venue ? ` @ ${data.venue.name}` : '';
        const score = data.subtitle ? ` -- ${data.subtitle}` : '';
        const lines = [`${date}: ${data.title}${venue}${score}`];

        if (data.event_data) {
          const ed = data.event_data;
          if (ed.attendance)
            lines.push(`Attendance: ${fmt(ed.attendance as number)}`);
          if (ed.weather && typeof ed.weather === 'object') {
            const w = ed.weather as {
              condition?: string;
              temp?: string;
              wind?: string;
            };
            const parts = [
              w.condition,
              w.temp ? `${w.temp}°F` : null,
              w.wind,
            ].filter(Boolean);
            if (parts.length) lines.push(`Weather: ${parts.join(', ')}`);
          }
          if (ed.duration_minutes)
            lines.push(`Duration: ${ed.duration_minutes} min`);
        }

        const notable = data.players.filter((p) => p.notable);
        if (notable.length) {
          lines.push('', 'Notable performances:');
          for (const a of notable.slice(0, 12)) {
            const stat = summarizeAppearance(a);
            const decision = a.decision ? ` (${a.decision})` : '';
            lines.push(`  ${a.player.full_name}${decision} -- ${stat}`);
          }
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: data,
        };
      })
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function summarizeAppearance(a: {
  batting_line: Record<string, unknown> | null;
  pitching_line: Record<string, unknown> | null;
}): string {
  const parts: string[] = [];
  if (a.batting_line) {
    const b = a.batting_line as {
      ab?: number;
      h?: number;
      rbi?: number;
      hr?: number;
      bb?: number;
      k?: number;
    };
    const line = `${b.h ?? 0}-for-${b.ab ?? 0}`;
    const extras: string[] = [];
    if (b.hr) extras.push(`${b.hr} HR`);
    if (b.rbi) extras.push(`${b.rbi} RBI`);
    if (b.bb) extras.push(`${b.bb} BB`);
    if (b.k) extras.push(`${b.k} K`);
    parts.push(extras.length ? `${line}, ${extras.join(', ')}` : line);
  }
  if (a.pitching_line) {
    const p = a.pitching_line as {
      ip?: string;
      h?: number;
      er?: number;
      bb?: number;
      k?: number;
    };
    parts.push(
      `${p.ip ?? '0.0'} IP, ${p.h ?? 0} H, ${p.er ?? 0} ER, ${p.bb ?? 0} BB, ${p.k ?? 0} K`
    );
  }
  return parts.length ? parts.join(' | ') : '-';
}
