// Search-based ESPN player-id resolver. Complement to
// `enrich-espn-ids.ts` (which game-scopes via box scores) — that path
// only catches players who appear in ESPN game summaries, which leaves
// out relief pitchers and bench players who are in MLB Stats boxscores
// but not in ESPN's summary.athletes lists.
//
// This resolver walks every `players` row missing an `espn_id` and hits
// ESPN's site search (`apis/search/v2`) by normalized name, filtered to
// MLB results. When the search returns multiple MLB hits for the same
// name (e.g. two Chris Youngs, two John McDonalds), we disambiguate by
// fetching each candidate's `common/v3/.../athletes/{id}` profile and
// matching position class against our `primary_position`.
//
// Probe results (2026-04-26): of 340 unmatched MLB players,
//   - 310 have a single MLB search hit
//   -  25 have multiple MLB hits (position-class disambiguation works)
//   -   5 have zero hits (name-format quirks like "C.J. Wilson")
// Realistic resolution rate: ~97%.

import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { players } from '../../db/schema/attending.js';

const SEARCH_URL = 'https://site.web.api.espn.com/apis/search/v2';
const PROFILE_URL =
  'https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes';

export interface EnrichEspnIdsBySearchOptions {
  // Limit how many players to scan in one call. Each scan is ~1 search
  // request, plus 1 profile request per multi-hit candidate.
  limit?: number;
  // Throttle between ESPN requests (ms). ESPN is unmetered but we don't
  // want to hammer it.
  throttleMs?: number;
}

export interface EnrichEspnIdsBySearchResult {
  scanned: number;
  resolved_unique: number;
  resolved_disambiguated: number;
  multi_unresolved: number;
  zero_match: number;
  collision_skipped: number;
  errors: number;
  failures: Array<{ player_id: number; name: string; reason: string }>;
}

interface EspnSearchHit {
  espn_id: string;
  display_name: string;
  subtitle: string;
}

interface EspnProfileSummary {
  id: string;
  display_name: string;
  jersey: string | null;
  position_abbr: string | null;
  team_name: string | null;
}

export async function enrichEspnIdsBySearch(
  db: Database,
  opts: EnrichEspnIdsBySearchOptions = {}
): Promise<EnrichEspnIdsBySearchResult> {
  const { limit = 500, throttleMs = 50 } = opts;

  const result: EnrichEspnIdsBySearchResult = {
    scanned: 0,
    resolved_unique: 0,
    resolved_disambiguated: 0,
    multi_unresolved: 0,
    zero_match: 0,
    collision_skipped: 0,
    errors: 0,
    failures: [],
  };

  const candidates = await db
    .select({
      id: players.id,
      first_name: players.firstName,
      last_name: players.lastName,
      primary_position: players.primaryPosition,
      primary_number: players.primaryNumber,
    })
    .from(players)
    .where(and(eq(players.league, 'mlb'), isNull(players.espnId)))
    .limit(limit);

  for (const p of candidates) {
    result.scanned++;
    if (!p.first_name || !p.last_name) {
      result.failures.push({
        player_id: p.id,
        name: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
        reason: 'missing first or last name',
      });
      continue;
    }

    const queryName = `${normalize(p.first_name)} ${normalize(p.last_name)}`;
    let hits: EspnSearchHit[];
    try {
      hits = await searchEspn(queryName);
    } catch (err) {
      result.errors++;
      result.failures.push({
        player_id: p.id,
        name: queryName,
        reason: `search: ${err instanceof Error ? err.message : String(err)}`,
      });
      await sleep(throttleMs);
      continue;
    }

    let chosen: { espnId: string; via: 'unique' | 'disambiguated' } | null =
      null;

    if (hits.length === 0) {
      result.zero_match++;
    } else if (hits.length === 1) {
      chosen = { espnId: hits[0].espn_id, via: 'unique' };
    } else {
      // Multi-hit: fetch each candidate's profile and disambiguate by
      // position class. We also check jersey as a backup tiebreaker.
      const profiles: EspnProfileSummary[] = [];
      for (const h of hits) {
        try {
          const prof = await fetchProfile(h.espn_id);
          if (prof) profiles.push(prof);
        } catch {
          // Skip individual profile errors — leave the candidate out.
        }
        await sleep(throttleMs);
      }
      const ourClass = positionClass(p.primary_position);
      const positionMatches = profiles.filter(
        (prof) => positionClass(prof.position_abbr) === ourClass
      );

      if (positionMatches.length === 1) {
        chosen = { espnId: positionMatches[0].id, via: 'disambiguated' };
      } else if (positionMatches.length > 1 && p.primary_number) {
        // Fall back to jersey number when position class can't break
        // the tie (extremely rare — same name, same position).
        const jerseyMatch = positionMatches.find(
          (prof) => prof.jersey === p.primary_number
        );
        if (jerseyMatch) {
          chosen = { espnId: jerseyMatch.id, via: 'disambiguated' };
        }
      }

      if (!chosen) {
        result.multi_unresolved++;
        result.failures.push({
          player_id: p.id,
          name: queryName,
          reason: `${hits.length} MLB hits, position-class=${ourClass}, ${positionMatches.length} pos-matches`,
        });
      }
    }

    if (chosen) {
      // Belt-and-suspenders: don't overwrite an espn_id already taken
      // by a different player. The unique (league, espn_id) index would
      // throw, but we'd rather count it than crash the loop.
      const taken = await db
        .select({ id: players.id })
        .from(players)
        .where(
          and(eq(players.league, 'mlb'), eq(players.espnId, chosen.espnId))
        )
        .limit(1);
      if (taken.length > 0 && taken[0].id !== p.id) {
        result.collision_skipped++;
        result.failures.push({
          player_id: p.id,
          name: queryName,
          reason: `espn_id ${chosen.espnId} already on player ${taken[0].id}`,
        });
      } else {
        await db
          .update(players)
          .set({ espnId: chosen.espnId, updatedAt: new Date().toISOString() })
          .where(eq(players.id, p.id));
        if (chosen.via === 'unique') result.resolved_unique++;
        else result.resolved_disambiguated++;
      }
    }

    await sleep(throttleMs);
  }

  return result;
}

async function searchEspn(name: string): Promise<EspnSearchHit[]> {
  const url = `${SEARCH_URL}?region=us&lang=en&query=${encodeURIComponent(name)}&limit=10`;
  const res = await fetch(url, { headers: { 'User-Agent': 'rewind/1.0' } });
  if (!res.ok) throw new Error(`search ${res.status}`);
  const body = (await res.json()) as {
    results?: Array<{
      type?: string;
      contents?: Array<{
        defaultLeagueSlug?: string;
        displayName?: string;
        subtitle?: string;
        link?: { web?: string };
      }>;
    }>;
  };
  const hits: EspnSearchHit[] = [];
  for (const r of body.results ?? []) {
    if (r.type !== 'player') continue;
    for (const c of r.contents ?? []) {
      if (c.defaultLeagueSlug !== 'mlb') continue;
      const link = c.link?.web ?? '';
      const idMatch = link.match(/\/id\/(\d+)/);
      if (!idMatch) continue;
      hits.push({
        espn_id: idMatch[1],
        display_name: c.displayName ?? '',
        subtitle: c.subtitle ?? '',
      });
    }
  }
  return hits;
}

async function fetchProfile(
  espnId: string
): Promise<EspnProfileSummary | null> {
  const url = `${PROFILE_URL}/${espnId}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'rewind/1.0' } });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    athlete?: {
      id?: string;
      displayName?: string;
      jersey?: string;
      position?: { abbreviation?: string };
      team?: { displayName?: string };
    };
  };
  const a = body.athlete;
  if (!a?.id) return null;
  return {
    id: a.id,
    display_name: a.displayName ?? '',
    jersey: a.jersey ?? null,
    position_abbr: a.position?.abbreviation ?? null,
    team_name: a.team?.displayName ?? null,
  };
}

/**
 * Coarse position classes for MLB-Stats / ESPN cross-matching.
 *
 * MLB Stats uses generic codes like "P" for any pitcher, while ESPN
 * splits SP/RP/CL/etc. We collapse to a small set so a "P" in our DB
 * matches any pitching variant on ESPN's side.
 */
export function positionClass(
  abbr: string | null | undefined
): 'pitcher' | 'catcher' | 'infield' | 'outfield' | 'dh' | 'unknown' {
  if (!abbr) return 'unknown';
  const a = abbr.toUpperCase();
  if (a === 'P' || a === 'SP' || a === 'RP' || a === 'CL' || a === 'CP')
    return 'pitcher';
  if (a === 'LR' || a === 'MR' || a === 'SU') return 'pitcher';
  if (a === 'C') return 'catcher';
  if (a === '1B' || a === '2B' || a === '3B' || a === 'SS' || a === 'IF')
    return 'infield';
  if (a === 'LF' || a === 'CF' || a === 'RF' || a === 'OF') return 'outfield';
  if (a === 'DH') return 'dh';
  return 'unknown';
}

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.]/g, '') // "C.J." → "CJ"
    .trim()
    .toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
