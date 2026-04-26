// ESPN player-id cross-reference. For every attended MLB game we have
// a Mariners-vs-X box score for, hit ESPN's game summary endpoint and
// match each ESPN athlete to a player who appeared in OUR boxscore
// for the same game.
//
// Game-scoped matching is the key insight: any player who appears in
// the ESPN boxscore for game X must also appear in the MLB Stats
// boxscore for the same game (we already have those rows in
// attended_event_players). That eliminates cross-team last-name
// collisions ("Hernandez", "Garcia", "Rodriguez") because the candidate
// pool is just the ~50 players in this one game.
//
// Approach:
//   1. ESPN schedule by team-season → resolve our event_date to
//      ESPN gameId.
//   2. ESPN summary by gameId → list of athletes with ESPN IDs.
//   3. For each athlete, find the matching player in OUR DB whose
//      attended_event_players row points at this event AND whose
//      normalized last_name (and first_name when ambiguous) matches.

import { and, eq, isNotNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  attendedEventPlayers,
  attendedEvents,
  players,
} from '../../db/schema/attending.js';

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
    const matched = await matchAndPersistEspnIds(db, summary, ev.id);
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
 * Match each ESPN athlete to a player who appeared in OUR boxscore
 * for the same event. Game-scoping is the trick: instead of searching
 * all 800+ players for a last-name match, we restrict to the ~50 who
 * played this specific game. That eliminates cross-team collisions on
 * common last names ("Hernandez", "Garcia") cleanly.
 *
 * Match rules (in priority order):
 *   1. Normalized first + last name match (highest confidence).
 *   2. Normalized last name match when there's a single candidate.
 *   3. Disambiguate by jersey if multiple last-name candidates share it.
 *
 * Skips athletes whose target player already has an espn_id set.
 */
async function matchAndPersistEspnIds(
  db: Database,
  summary: EspnSummary,
  eventId: number
): Promise<number> {
  // Pull this game's player roster (everyone who appeared) joined to
  // the players table. This is our candidate pool for ESPN matches.
  const gameRoster = await db
    .select({
      player_id: players.id,
      first_name: players.firstName,
      last_name: players.lastName,
      jersey: players.primaryNumber,
      espn_id: players.espnId,
    })
    .from(attendedEventPlayers)
    .leftJoin(players, eq(players.id, attendedEventPlayers.playerId))
    .where(eq(attendedEventPlayers.eventId, eventId));

  // Index candidates by normalized last name (multimap).
  const byLast = new Map<
    string,
    Array<{
      player_id: number;
      first_name: string | null;
      last_name: string | null;
      jersey: string | null;
      espn_id: string | null;
    }>
  >();
  for (const r of gameRoster) {
    if (!r.player_id || !r.last_name) continue;
    const key = normalize(r.last_name);
    if (!key) continue;
    const list = byLast.get(key) ?? [];
    list.push({
      player_id: r.player_id,
      first_name: r.first_name,
      last_name: r.last_name,
      jersey: r.jersey,
      espn_id: r.espn_id,
    });
    byLast.set(key, list);
  }

  let count = 0;
  const teams = summary.boxscore?.players ?? [];
  for (const teamGroup of teams) {
    for (const grp of teamGroup.statistics ?? []) {
      for (const item of grp.athletes ?? []) {
        const a = item.athlete;
        if (!a?.id) continue;
        const display = a.fullName ?? a.displayName ?? '';
        const lastName = normalize(a.lastName ?? extractLastName(display));
        const firstName = normalize(extractFirstName(display));
        if (!lastName) continue;

        const candidates = (byLast.get(lastName) ?? []).filter(
          (c) => c.espn_id == null
        );
        if (candidates.length === 0) continue;

        let match: (typeof candidates)[number] | null = null;
        if (candidates.length === 1) {
          match = candidates[0];
        } else if (firstName) {
          // Try first-name match within the last-name candidates.
          match =
            candidates.find(
              (c) => c.first_name && normalize(c.first_name) === firstName
            ) ?? null;
        }
        // Final fallback: jersey match if ESPN provided one and we
        // still have ambiguity.
        if (!match && a.jersey) {
          match = candidates.find((c) => c.jersey === a.jersey) ?? null;
        }
        if (!match) continue;

        await db
          .update(players)
          .set({ espnId: a.id, updatedAt: new Date().toISOString() })
          .where(eq(players.id, match.player_id));
        // Mark resolved in our local index so we don't reuse the row.
        match.espn_id = a.id;
        count++;
      }
    }
  }
  return count;
}

function normalize(s: string | null | undefined): string {
  if (!s) return '';
  // Strip accents, lowercase, and collapse whitespace.
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function extractFirstName(fullName: string): string {
  if (!fullName) return '';
  const stripped = fullName.trim().replace(/\s+(Jr\.?|Sr\.?|II|III|IV)$/i, '');
  const parts = stripped.split(/\s+/);
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join(' ');
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
