// MLB Stats API client. No auth, no documented rate limits, stable
// since ~2018. Powers MLB.com Gameday and is widely consumed by
// community libraries (mlbgame, pybaseball, MLB-StatsAPI).

import type { SportsGameMatch } from './types.js';

const BASE = 'https://statsapi.mlb.com/api/v1';

export const MLB_TEAM_IDS = {
  mariners: 136,
  astros: 117,
  rangers: 140,
  guardians: 114,
  yankees: 147,
  // ... add as needed.
} as const;

interface RawSchedule {
  dates?: Array<{
    date: string;
    games?: Array<RawGame>;
  }>;
}

interface RawGame {
  gamePk: number;
  gameDate: string; // ISO with TZ offset (UTC)
  officialDate: string;
  gameType: string;
  season: string;
  status?: { detailedState?: string };
  teams: {
    home: RawSide;
    away: RawSide;
  };
}

interface RawSide {
  team: { id: number; name: string };
  score?: number;
  isWinner?: boolean;
}

/**
 * Get MLB games involving teamId on the given date. Returns 0, 1, or 2
 * games (regular game + doubleheader).
 *
 * Date format: YYYY-MM-DD. Caller passes the venue-local date (Pacific
 * for Mariners home games), which lines up with MLB Stats API's
 * `officialDate` field.
 */
export async function getMlbGamesByDate(
  date: string,
  teamId: number
): Promise<SportsGameMatch[]> {
  const url = `${BASE}/schedule?teamId=${teamId}&date=${encodeURIComponent(date)}&sportId=1`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MLB Stats API ${res.status}: ${body}`);
  }
  const data = (await res.json()) as RawSchedule;
  const games: SportsGameMatch[] = [];
  for (const d of data.dates ?? []) {
    for (const g of d.games ?? []) {
      games.push(toMatch(g));
    }
  }
  return games;
}

function toMatch(g: RawGame): SportsGameMatch {
  return {
    external_id: String(g.gamePk),
    external_source: 'mlb_stats_api',
    league: 'mlb',
    season: parseInt(g.season, 10),
    game_type: g.gameType,
    game_date: g.officialDate,
    game_datetime_utc: g.gameDate,
    status: g.status?.detailedState ?? 'Unknown',
    home_team: { id: g.teams.home.team.id, name: g.teams.home.team.name },
    away_team: { id: g.teams.away.team.id, name: g.teams.away.team.name },
    home_score: g.teams.home.score ?? null,
    away_score: g.teams.away.score ?? null,
    home_is_winner: g.teams.home.isWinner ?? null,
    away_is_winner: g.teams.away.isWinner ?? null,
  };
}
