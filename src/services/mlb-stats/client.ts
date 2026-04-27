/**
 * MLB Stats API client — fetch live current-season stats for a player by
 * mlb_stats_id. Backs the athlete card's "This season" stat block.
 *
 * Cached in REWIND_CACHE (KV) for 1h. Network errors degrade to
 * `{ data: null }` so the card can render an "unavailable" state without
 * failing the whole request.
 *
 * Free, unauthenticated upstream — https://statsapi.mlb.com — but treat
 * timeouts and non-200s as expected.
 */

import type { Env } from '../../types/env.js';

const STATS_API = 'https://statsapi.mlb.com/api/v1';
const CACHE_TTL_SECONDS = 60 * 60; // 1 hour
const FETCH_TIMEOUT_MS = 5000;

export interface HitterSeasonStats {
  games_played: number;
  pa: number;
  ab: number;
  r: number;
  h: number;
  doubles: number;
  triples: number;
  hr: number;
  rbi: number;
  bb: number;
  k: number;
  sb: number;
  avg: string;
  obp: string;
  slg: string;
  ops: string;
}

export interface PitcherSeasonStats {
  games_played: number;
  games_started: number;
  ip: string; // "182.1" — outs-math format
  bf: number;
  h: number;
  r: number;
  er: number;
  bb: number;
  k: number;
  hr: number;
  era: string;
  whip: string;
  decisions: { w: number; l: number; sv: number; hld: number; bs: number };
}

export interface SeasonStatsResult {
  season: number;
  fetched_at: string; // ISO 8601
  cache_hit: boolean;
  hitter: HitterSeasonStats | null;
  pitcher: PitcherSeasonStats | null;
}

interface MlbStatRow {
  type?: { displayName?: string };
  group?: { displayName?: string };
  splits?: Array<{ stat?: Record<string, unknown> }>;
}

interface MlbStatsResponse {
  stats?: MlbStatRow[];
}

function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const parsed = parseInt(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function str(v: unknown, fallback = '0'): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return fallback;
}

function mapHitter(stat: Record<string, unknown>): HitterSeasonStats | null {
  // Treat missing PA as no hitting season — avoids reporting `0/0/.000`
  // for pitchers who haven't batted (NL pitcher in interleague, etc).
  const pa = num(stat.plateAppearances, -1);
  if (pa <= 0) return null;
  return {
    games_played: num(stat.gamesPlayed),
    pa,
    ab: num(stat.atBats),
    r: num(stat.runs),
    h: num(stat.hits),
    doubles: num(stat.doubles),
    triples: num(stat.triples),
    hr: num(stat.homeRuns),
    rbi: num(stat.rbi),
    bb: num(stat.baseOnBalls),
    k: num(stat.strikeOuts),
    sb: num(stat.stolenBases),
    avg: str(stat.avg, '.000'),
    obp: str(stat.obp, '.000'),
    slg: str(stat.slg, '.000'),
    ops: str(stat.ops, '.000'),
  };
}

function mapPitcher(stat: Record<string, unknown>): PitcherSeasonStats | null {
  // Treat missing IP / BF as no pitching season.
  const ip = stat.inningsPitched;
  const bf = num(stat.battersFaced, -1);
  if (bf <= 0 || !ip) return null;
  return {
    games_played: num(stat.gamesPlayed),
    games_started: num(stat.gamesStarted),
    ip: typeof ip === 'string' ? ip : String(ip),
    bf,
    h: num(stat.hits),
    r: num(stat.runs),
    er: num(stat.earnedRuns),
    bb: num(stat.baseOnBalls),
    k: num(stat.strikeOuts),
    hr: num(stat.homeRuns),
    era: str(stat.era, '0.00'),
    whip: str(stat.whip, '0.00'),
    decisions: {
      w: num(stat.wins),
      l: num(stat.losses),
      sv: num(stat.saves),
      hld: num(stat.holds),
      bs: num(stat.blownSaves),
    },
  };
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and cache season stats for a single MLB player.
 *
 * @param env  Worker env (uses REWIND_CACHE KV namespace)
 * @param mlbStatsId  player's MLB Stats API id (from `players.mlb_stats_id`)
 * @param season  4-digit year (e.g. 2026)
 * @returns `{ hitter, pitcher, ... }` or `null` data on failure
 */
export async function fetchPlayerSeasonStats(
  env: Env,
  mlbStatsId: number,
  season: number
): Promise<SeasonStatsResult | null> {
  const cacheKey = `mlb_stats:player:${mlbStatsId}:${season}`;

  // Cache lookup
  try {
    const cached = await env.REWIND_CACHE.get(cacheKey, 'json');
    if (cached && typeof cached === 'object') {
      return {
        ...(cached as Omit<SeasonStatsResult, 'cache_hit'>),
        cache_hit: true,
      };
    }
  } catch (err) {
    // KV miss is normal; KV hard failure is rare. Don't fail the request.
    console.log(
      `[WARN] REWIND_CACHE.get(${cacheKey}) failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Live fetch
  const url = `${STATS_API}/people/${mlbStatsId}/stats?stats=season&group=hitting,pitching&season=${season}`;
  let body: MlbStatsResponse;
  try {
    const resp = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    if (!resp.ok) {
      console.log(`[WARN] MLB Stats API ${resp.status} for ${url}`);
      return null;
    }
    body = (await resp.json()) as MlbStatsResponse;
  } catch (err) {
    console.log(
      `[WARN] MLB Stats API fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  // Map. Both groups may be present; map each independently.
  let hitter: HitterSeasonStats | null = null;
  let pitcher: PitcherSeasonStats | null = null;
  for (const row of body.stats ?? []) {
    const group = row.group?.displayName?.toLowerCase();
    const split = row.splits?.[0]?.stat;
    if (!split) continue;
    if (group === 'hitting') hitter = mapHitter(split);
    if (group === 'pitching') pitcher = mapPitcher(split);
  }

  if (!hitter && !pitcher) {
    // No useful data this season (e.g. didn't play, mid-season call-up
    // before stats accrued). Cache the negative for half the TTL so
    // we re-check sooner.
    const negative: SeasonStatsResult = {
      season,
      fetched_at: new Date().toISOString(),
      cache_hit: false,
      hitter: null,
      pitcher: null,
    };
    try {
      await env.REWIND_CACHE.put(cacheKey, JSON.stringify(negative), {
        expirationTtl: Math.floor(CACHE_TTL_SECONDS / 2),
      });
    } catch {
      /* swallow */
    }
    return negative;
  }

  const result: SeasonStatsResult = {
    season,
    fetched_at: new Date().toISOString(),
    cache_hit: false,
    hitter,
    pitcher,
  };

  // Cache write
  try {
    await env.REWIND_CACHE.put(cacheKey, JSON.stringify(result), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  } catch (err) {
    console.log(
      `[WARN] REWIND_CACHE.put(${cacheKey}) failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return result;
}
