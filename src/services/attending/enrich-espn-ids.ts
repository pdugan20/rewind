// ESPN player-id cross-reference. For every attended MLB game we have
// a Mariners-vs-X box score for, hit ESPN's game summary endpoint and
// match each ESPN player to the MLB player by (last_name + jersey).
// Populates `players.espn_id` so the photo pipeline can fetch the
// ESPN full-body PNG variant.
//
// Approach: ESPN's schedule endpoint by team-season gives us
// (date, ESPN gameId, opposing team). We resolve our attended events
// to ESPN gameIds via a date+team match, then per-game pull the
// summary endpoint and walk both rosters.

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { attendedEvents, players } from '../../db/schema/attending.js';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb';

export interface EspnIdResult {
  scanned_events: number;
  matched_events: number;
  resolved_player_ids: number;
  failures: Array<{ event_id: number; reason: string }>;
}

interface EspnScheduleEntry {
  id: string;
  date: string; // ISO
  shortName: string; // e.g. "DET @ SEA"
  competitions?: Array<{
    competitors?: Array<{ team?: { id?: string; abbreviation?: string } }>;
  }>;
}

interface EspnSummaryAthlete {
  athlete: {
    id: string;
    displayName?: string;
    fullName?: string;
    lastName?: string;
    jersey?: string;
    position?: { abbreviation?: string };
  };
}

interface EspnSummaryStatGroup {
  athletes?: EspnSummaryAthlete[];
}

interface EspnSummary {
  boxscore?: {
    players?: Array<{
      team?: { id?: string };
      statistics?: EspnSummaryStatGroup[];
    }>;
  };
}

export interface EspnIdOptions {
  // Limit which events to scan. By default scans all MLB games where
  // any associated player still lacks an espn_id.
  eventIds?: number[];
  limit?: number;
}

export async function enrichEspnIds(
  db: Database,
  opts: EspnIdOptions = {}
): Promise<EspnIdResult> {
  const { eventIds, limit = 100 } = opts;
  const result: EspnIdResult = {
    scanned_events: 0,
    matched_events: 0,
    resolved_player_ids: 0,
    failures: [],
  };

  const events = await db
    .select()
    .from(attendedEvents)
    .where(
      and(
        eq(attendedEvents.eventType, 'mlb_game'),
        eq(attendedEvents.externalSource, 'mlb_stats_api'),
        isNotNull(attendedEvents.externalId)
      )
    )
    .limit(limit);

  // Cache schedule lookups per (team, year) — many of our games share a
  // year/team combo, so we do at most one fetch per Mariners season.
  const scheduleCache = new Map<string, EspnScheduleEntry[]>();

  for (const ev of events) {
    if (eventIds && !eventIds.includes(ev.id)) continue;
    result.scanned_events++;

    const eventDate = ev.eventDate;
    const year = eventDate.slice(0, 4);
    const cacheKey = `sea-${year}`;

    let schedule = scheduleCache.get(cacheKey);
    if (!schedule) {
      try {
        schedule = await fetchEspnSchedule('sea', parseInt(year, 10));
        scheduleCache.set(cacheKey, schedule);
      } catch (err) {
        result.failures.push({
          event_id: ev.id,
          reason: `schedule fetch: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
    }

    // ESPN stores dates in UTC; our event_date is the venue-local date
    // (Pacific for Mariners home games). Late-PT games (~7pm+) cross
    // midnight UTC, so the UTC date is one day AFTER our stored date.
    // Match against both eventDate and eventDate+1.
    const eventDatePlusOne = addOneDay(eventDate);
    const espnGame = schedule.find(
      (g) =>
        g.date.slice(0, 10) === eventDate ||
        g.date.slice(0, 10) === eventDatePlusOne
    );
    if (!espnGame) {
      result.failures.push({
        event_id: ev.id,
        reason: `no ESPN game on ${eventDate}`,
      });
      continue;
    }

    let summary: EspnSummary;
    try {
      summary = await fetchEspnSummary(espnGame.id);
    } catch (err) {
      result.failures.push({
        event_id: ev.id,
        reason: `summary fetch: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    result.matched_events++;
    const matched = await matchAndPersistEspnIds(db, summary);
    result.resolved_player_ids += matched;
  }

  return result;
}

async function fetchEspnSchedule(
  teamSlug: string,
  season: number
): Promise<EspnScheduleEntry[]> {
  const res = await fetch(
    `${ESPN_BASE}/teams/${teamSlug}/schedule?season=${season}`
  );
  if (!res.ok) throw new Error(`ESPN schedule ${res.status}`);
  const body = (await res.json()) as { events?: EspnScheduleEntry[] };
  return body.events ?? [];
}

async function fetchEspnSummary(gameId: string): Promise<EspnSummary> {
  const res = await fetch(`${ESPN_BASE}/summary?event=${gameId}`);
  if (!res.ok) throw new Error(`ESPN summary ${gameId} ${res.status}`);
  return (await res.json()) as EspnSummary;
}

/**
 * Walk the box score in the ESPN summary and match each athlete to a
 * player row by last_name + jersey (and league=mlb). Updates
 * `players.espn_id` when we find a confident match. Returns count of
 * newly-resolved espn_ids.
 *
 * Match rules (must all hold):
 *   - players.league = 'mlb'
 *   - players.last_name (lowercase) === athlete.lastName (lowercase)
 *   - players.primary_number === athlete.jersey  (when both present)
 *   - players.espn_id is currently NULL (don't overwrite existing)
 */
async function matchAndPersistEspnIds(
  db: Database,
  summary: EspnSummary
): Promise<number> {
  let count = 0;
  const teams = summary.boxscore?.players ?? [];
  for (const teamGroup of teams) {
    for (const grp of teamGroup.statistics ?? []) {
      for (const item of grp.athletes ?? []) {
        const a = item.athlete;
        if (!a?.id) continue;
        const lastName = (
          a.lastName ?? extractLastName(a.fullName ?? a.displayName ?? '')
        ).toLowerCase();
        const jersey = a.jersey ?? null;
        if (!lastName) continue;

        // Find a candidate match. We use raw SQL for case-insensitive last
        // name comparison (drizzle's eq() is case-sensitive).
        const candidates = await db
          .select({ id: players.id, primaryNumber: players.primaryNumber })
          .from(players)
          .where(
            and(
              eq(players.league, 'mlb'),
              isNull(players.espnId),
              sql`lower(${players.lastName}) = ${lastName}`
            )
          );

        let match: { id: number; primaryNumber: string | null } | null = null;
        if (candidates.length === 1) {
          match = candidates[0];
        } else if (candidates.length > 1 && jersey) {
          // Disambiguate by jersey when multiple players share a last name.
          match = candidates.find((c) => c.primaryNumber === jersey) ?? null;
        }
        if (!match) continue;

        await db
          .update(players)
          .set({ espnId: a.id, updatedAt: new Date().toISOString() })
          .where(eq(players.id, match.id));
        count++;
      }
    }
  }
  return count;
}

function extractLastName(fullName: string): string {
  if (!fullName) return '';
  const stripped = fullName.trim().replace(/\s+(Jr\.?|Sr\.?|II|III|IV)$/i, '');
  const parts = stripped.split(/\s+/);
  return parts[parts.length - 1] ?? '';
}

function addOneDay(yyyyMmDd: string): string {
  const d = new Date(yyyyMmDd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
