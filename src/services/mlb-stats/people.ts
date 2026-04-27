/**
 * MLB Stats people enrichment — fills the bio + awards fields the
 * boxscore endpoint omits. Backs the athlete card's bio strip and
 * career-highlights block.
 *
 * Bulk semantics: `/api/v1/people?personIds=1,2,3&hydrate=education,awards`
 * accepts up to ~100 IDs in a single call (verified). We chunk on top
 * of that to stay polite. Results are cached per-id in REWIND_CACHE
 * for 7 days — bio fields rarely change, awards almost never do
 * mid-season.
 *
 * Failure semantics match `mlb-stats/client.ts`: timeouts and non-200
 * degrade to `null` for that id; the caller writes through whatever
 * data it already has rather than failing the whole upsert.
 */

import type { Env } from '../../types/env.js';

const STATS_API = 'https://statsapi.mlb.com/api/v1';
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const FETCH_TIMEOUT_MS = 8000;
const CHUNK_SIZE = 100;

export interface PlayerBio {
  mlb_stats_id: number;
  first_name: string | null;
  last_name: string | null;
  primary_number: string | null;
  primary_position: string | null;
  birth_date: string | null; // YYYY-MM-DD
  birth_city: string | null;
  birth_state_province: string | null;
  birth_country: string | null;
  height: string | null; // raw "6' 2\""
  weight: number | null;
  bats: string | null; // 'L' | 'R' | 'S' | 'B'
  throws: string | null;
  debut_date: string | null;
  college_name: string | null;
  awards: PlayerAward[]; // filtered to honors that matter
}

export interface PlayerAward {
  season: string;
  id: string;
  name: string;
}

interface RawPerson {
  id: number;
  firstName?: string;
  lastName?: string;
  primaryNumber?: string;
  primaryPosition?: { abbreviation?: string };
  birthDate?: string;
  birthCity?: string;
  birthStateProvince?: string;
  birthCountry?: string;
  height?: string;
  weight?: number;
  batSide?: { code?: string };
  pitchHand?: { code?: string };
  mlbDebutDate?: string;
  education?: { colleges?: Array<{ name?: string }> };
  awards?: Array<{ id?: string; name?: string; season?: string }>;
}

interface RawPeopleResponse {
  people?: RawPerson[];
}

// Award names worth surfacing in a "career highlights" rail. Anything
// minor-league (BASSAS, MILBORGAS, CALMSAS, etc.) drops out. Match by
// substring on `award.name` since MLB Stats' canonical names are stable.
const AWARD_ALLOWLIST = [
  'Silver Slugger',
  'Gold Glove',
  'Platinum Glove',
  'MVP',
  'All-MLB',
  'Cy Young',
  'Rookie of the Year',
  'All-Star', // matches "AL All-Star" / "NL All-Star" but also minors —
  // upstream prefixes minor-league with conference abbreviations the
  // allowlist will reject (MILBORGAS), and the league prefix is in the
  // award `name` not the `id`, so AL/NL All-Star stays.
  'Hank Aaron',
  'Roberto Clemente',
  'Comeback Player',
  'Manager of the Year',
];

const AWARD_BLOCKLIST = [
  'Mid-Season All-Star', // minor-league mid-season teams
  'Post-Season All-Star',
  'Organization All-Star',
  'Short-Season All-Star',
  'Mariners MVP', // team-level honors are noisy; only league-wide MVP
];

function isAwardWorthShowing(name: string): boolean {
  if (AWARD_BLOCKLIST.some((b) => name.includes(b))) return false;
  return AWARD_ALLOWLIST.some((a) => name.includes(a));
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

function toBio(p: RawPerson): PlayerBio {
  const awards = (p.awards ?? [])
    .filter((a) => a.name && isAwardWorthShowing(a.name))
    .map((a) => ({
      season: a.season ?? '',
      id: a.id ?? '',
      name: a.name ?? '',
    }))
    // Newest first.
    .sort((a, b) => (b.season || '').localeCompare(a.season || ''));

  return {
    mlb_stats_id: p.id,
    first_name: p.firstName ?? null,
    last_name: p.lastName ?? null,
    primary_number: p.primaryNumber ?? null,
    primary_position: p.primaryPosition?.abbreviation ?? null,
    birth_date: p.birthDate ?? null,
    birth_city: p.birthCity ?? null,
    birth_state_province: p.birthStateProvince ?? null,
    birth_country: p.birthCountry ?? null,
    height: p.height ?? null,
    weight: typeof p.weight === 'number' ? p.weight : null,
    bats: p.batSide?.code ?? null,
    throws: p.pitchHand?.code ?? null,
    debut_date: p.mlbDebutDate ?? null,
    college_name: p.education?.colleges?.[0]?.name ?? null,
    awards,
  };
}

/**
 * Fetch + cache bios for a set of MLB players. Returns one record per
 * id that resolved upstream; missing/erroring ids are silently dropped
 * so callers can merge whatever came back with their existing rows.
 *
 * @param env Worker env (uses REWIND_CACHE)
 * @param mlbStatsIds player ids (deduplicated internally)
 */
export async function fetchPlayerBios(
  env: Env,
  mlbStatsIds: number[]
): Promise<PlayerBio[]> {
  const unique = Array.from(new Set(mlbStatsIds.filter((n) => n > 0)));
  if (unique.length === 0) return [];

  const cacheKeyFor = (id: number) => `mlb_stats:bio:v1:${id}`;
  const out: PlayerBio[] = [];
  const toFetch: number[] = [];

  // Cache lookup
  for (const id of unique) {
    try {
      const cached = await env.REWIND_CACHE.get(cacheKeyFor(id), 'json');
      if (cached && typeof cached === 'object') {
        out.push(cached as PlayerBio);
        continue;
      }
    } catch {
      /* fall through to network */
    }
    toFetch.push(id);
  }

  if (toFetch.length === 0) return out;

  // Bulk fetch in chunks of CHUNK_SIZE
  for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
    const chunk = toFetch.slice(i, i + CHUNK_SIZE);
    const url =
      `${STATS_API}/people?personIds=${chunk.join(',')}` +
      `&hydrate=education,awards`;
    let body: RawPeopleResponse;
    try {
      const resp = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!resp.ok) {
        console.log(`[WARN] MLB Stats /people ${resp.status} for chunk ${i}`);
        continue;
      }
      body = (await resp.json()) as RawPeopleResponse;
    } catch (err) {
      console.log(
        `[WARN] MLB Stats /people fetch failed: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    for (const p of body.people ?? []) {
      const bio = toBio(p);
      out.push(bio);
      try {
        await env.REWIND_CACHE.put(cacheKeyFor(p.id), JSON.stringify(bio), {
          expirationTtl: CACHE_TTL_SECONDS,
        });
      } catch {
        /* swallow — KV write failure is non-fatal */
      }
    }
  }

  return out;
}
