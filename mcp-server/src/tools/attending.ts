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
import {
  attendedEventSchema,
  attendedEventsOutputSchema,
  attendedPlayersOutputSchema,
  attendedSeasonOutputSchema,
  attendedEventDetailOutputSchema,
  attendingStatsOutputSchema,
  attendingYearInReviewOutputSchema,
  attendedPlayerStatsOutputSchema,
  attendedPlayerOutputSchema,
  playerSchema,
} from './schemas/attending.js';

// ─── Types ───────────────────────────────────────────────────────────
//
// Types below are derived from the Zod output schemas (schemas/attending.ts)
// where the structuredContent shape is exactly the tool's return shape, so
// the declared schema and the TS type cannot drift. Team stays hand-written
// -- it describes the raw-API team fragment used inside PlayerStatsResp.

type Team = {
  id: number;
  league: string;
  abbreviation: string;
  location: string | null;
  name: string;
  full_name: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  tertiary_color: string | null;
  ui_tint_color: string | null;
  logo_url: string | null;
  logo_dark_url: string | null;
  logo_light_url: string | null;
  conference: string | null;
  division: string | null;
};

type Player = z.infer<typeof playerSchema>;

type AttendedEvent = z.infer<typeof attendedEventSchema>;

type AttendedEventDetail = z.infer<typeof attendedEventDetailOutputSchema>;

type AttendedSeasonResponse = z.infer<typeof attendedSeasonOutputSchema>;

type Pagination = {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
};

type AttendingStats = z.infer<typeof attendingStatsOutputSchema>;

type AttendingYearInReview = z.infer<typeof attendingYearInReviewOutputSchema>;

// ─── Tool registration ───────────────────────────────────────────────

export function registerAttendingTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_attended_events ─────────────────────────────────────────────
  server.registerTool(
    'get_attended_events',
    {
      title: 'Attended events',
      description:
        'List events you bought tickets for: sports games, concerts, theater. Filterable by category (sports/music/arts), event_type (mlb_game, concert, etc.), season, year, venue, and team. Includes events you bought tickets for but did not attend (attended=false). Use `team` (substring match like "mariners" or "huskies") for natural-language queries; `team_id` for stable integer-keyed lookups. When the user asks about a SINGLE specific event ("last Mariners game I went to", "the Springsteen show I attended"), call this with the appropriate filter + `limit: 1` to find the id, then follow up with `get_attended_event(id)` to render the rich inline card — do not stop at the list-tool text response.',
      inputSchema: {
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
        team: z
          .string()
          .optional()
          .describe(
            'Case-insensitive substring match against either team name in event_data. e.g. "mariners", "huskies", "storm". Returns games where this team was either home or away.'
          ),
        team_id: z
          .number()
          .int()
          .optional()
          .describe(
            'Exact match on the league-native team id. e.g. 136 = Seattle Mariners (MLB), 264 = Washington Huskies (ESPN). Use when the natural-language `team` substring is ambiguous.'
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: attendedEventsOutputSchema,
    },
    async ({
      page,
      limit,
      category,
      event_type,
      season,
      year,
      venue_id,
      attended,
      team,
      team_id,
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
          team,
          team_id,
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
        for (const e of data.data) {
          const date = formatDate(e.event_date);
          const venue = e.venue ? ` @ ${e.venue.name}` : '';
          const score = e.subtitle ? ` -- ${e.subtitle}` : '';
          const noShow = e.attended ? '' : ' [no-show]';
          // Lead with `id=N` so Claude can pass it directly to
          // `get_attended_event(id)` for the rich card. Matches the
          // pattern used by `get_attended_players`.
          lines.push(
            `id=${e.id} ${date} -- ${e.title}${venue}${score}${noShow}`
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
      title: 'Sports season',
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
      outputSchema: attendedSeasonOutputSchema,
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
          // Lead with `id=N` so Claude can pass it directly to
          // `get_attended_event(id)` for the rich card.
          lines.push(`id=${e.id} ${date}: ${e.title}${venue}${score}${noShow}`);
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: data,
        };
      })
  );

  // get_attended_player ─────────────────────────────────────────────
  // get_attended_players ────────────────────────────────────────────
  // Search across the players-you-have-watched-play list. Supports name
  // substring lookup so the model can resolve "Julio" -> player id without
  // the user having to know the integer id.
  server.registerTool(
    'get_attended_players',
    {
      title: 'Attended players',
      description:
        'Search the list of players (MLB, NFL, NCAAF, NBA, etc.) you have watched play in person. Use `name` (substring, case-insensitive) to resolve a player by name. Use `league` and/or `team_id` to filter further. Common names like "Will Smith" return multiple matches — disambiguate via `primary_team.abbreviation` and `primary_position` on each result without a follow-up turn. When the user asks about a SPECIFIC player ("how\'s JP Crawford playing this year", "what are Cal Raleigh\'s stats", "tell me about Kirby"), call this to resolve the name to an id, then follow up with `get_attended_player(id)` to render the rich inline athlete card with current-season stats — do not stop at the search-result text response.',
      inputSchema: {
        page: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe('Page number, 1-indexed.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Items per page (max 50).'),
        name: z
          .string()
          .optional()
          .describe(
            'Case-insensitive substring match on full name. e.g. "julio", "kirby", "will smith".'
          ),
        league: z
          .string()
          .optional()
          .describe('Filter by league slug, e.g. "mlb", "nfl", "ncaaf".'),
        team_id: z
          .number()
          .int()
          .optional()
          .describe(
            'Filter by primary team id (league-native, e.g. 136 = Mariners in MLB).'
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: attendedPlayersOutputSchema,
    },
    async ({ page, limit, name, league, team_id }) =>
      withRichResponse(async () => {
        const data = await client.get<{
          data: Player[];
          pagination: Pagination;
        }>('/attending/players', {
          page,
          limit,
          name,
          league,
          team_id,
        });

        if (!data.data.length) {
          return {
            content: [text('No players match those filters.')],
            structuredContent: data,
          };
        }

        const lines = [
          `Players (${data.data.length} of ${data.pagination.total} matching${name ? ` "${name}"` : ''}):`,
        ];
        for (const p of data.data) {
          const pos = p.primary_position ? ` ${p.primary_position}` : '';
          const num = p.primary_number ? ` #${p.primary_number}` : '';
          const team = p.primary_team ? ` ${p.primary_team.abbreviation}` : '';
          lines.push(
            `id=${p.id} ${p.full_name}${num}${pos} (${p.league}${team})`
          );
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: data,
        };
      })
  );

  // get_attended_player ───────────────────────────────────────────
  // Registered via server.registerTool so we can attach `_meta.ui.resourceUri`.
  // Hosts that support MCP Apps render the athlete card inline; others fall
  // back to the text + photo response.
  //
  // structuredContent uses the DESIGN.md nested shape: { player, supported,
  // season_stats, attended_summary, attended_appearances, attended_appearance_count }.
  // Appearances are capped at 10 most recent to keep the response within the
  // 8 KB token budget.
  server.registerTool(
    'get_attended_player',
    {
      title: 'Player',
      description:
        'Detailed athlete card for an MLB / NFL / NCAAF / NBA player you\'ve watched play in person. **Use this whenever the user asks how a specific player is performing this season, what their batting average / ERA / current stats are, how their career has gone, or how they\'ve played in the games you attended** — e.g. "how\'s JP Crawford playing this year", "what are Cal Raleigh\'s numbers", "show me Kirby\'s stats", "tell me about Julio Rodriguez". Returns bio (position, jersey, debut, height/weight, college, awards), team logo, current-season stats (live MLB Stats API for MLB players, KV-cached 1h), career-by-season table, home/away/L-R splits, the **season_attended_summary** (this player\'s line in only the games you attended this season — use this to answer "how has he done in the games I\'ve been to this year"), the **attended_summary** (career line across every game you\'ve ever seen this player in), and the 10 most recent attended appearances. Trust season_attended_summary.games_attended as the count of games you\'ve attended this season — do NOT derive it by filtering attended_appearances yourself; that array is capped at 10 most-recent and will undercount for players you see often. MLB-only for the live-stats panel — non-MLB players surface as supported:false. In MCP Apps hosts, renders the rich inline athlete card. If you do not have the player id, first call `get_attended_players` with `name` to resolve the id, then call this to render the card.',
      inputSchema: {
        id: z.number().int().describe('Player id.'),
        ...includeImagesParam,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: attendedPlayerOutputSchema,
      _meta: {
        ui: { resourceUri: 'ui://rewind/attended-player.html' },
        'ui/resourceUri': 'ui://rewind/attended-player.html',
      },
    },
    async ({ id, include_images }) =>
      withRichResponse(async () => {
        const data = await client.get<
          Player & {
            supported: boolean;
            birth_city: string | null;
            birth_state_province: string | null;
            height: string | null;
            weight: number | null;
            college_name: string | null;
            awards: Array<{ season: string; id: string; name: string }>;
            season_stats: {
              season: number;
              fetched_at: string;
              cache_hit: boolean;
              hitter: Record<string, unknown> | null;
              pitcher: Record<string, unknown> | null;
            } | null;
            career: {
              group: 'hitting' | 'pitching';
              seasons: Array<Record<string, unknown>>;
              fetched_at: string;
              cache_hit: boolean;
            } | null;
            splits: {
              season: number;
              group: 'hitting' | 'pitching';
              home: Record<string, unknown> | null;
              away: Record<string, unknown> | null;
              vs_left: Record<string, unknown> | null;
              vs_right: Record<string, unknown> | null;
              fetched_at: string;
              cache_hit: boolean;
            } | null;
            attended_summary: {
              games_attended: number;
              games_with_box_score: number;
              wins: number;
              losses: number;
              hitter: Record<string, unknown> | null;
              pitcher: Record<string, unknown> | null;
            };
            season_attended_summary: {
              games_attended: number;
              games_with_box_score: number;
              wins: number;
              losses: number;
              hitter: Record<string, unknown> | null;
              pitcher: Record<string, unknown> | null;
            } | null;
            season_attended_summary_season: number | null;
            appearances: Array<{
              event_id: number;
              event_date: string;
              title: string;
              team: Team | null;
              is_home: boolean;
              batting_line: Record<string, unknown> | null;
              pitching_line: Record<string, unknown> | null;
              decision: 'W' | 'L' | 'SV' | 'HLD' | 'BS' | null;
              notable: boolean;
            }>;
            appearance_count: number;
          }
        >(`/attending/players/${id}`);

        const bio = [
          `${data.full_name}${data.primary_number ? ` #${data.primary_number}` : ''}${data.primary_position ? ` (${data.primary_position})` : ''}`,
          data.primary_team
            ? `Team: ${data.primary_team.full_name ?? data.primary_team.name} (${data.primary_team.abbreviation})`
            : null,
          data.bats || data.throws
            ? `Bats: ${data.bats ?? '?'}, Throws: ${data.throws ?? '?'}`
            : null,
          data.debut_date ? `MLB debut: ${formatDate(data.debut_date)}` : null,
          data.height || data.weight
            ? `${data.height ?? ''}${data.weight ? `, ${data.weight} lbs` : ''}`
                .trim()
                .replace(/^,\s*/, '')
            : null,
          data.birth_city || data.birth_state_province || data.birth_country
            ? `From: ${[data.birth_city, data.birth_state_province, data.birth_country].filter(Boolean).join(', ')}`
            : null,
          data.college_name ? `College: ${data.college_name}` : null,
        ].filter((l) => l !== null);

        const lines = [bio.join('\n')];

        // This-season stats — for MLB hitters/pitchers.
        if (data.season_stats?.hitter) {
          const h = data.season_stats.hitter;
          lines.push(
            '',
            `${data.season_stats.season} season: .${(h.avg ?? '.000').toString().replace(/^\./, '')} / .${(h.slg ?? '.000').toString().replace(/^\./, '')} (AVG / SLG), ${h.hr ?? 0} HR, ${h.rbi ?? 0} RBI in ${h.games_played ?? 0} games`
          );
        } else if (data.season_stats?.pitcher) {
          const p = data.season_stats.pitcher;
          lines.push(
            '',
            `${data.season_stats.season} season: ${p.era ?? '0.00'} ERA, ${p.whip ?? '0.00'} WHIP, ${p.k ?? 0} K in ${p.ip ?? '0'} IP`
          );
        }

        // Season-scoped attended summary — surfaced before the career line
        // so the model has the "this year, in games I've seen" answer
        // pre-computed and doesn't have to filter the appearance list.
        // Skip when zero games (preseason, or player you've never seen
        // play in the active season).
        const seasonSum = data.season_attended_summary;
        const seasonLabel = data.season_attended_summary_season;
        if (seasonSum && seasonSum.games_attended > 0 && seasonLabel != null) {
          if (seasonSum.hitter) {
            const h = seasonSum.hitter;
            lines.push(
              '',
              `In ${seasonSum.games_attended} ${seasonLabel} game${seasonSum.games_attended === 1 ? '' : 's'} you attended: ${h.h ?? 0}-for-${h.ab ?? 0} (.${(h.avg ?? '.000').toString().replace(/^\./, '')}), ${h.hr ?? 0} HR, ${h.rbi ?? 0} RBI`
            );
          } else if (seasonSum.pitcher) {
            const p = seasonSum.pitcher;
            const dec = p.decisions as
              | { w: number; l: number; sv: number }
              | undefined;
            lines.push(
              '',
              `In ${seasonSum.games_attended} ${seasonLabel} game${seasonSum.games_attended === 1 ? '' : 's'} you attended: ${p.ip ?? '0'} IP, ${p.k ?? 0} K, ${p.era ?? '0.00'} ERA${dec ? ` (${dec.w ?? 0}-${dec.l ?? 0})` : ''}`
            );
          }
        }

        // Career attended summary — your stat line across every game
        // you've ever seen this player in.
        if (data.attended_summary.hitter) {
          const h = data.attended_summary.hitter;
          lines.push(
            '',
            `Across all ${data.attended_summary.games_attended} games you've ever attended: ${h.h ?? 0} hits in ${h.ab ?? 0} AB, ${h.hr ?? 0} HR, ${h.rbi ?? 0} RBI`
          );
        } else if (data.attended_summary.pitcher) {
          const p = data.attended_summary.pitcher;
          const dec = p.decisions as
            | { w: number; l: number; sv: number }
            | undefined;
          lines.push(
            '',
            `Across all ${data.attended_summary.games_attended} games you've ever attended: ${p.ip ?? '0'} IP, ${p.k ?? 0} K, ${p.era ?? '0.00'} ERA${dec ? ` (${dec.w ?? 0}-${dec.l ?? 0})` : ''}`
          );
        }

        if (data.appearance_count > 0) {
          lines.push(
            '',
            `${data.appearance_count} attended appearance${data.appearance_count === 1 ? '' : 's'}:`
          );
          for (const a of data.appearances.slice(0, 25)) {
            const date = formatDate(a.event_date);
            const stat = summarizeAppearance(a);
            const decision = a.decision ? ` (${a.decision})` : '';
            lines.push(`${date}: ${a.title}${decision} -- ${stat}`);
          }
          if (data.appearance_count > 25) {
            lines.push(`... and ${data.appearance_count - 25} more.`);
          }
        }

        const images: ContentBlock[] = [];
        if (include_images) {
          const silo = await imageBlock(client, data.photo_silo, LIST_IMAGE_PX);
          if (silo) images.push(silo);
        }

        // structuredContent: nested DESIGN.md shape. Appearances capped at
        // 10 most recent for the card; total surfaced via attended_appearance_count.
        const structuredContent = {
          player: {
            id: data.id,
            mlb_stats_id: data.mlb_stats_id,
            full_name: data.full_name,
            primary_position: data.primary_position,
            primary_number: data.primary_number,
            bats: data.bats,
            throws: data.throws,
            debut_date: data.debut_date,
            birth_date: data.birth_date,
            birth_city: data.birth_city,
            birth_state_province: data.birth_state_province,
            birth_country: data.birth_country,
            height: data.height,
            weight: data.weight,
            college_name: data.college_name,
            awards: data.awards,
            photo_silo: data.photo_silo,
            photo_full: data.photo_full,
            league: data.league,
            primary_team: data.primary_team,
          },
          supported: data.supported,
          season_stats: data.season_stats,
          career: data.career,
          splits: data.splits,
          attended_summary: data.attended_summary,
          season_attended_summary: data.season_attended_summary,
          season_attended_summary_season: data.season_attended_summary_season,
          attended_appearances: data.appearances.slice(0, 10).map((a) => ({
            event_id: a.event_id,
            event_date: a.event_date,
            title: a.title,
            is_home: a.is_home,
            batting_line: a.batting_line,
            pitching_line: a.pitching_line,
            decision: a.decision,
            notable: a.notable,
            // Notable reasons stitched from batting/pitching lines for the
            // card. Lightweight client-side derivation matches the season
            // grid card's existing pattern.
            notable_reasons: deriveNotableReasons(a),
          })),
          attended_appearance_count: data.appearance_count,
        };

        return {
          content: [text(lines.join('\n')), ...images],
          structuredContent,
        };
      })
  );

  // get_attended_player_stats ──────────────────────────────────────
  // Aggregate per-player stat lines across attended games. MLB-only;
  // non-MLB players return supported:false with appearance summaries
  // (final scores, opponents) so the model can still answer
  // "what games did I see this player in" cleanly.
  // Raw `/attending/players/:id/stats` API response — a discriminated union
  // on `supported`, returned as structuredContent unchanged. Kept hand-written
  // (not z.infer'd from attendedPlayerStatsOutputSchema): the SDK requires a
  // single object outputSchema, so that schema flattens both branches into
  // one permissive object and loses the `supported`-keyed narrowing the
  // handler relies on here.
  type PlayerStatsResp =
    | {
        supported: true;
        hitter?: true;
        pitcher?: true;
        league: string;
        scope: 'career' | 'season';
        season?: number;
        player: {
          id: number;
          full_name: string;
          primary_position: string | null;
          primary_team: Team | null;
        };
        games: number;
        games_with_box_score: number;
        batting?: {
          pa: number;
          ab: number;
          h: number;
          hr: number;
          rbi: number;
          bb: number;
          k: number;
          sb: number;
          avg: string | null;
          slg: string | null;
        };
        pitching?: {
          ip: string;
          bf: number;
          k: number;
          bb: number;
          er: number;
          era: string | null;
          whip: string | null;
          decisions: {
            w: number;
            l: number;
            sv: number;
            hld: number;
            bs: number;
          };
        };
      }
    | {
        supported: false;
        league: string;
        reason: string;
        scope: 'career' | 'season';
        season?: number;
        player: {
          id: number;
          full_name: string;
          primary_position: string | null;
          primary_team: Team | null;
        };
        appearances: Array<{
          event_id: number;
          event_date: string;
          title: string;
          home_team: string | null;
          away_team: string | null;
          final_score: string | null;
          my_team_won: boolean | null;
        }>;
      };
  server.registerTool(
    'get_attended_player_stats',
    {
      title: 'Player stats',
      description:
        'Aggregate stats for one player across the games you attended. MLB players get a hitter slash line + counting stats, or a pitcher line + ERA / WHIP / decisions, depending on which stat lines exist on their appearances. Non-MLB players (NFL, NCAAF, NBA, etc.) return supported=false with appearance summaries (final scores, opponents) — full stat-line parsing for those leagues is on the roadmap. \n\n**Use career (omit `season`) by default.** Single-season slices are tiny — max 50 PAs across the entire dataset; career is where meaningful samples live (Cal Raleigh ~130 PAs / 32 attended games; Kirby ~238 BFs / 10 attended starts). Always cite `pa` (hitter) or `bf` (pitcher) and `games` when phrasing the answer so the user can judge confidence.',
      inputSchema: {
        id: z
          .number()
          .int()
          .describe(
            'Player id (from get_attended_players or get_attended_player).'
          ),
        season: z
          .number()
          .int()
          .optional()
          .describe(
            'Optional. Single-season slice. Omit for career across all attended games (recommended — see tool description).'
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: attendedPlayerStatsOutputSchema,
    },
    async ({ id, season }) =>
      withRichResponse<PlayerStatsResp>(async () => {
        const data = await client.get<PlayerStatsResp>(
          `/attending/players/${id}/stats`,
          season !== undefined ? { season } : {}
        );

        const scopeLabel =
          data.scope === 'career'
            ? 'across all attended games'
            : `in ${data.season}`;

        if (data.supported === false) {
          const games = data.appearances.length;
          const lines = [
            `${data.player.full_name} (${data.league}) — ${games} attended game${games === 1 ? '' : 's'} ${scopeLabel}.`,
            'Per-player stat-line parsing is not yet supported for this league.',
            '',
            'Game appearances:',
          ];
          for (const a of data.appearances.slice(0, 25)) {
            const date = formatDate(a.event_date);
            const score = a.final_score ? ` (${a.final_score})` : '';
            const result =
              a.my_team_won === true
                ? ' W'
                : a.my_team_won === false
                  ? ' L'
                  : '';
            lines.push(`  ${date}: ${a.title}${score}${result}`);
          }
          if (data.appearances.length > 25) {
            lines.push(`  ... and ${data.appearances.length - 25} more.`);
          }
          return {
            content: [text(lines.join('\n'))],
            structuredContent: data,
          };
        }

        if (data.batting) {
          const b = data.batting;
          const lines = [
            `${data.player.full_name} ${scopeLabel} — ${data.games} attended game${data.games === 1 ? '' : 's'}, ${b.pa} PA${b.pa === 1 ? '' : 's'}.`,
            `Slash: ${b.avg ?? '—'} / ${b.slg ?? '—'}  (AVG / SLG; OBP not stored)`,
            `Counting: ${b.h} H, ${b.hr} HR, ${b.rbi} RBI, ${b.bb} BB, ${b.k} K, ${b.sb} SB`,
            data.games_with_box_score < data.games
              ? `Note: ${data.games - data.games_with_box_score} of ${data.games} attended games lack box-score data.`
              : null,
          ].filter((l): l is string => l !== null);
          return {
            content: [text(lines.join('\n'))],
            structuredContent: data,
          };
        }

        if (data.pitching) {
          const p = data.pitching;
          const dec = `${p.decisions.w}W-${p.decisions.l}L${p.decisions.sv ? `, ${p.decisions.sv} SV` : ''}${p.decisions.hld ? `, ${p.decisions.hld} HLD` : ''}${p.decisions.bs ? `, ${p.decisions.bs} BS` : ''}`;
          const lines = [
            `${data.player.full_name} ${scopeLabel} — ${data.games} attended game${data.games === 1 ? '' : 's'}, ${p.bf} BF.`,
            `${p.ip} IP, ${p.er} ER, ${p.k} K, ${p.bb} BB`,
            `${p.era ?? '—'} ERA, ${p.whip ?? '—'} WHIP`,
            `Decisions: ${dec}`,
            data.games_with_box_score < data.games
              ? `Note: ${data.games - data.games_with_box_score} of ${data.games} attended games lack box-score data.`
              : null,
          ].filter((l): l is string => l !== null);
          return {
            content: [text(lines.join('\n'))],
            structuredContent: data,
          };
        }

        // MLB player with attended games but no batting/pitching lines.
        return {
          content: [
            text(
              `${data.player.full_name} attended ${data.games} game${data.games === 1 ? '' : 's'} ${scopeLabel}, but no per-player stat lines exist for this player on those games.`
            ),
          ],
          structuredContent: data,
        };
      })
  );

  // get_attending_stats ─────────────────────────────────────────────
  server.registerTool(
    'get_attending_stats',
    {
      title: 'Attendance stats',
      description:
        'Aggregate counts of attended events broken down by category, event_type, and year.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: attendingStatsOutputSchema,
    },
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
  // Uses server.registerTool so we can attach _meta.ui.resourceUri.
  // MCP Apps hosts (Claude Desktop, Claude web, Claude iOS) render the
  // game card inline via ui://rewind/attended-event.html; non-MCP-Apps
  // clients fall back to the text + structuredContent response.
  server.registerTool(
    'get_attended_event',
    {
      title: 'Event',
      description:
        'Get a single attended event (sports game, concert, theater show) in full detail, including venue, tickets, and per-player stat lines for sports games. Renders the rich inline event card — linescore, top performers with photos, ticket info — in MCP Apps hosts. Use this when the user asks about ONE specific event: "tell me about my last Mariners game," "who pitched in that Phillies game," "the Springsteen show I went to," "what happened at that game." If you do not have the event id, first call `get_attended_events` with a `team` / `event_type` filter (and `limit: 1` if the user asked for the most recent) to find the id, then call this to render the card.',
      inputSchema: {
        id: z.number().int().describe('Event id.'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: attendedEventDetailOutputSchema,
      _meta: {
        ui: { resourceUri: 'ui://rewind/attended-event.html' },
        'ui/resourceUri': 'ui://rewind/attended-event.html',
      },
    },
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

  // get_attending_year_in_review ────────────────────────────────────
  server.registerTool(
    'get_attending_year_in_review',
    {
      title: 'Attendance — year in review',
      description:
        'Year-in-review summary for attended events: totals, monthly breakdown, top venues, top concert performers, and the full event list. Use this when the user asks "what shows did I see in 2024" or "best year for games".',
      inputSchema: {
        year: z.number().int().describe('Calendar year, e.g. 2024.'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: attendingYearInReviewOutputSchema,
    },
    async ({ year }) =>
      withRichResponse(async () => {
        const data = await client.get<AttendingYearInReview>(
          `/attending/year/${year}`
        );

        const lines = [
          `${data.year}: ${fmt(data.total_events)} attended events`,
        ];
        if (data.total_spent_cents > 0) {
          lines.push(
            `Total ticket spend: $${(data.total_spent_cents / 100).toFixed(2)}`
          );
        }

        if (data.by_event_type.length) {
          lines.push('', 'By event type:');
          for (const r of data.by_event_type) {
            lines.push(`  ${r.event_type}: ${fmt(r.count)}`);
          }
        }

        if (data.top_venues.length) {
          lines.push('', 'Top venues:');
          for (const v of data.top_venues) {
            const city = v.city ? ` (${v.city})` : '';
            lines.push(`  ${v.name}${city}: ${fmt(v.count)}`);
          }
        }

        if (data.top_performers.length) {
          lines.push('', 'Top performers:');
          for (const p of data.top_performers) {
            lines.push(`  ${p.name}: ${fmt(p.count)}`);
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

// Reasons a particular attended appearance is "notable" — feeds the
// athlete card's bullet highlights ("3 HRs you witnessed live", etc.).
// Cheap and stateless; matches the criteria used by the per-game
// notable=1 backend flag.
function deriveNotableReasons(a: {
  batting_line: Record<string, unknown> | null;
  pitching_line: Record<string, unknown> | null;
  decision: string | null;
}): string[] {
  const reasons: string[] = [];
  if (a.batting_line) {
    const b = a.batting_line as {
      h?: number;
      hr?: number;
      rbi?: number;
      sb?: number;
    };
    if ((b.hr ?? 0) > 0) reasons.push(`${b.hr} HR`);
    if ((b.h ?? 0) >= 3) reasons.push('multi-hit');
    if ((b.rbi ?? 0) >= 4) reasons.push(`${b.rbi} RBI`);
    if ((b.sb ?? 0) >= 2) reasons.push(`${b.sb} SB`);
  }
  if (a.pitching_line) {
    const p = a.pitching_line as { ip?: string; k?: number };
    const ipNum = parseFloat(p.ip ?? '0');
    if (ipNum >= 9) reasons.push('complete game');
    if ((p.k ?? 0) >= 10) reasons.push(`${p.k} K`);
  }
  if (a.decision === 'W') reasons.push('win');
  if (a.decision === 'SV') reasons.push('save');
  return reasons;
}

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
