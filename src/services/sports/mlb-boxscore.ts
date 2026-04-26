// MLB Stats API box score + live feed client. Pulls per-player stat
// lines, decisions, attendance, weather, and linescore for an attended
// game. Two endpoint versions:
//   v1   /game/{gamePk}/boxscore  — players + per-player stats
//   v1.1 /game/{gamePk}/feed/live — linescore, weather, attendance,
//                                    decisions, duration
// Both unauthenticated. Combine into one normalized payload.

const V1 = 'https://statsapi.mlb.com/api/v1';
const V1_1 = 'https://statsapi.mlb.com/api/v1.1';

export interface MlbPlayerBio {
  mlb_stats_id: number;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  primary_position: string | null;
  primary_number: string | null;
  birth_date: string | null;
  birth_city: string | null;
  birth_country: string | null;
  bats: string | null;
  throws: string | null;
  debut_date: string | null;
}

export interface MlbBattingLine {
  ab: number;
  r: number;
  h: number;
  rbi: number;
  bb: number;
  k: number;
  hr: number;
  doubles: number;
  triples: number;
  sb: number;
  hbp: number;
  pa: number;
  total_bases: number;
  left_on_base: number;
  summary: string | null;
}

export interface MlbPitchingLine {
  ip: string; // "6.2" — innings pitched is fractional, kept as string
  h: number;
  r: number;
  er: number;
  bb: number;
  k: number;
  hr: number;
  pitches: number | null;
  strikes: number | null;
  era: string | null;
  batters_faced: number | null;
  summary: string | null;
}

export interface MlbAppearance {
  player: MlbPlayerBio;
  team_id: number;
  is_home: boolean;
  batting_line: MlbBattingLine | null;
  pitching_line: MlbPitchingLine | null;
  decision: 'W' | 'L' | 'SV' | 'HLD' | 'BS' | null;
  notable: boolean; // HR, multi-hit, decision, or starting pitcher
  is_starter_pitcher: boolean;
  batting_order: number | null; // 100s = lineup, 200s = sub
}

export interface MlbBoxScoreData {
  game_pk: number;
  attendance: number | null;
  weather: { condition: string; temp: string; wind: string } | null;
  venue_name: string | null;
  first_pitch: string | null; // ISO
  duration_minutes: number | null;
  linescore: Array<{
    inning: number;
    home_runs: number | null;
    away_runs: number | null;
    home_hits: number | null;
    away_hits: number | null;
    home_errors: number | null;
    away_errors: number | null;
  }>;
  starting_pitcher_home_id: number | null;
  starting_pitcher_away_id: number | null;
  winning_pitcher_id: number | null;
  losing_pitcher_id: number | null;
  save_pitcher_id: number | null;
  appearances: MlbAppearance[];
}

interface RawBoxScore {
  teams: {
    home: RawTeamSide;
    away: RawTeamSide;
  };
  officials?: Array<{ official: { id: number; fullName: string } }>;
}

interface RawTeamSide {
  team: { id: number; name: string };
  players: Record<string, RawPlayer>; // keys like "ID660271"
  pitchers?: number[]; // ordered list
  battingOrder?: number[]; // 9 ids in lineup order
}

interface RawPlayer {
  person: {
    id: number;
    fullName: string;
    firstName?: string;
    lastName?: string;
    birthDate?: string;
    birthCity?: string;
    birthCountry?: string;
    primaryNumber?: string;
    mlbDebutDate?: string;
    batSide?: { code?: string };
    pitchHand?: { code?: string };
  };
  jerseyNumber?: string;
  position?: { abbreviation?: string };
  battingOrder?: string; // "100" / "200"
  stats?: {
    batting?: Record<string, number | string>;
    pitching?: Record<string, number | string>;
    fielding?: Record<string, number | string>;
  };
  gameStatus?: { isCurrentBatter?: boolean; isOnBench?: boolean };
}

interface RawLiveFeed {
  gamePk: number;
  gameData: {
    gameInfo?: {
      attendance?: number;
      firstPitch?: string;
      gameDurationMinutes?: number;
    };
    weather?: { condition?: string; temp?: string; wind?: string };
    venue?: { name?: string };
  };
  liveData: {
    linescore?: {
      innings?: Array<{
        num: number;
        home?: { runs?: number; hits?: number; errors?: number };
        away?: { runs?: number; hits?: number; errors?: number };
      }>;
    };
    decisions?: {
      winner?: { id: number };
      loser?: { id: number };
      save?: { id: number };
    };
  };
}

/**
 * Fetch + normalize a full MLB game's box score and live feed.
 * Returns null if the game is not found (404 from either endpoint).
 */
export async function fetchMlbBoxScore(
  gamePk: number
): Promise<MlbBoxScoreData | null> {
  const [boxRes, liveRes] = await Promise.all([
    fetch(`${V1}/game/${gamePk}/boxscore`),
    fetch(`${V1_1}/game/${gamePk}/feed/live`),
  ]);
  if (!boxRes.ok || !liveRes.ok) return null;
  const box = (await boxRes.json()) as RawBoxScore;
  const live = (await liveRes.json()) as RawLiveFeed;

  const appearances: MlbAppearance[] = [];
  for (const side of ['home', 'away'] as const) {
    const teamSide = box.teams[side];
    if (!teamSide) continue;
    const isHome = side === 'home';
    const startingPitcherId = teamSide.pitchers?.[0] ?? null;
    for (const playerKey of Object.keys(teamSide.players)) {
      const raw = teamSide.players[playerKey];
      const a = toAppearance(
        raw,
        teamSide.team.id,
        isHome,
        startingPitcherId,
        live.liveData.decisions ?? {}
      );
      if (a) appearances.push(a);
    }
  }

  const decisions = live.liveData.decisions ?? {};
  const innings = live.liveData.linescore?.innings ?? [];
  const linescore = innings.map((inn) => ({
    inning: inn.num,
    home_runs: inn.home?.runs ?? null,
    away_runs: inn.away?.runs ?? null,
    home_hits: inn.home?.hits ?? null,
    away_hits: inn.away?.hits ?? null,
    home_errors: inn.home?.errors ?? null,
    away_errors: inn.away?.errors ?? null,
  }));

  const homePitchers = box.teams.home?.pitchers ?? [];
  const awayPitchers = box.teams.away?.pitchers ?? [];
  const gi = live.gameData.gameInfo ?? {};
  const w = live.gameData.weather ?? {};

  return {
    game_pk: live.gamePk ?? gamePk,
    attendance: gi.attendance ?? null,
    weather:
      w.condition || w.temp || w.wind
        ? {
            condition: w.condition ?? '',
            temp: w.temp ?? '',
            wind: w.wind ?? '',
          }
        : null,
    venue_name: live.gameData.venue?.name ?? null,
    first_pitch: gi.firstPitch ?? null,
    duration_minutes: gi.gameDurationMinutes ?? null,
    linescore,
    starting_pitcher_home_id: homePitchers[0] ?? null,
    starting_pitcher_away_id: awayPitchers[0] ?? null,
    winning_pitcher_id: decisions.winner?.id ?? null,
    losing_pitcher_id: decisions.loser?.id ?? null,
    save_pitcher_id: decisions.save?.id ?? null,
    appearances,
  };
}

function toAppearance(
  raw: RawPlayer,
  teamId: number,
  isHome: boolean,
  startingPitcherId: number | null,
  decisions: {
    winner?: { id: number };
    loser?: { id: number };
    save?: { id: number };
  }
): MlbAppearance | null {
  const id = raw.person.id;
  if (!id) return null;
  const isStarter = startingPitcherId === id;
  const decision: MlbAppearance['decision'] =
    decisions.winner?.id === id
      ? 'W'
      : decisions.loser?.id === id
        ? 'L'
        : decisions.save?.id === id
          ? 'SV'
          : null;

  const battingLine = parseBattingLine(raw.stats?.batting);
  const pitchingLine = parsePitchingLine(raw.stats?.pitching);

  // "Notable" heuristic: had a hit-with-pop, a multi-hit game, was a
  // pitcher of record, or started the game on the mound. Set on sync
  // so consumer queries can filter for highlights cheaply.
  const notable =
    decision !== null ||
    isStarter ||
    (battingLine != null && (battingLine.h >= 2 || battingLine.hr >= 1));

  return {
    player: toBio(raw),
    team_id: teamId,
    is_home: isHome,
    batting_line: battingLine,
    pitching_line: pitchingLine,
    decision,
    notable,
    is_starter_pitcher: isStarter,
    batting_order:
      raw.battingOrder != null && raw.battingOrder !== ''
        ? parseInt(raw.battingOrder, 10)
        : null,
  };
}

function toBio(raw: RawPlayer): MlbPlayerBio {
  const p = raw.person;
  // Boxscore endpoint typically returns only `person.fullName` —
  // first/last aren't split by default. Fall back to whitespace-splitting
  // the full name so name-based joins (ESPN cross-ref) have something
  // to match on.
  const split = splitFullName(p.fullName);
  return {
    mlb_stats_id: p.id,
    full_name: p.fullName,
    first_name: p.firstName ?? split.first,
    last_name: p.lastName ?? split.last,
    primary_position: raw.position?.abbreviation ?? null,
    primary_number: raw.jerseyNumber ?? p.primaryNumber ?? null,
    birth_date: p.birthDate ?? null,
    birth_city: p.birthCity ?? null,
    birth_country: p.birthCountry ?? null,
    bats: p.batSide?.code ?? null,
    throws: p.pitchHand?.code ?? null,
    debut_date: p.mlbDebutDate ?? null,
  };
}

/**
 * Naive first/last split. "Cal Raleigh" → ("Cal", "Raleigh"). For
 * compound last names ("J.D. Martinez", "Vladimir Guerrero Jr.") the
 * MLB hydrate=person path gives us authoritative fields; this splitter
 * is the fallback when only fullName is present.
 */
function splitFullName(full: string | undefined): {
  first: string | null;
  last: string | null;
} {
  if (!full) return { first: null, last: null };
  const trimmed = full.trim();
  if (!trimmed) return { first: null, last: null };
  // Strip common suffixes off the end so they don't end up as "last name".
  const suffixes = /\s+(Jr\.?|Sr\.?|II|III|IV)$/i;
  const stripped = trimmed.replace(suffixes, '').trim();
  const parts = stripped.split(/\s+/);
  if (parts.length === 1) return { first: null, last: parts[0] };
  return {
    first: parts.slice(0, -1).join(' '),
    last: parts[parts.length - 1],
  };
}

function num(v: number | string | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

function parseBattingLine(
  raw: Record<string, number | string> | undefined
): MlbBattingLine | null {
  if (!raw || raw.gamesPlayed == null) return null;
  return {
    ab: num(raw.atBats),
    r: num(raw.runs),
    h: num(raw.hits),
    rbi: num(raw.rbi),
    bb: num(raw.baseOnBalls),
    k: num(raw.strikeOuts),
    hr: num(raw.homeRuns),
    doubles: num(raw.doubles),
    triples: num(raw.triples),
    sb: num(raw.stolenBases),
    hbp: num(raw.hitByPitch),
    pa: num(raw.plateAppearances),
    total_bases: num(raw.totalBases),
    left_on_base: num(raw.leftOnBase),
    summary: typeof raw.summary === 'string' ? raw.summary : null,
  };
}

function parsePitchingLine(
  raw: Record<string, number | string> | undefined
): MlbPitchingLine | null {
  if (!raw || raw.gamesPlayed == null) return null;
  return {
    ip: typeof raw.inningsPitched === 'string' ? raw.inningsPitched : '0.0',
    h: num(raw.hits),
    r: num(raw.runs),
    er: num(raw.earnedRuns),
    bb: num(raw.baseOnBalls),
    k: num(raw.strikeOuts),
    hr: num(raw.homeRuns),
    pitches: raw.numberOfPitches != null ? num(raw.numberOfPitches) : null,
    strikes: raw.strikes != null ? num(raw.strikes) : null,
    era: typeof raw.era === 'string' ? raw.era : null,
    batters_faced: raw.battersFaced != null ? num(raw.battersFaced) : null,
    summary: typeof raw.summary === 'string' ? raw.summary : null,
  };
}
