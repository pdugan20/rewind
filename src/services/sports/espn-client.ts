// Unified ESPN scoreboard client. Handles NFL, NBA, WNBA, MLS, NCAAF,
// and NCAAB via the same response shape:
//
//   GET https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard?dates=YYYYMMDD
//
// All six leagues use the same `events[].competitions[0].competitors[]`
// payload shape, so one client + one parser handles all of them.
//
// IMPORTANT: this is an unsupported endpoint family. ESPN has used it
// for their own site since ~2019 and tolerates public consumption, but
// they could pull it without notice. Wrapped in try/catch by callers
// so the pipeline doesn't fail when ESPN flakes.

import type { SportsGameMatch, SportsLeague, TeamRef } from './types.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// Discriminated union for the league dispatch.
export type EspnLeague =
  | { sport: 'football'; league: 'nfl'; mapped: 'nfl' }
  | { sport: 'football'; league: 'college-football'; mapped: 'ncaaf' }
  | { sport: 'basketball'; league: 'nba'; mapped: 'nba' }
  | { sport: 'basketball'; league: 'wnba'; mapped: 'wnba' }
  | {
      sport: 'basketball';
      league: 'mens-college-basketball';
      mapped: 'ncaab';
    }
  | { sport: 'soccer'; league: 'usa.1'; mapped: 'mls' };

export const ESPN_LEAGUES = {
  nfl: { sport: 'football', league: 'nfl', mapped: 'nfl' } as const,
  ncaaf: {
    sport: 'football',
    league: 'college-football',
    mapped: 'ncaaf',
  } as const,
  nba: { sport: 'basketball', league: 'nba', mapped: 'nba' } as const,
  wnba: { sport: 'basketball', league: 'wnba', mapped: 'wnba' } as const,
  ncaab: {
    sport: 'basketball',
    league: 'mens-college-basketball',
    mapped: 'ncaab',
  } as const,
  mls: { sport: 'soccer', league: 'usa.1', mapped: 'mls' } as const,
} satisfies Record<Exclude<SportsLeague, 'mlb'>, EspnLeague>;

export const ESPN_TEAM_IDS = {
  // Seattle pro
  seahawks: 26,
  storm: 14, // WNBA
  sounders: 9726, // MLS
  kraken: 124292, // NHL — not in this client's leagues, but reserve the name
  // College
  uw_huskies: 264,
  // Visiting (when traveling)
  blazers: 22,
  warriors: 9,
} as const;

interface RawScoreboard {
  events?: RawEvent[];
}

interface RawEvent {
  id: string;
  date: string; // UTC ISO 8601
  season?: { year?: number };
  status?: { type?: { description?: string; completed?: boolean } };
  competitions?: Array<{
    competitors?: Array<RawCompetitor>;
    status?: { type?: { description?: string } };
  }>;
}

interface RawCompetitor {
  homeAway?: 'home' | 'away';
  score?: string | number;
  winner?: boolean;
  team?: { id?: string | number; displayName?: string; abbreviation?: string };
}

/**
 * Fetch ESPN's scoreboard for a date and filter to events involving teamId.
 *
 * Returns 0 or 1 SportsGameMatch in nearly every case (you don't play
 * twice in one day for the leagues we cover). Returning an array keeps
 * the contract symmetrical with the MLB client (which can return 2 for
 * doubleheaders).
 */
export async function getEspnGamesByDate(
  league: EspnLeague,
  date: string,
  teamId: number
): Promise<SportsGameMatch[]> {
  const yyyymmdd = date.replace(/-/g, '');
  const url = `${BASE}/${league.sport}/${league.league}/scoreboard?dates=${yyyymmdd}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ESPN ${league.league} ${res.status}: ${body}`);
  }
  const data = (await res.json()) as RawScoreboard;

  const out: SportsGameMatch[] = [];
  for (const ev of data.events ?? []) {
    const comp = ev.competitions?.[0];
    if (!comp || !comp.competitors || comp.competitors.length < 2) continue;
    const home = comp.competitors.find((c) => c.homeAway === 'home');
    const away = comp.competitors.find((c) => c.homeAway === 'away');
    if (!home || !away) continue;
    const homeId = teamIdNum(home);
    const awayId = teamIdNum(away);
    if (homeId !== teamId && awayId !== teamId) continue;

    out.push({
      external_id: ev.id,
      external_source: 'espn',
      league: league.mapped,
      season: ev.season?.year ?? parseInt(date.slice(0, 4), 10),
      game_type: 'R', // ESPN doesn't surface a game-type code consistently
      game_date: date,
      game_datetime_utc: ev.date,
      status:
        ev.status?.type?.description ??
        comp.status?.type?.description ??
        'Unknown',
      home_team: toTeamRef(home),
      away_team: toTeamRef(away),
      home_score: parseScore(home.score),
      away_score: parseScore(away.score),
      home_is_winner: home.winner ?? null,
      away_is_winner: away.winner ?? null,
    });
  }
  return out;
}

function toTeamRef(c: RawCompetitor): TeamRef {
  return {
    id: teamIdNum(c) ?? 0,
    name: c.team?.displayName ?? '',
    abbreviation: c.team?.abbreviation,
  };
}

function teamIdNum(c: RawCompetitor): number | null {
  const id = c.team?.id;
  if (typeof id === 'number') return id;
  if (typeof id === 'string') {
    const n = parseInt(id, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseScore(score: string | number | undefined): number | null {
  if (typeof score === 'number') return score;
  if (typeof score === 'string') {
    const n = parseInt(score, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
