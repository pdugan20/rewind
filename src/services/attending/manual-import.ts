// Manual-entry import for the attending domain.
//
// Two input shapes, both go through the same load path:
//
//   1. Per-game (used for UW football 2007–2010, sourced from Wikipedia):
//        { event_date, event_type, team_id, opponent, is_home, notes? }
//
//   2. Season shorthand (used for UW football 2021–2026 friend's season
//      tickets — "I went to every home game"):
//        { event_type, team_id, season, attendance: 'all_home',
//          exceptions?: [date, ...] }
//
//      Expands server-side: hits ESPN/MLB for the full season, filters
//      to home games, sets attended=1 by default. Dates listed in
//      `exceptions` get attended=0 (games user actually missed).
//
// The endpoint accepts an array of mixed shapes. Each entry is loaded
// independently; failures don't kill the batch.

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { Env } from '../../types/env.js';
import { attendedEvents } from '../../db/schema/attending.js';
import { resolveVenue } from './match.js';
import { applyMyTeamPerspective } from '../sports/types.js';
import {
  getEspnTeamSchedule,
  ESPN_LEAGUES,
  type EspnLeague,
} from '../sports/espn-client.js';
import { getMlbGamesByDate } from '../sports/mlb-client.js';
import type { SportsGameMatch } from '../sports/types.js';

export type EventTypeCode =
  | 'mlb_game'
  | 'nfl_game'
  | 'nba_game'
  | 'wnba_game'
  | 'mls_game'
  | 'ncaaf_game'
  | 'ncaab_game';

export interface ManualPerGame {
  event_date: string; // YYYY-MM-DD
  event_type: EventTypeCode;
  team_id: number;
  opponent?: string;
  is_home?: boolean;
  notes?: string;
  attended?: 0 | 1; // default 1
}

export interface ManualSeasonShorthand {
  event_type: EventTypeCode;
  team_id: number;
  season: number;
  attendance: 'all_home';
  exceptions?: string[]; // YYYY-MM-DD dates the user did NOT attend
}

export type ManualEntry = ManualPerGame | ManualSeasonShorthand;

export interface ManualImportResult {
  loaded: number;
  inserted: number;
  updated: number;
  skipped_attended_zero: number;
  unmatched: Array<{ entry: ManualEntry; reason: string }>;
}

export async function importManualAttending(
  db: Database,
  env: Env,
  entries: ManualEntry[]
): Promise<ManualImportResult> {
  const result: ManualImportResult = {
    loaded: 0,
    inserted: 0,
    updated: 0,
    skipped_attended_zero: 0,
    unmatched: [],
  };

  for (const entry of entries) {
    try {
      if ('attendance' in entry && entry.attendance === 'all_home') {
        await processSeasonShorthand(entry, db, result);
      } else if ('event_date' in entry) {
        await processPerGame(entry, db, result);
      } else {
        result.unmatched.push({ entry, reason: 'unrecognized entry shape' });
      }
    } catch (err) {
      result.unmatched.push({
        entry,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  void env; // env reserved for future setlist.fm-side concert imports
  return result;
}

async function processPerGame(
  entry: ManualPerGame,
  db: Database,
  result: ManualImportResult
): Promise<void> {
  const game = await fetchGame(
    entry.event_type,
    entry.event_date,
    entry.team_id
  );
  if (!game) {
    result.unmatched.push({
      entry,
      reason: `no game found for ${entry.event_type} on ${entry.event_date} for team ${entry.team_id}`,
    });
    return;
  }
  await loadGameAsAttendedEvent(
    db,
    game,
    entry.team_id,
    entry.attended ?? 1,
    entry.notes ?? null,
    result
  );
}

async function processSeasonShorthand(
  entry: ManualSeasonShorthand,
  db: Database,
  result: ManualImportResult
): Promise<void> {
  const league = leagueForType(entry.event_type);
  if (!league) {
    result.unmatched.push({
      entry,
      reason: `season shorthand only supported for ESPN-backed leagues; got ${entry.event_type}`,
    });
    return;
  }

  const games = await getEspnTeamSchedule(league, entry.team_id, entry.season, {
    homeOnly: true,
  });
  const exceptions = new Set(entry.exceptions ?? []);

  for (const game of games) {
    const attended = exceptions.has(game.game_date) ? 0 : 1;
    await loadGameAsAttendedEvent(
      db,
      game,
      entry.team_id,
      attended,
      null,
      result
    );
  }
}

async function fetchGame(
  eventType: EventTypeCode,
  date: string,
  teamId: number
): Promise<SportsGameMatch | null> {
  if (eventType === 'mlb_game') {
    const games = await getMlbGamesByDate(date, teamId);
    return games[0] ?? null;
  }
  const league = leagueForType(eventType);
  if (!league) return null;
  // ESPN doesn't have a single-game endpoint — use the team-schedule
  // for the season and find the matching date. ESPN's ev.date is UTC,
  // so a 7pm Pacific game stamps as the next day's date in UTC. To
  // match against the user-supplied venue-local date, accept the date
  // OR the date+1.
  const season = parseInt(date.slice(0, 4), 10);
  const games = await getEspnTeamSchedule(league, teamId, season);
  const datePlus1 = addDays(date, 1);
  return (
    games.find((g) => g.game_date === date || g.game_date === datePlus1) ?? null
  );
}

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function leagueForType(eventType: EventTypeCode): EspnLeague | null {
  switch (eventType) {
    case 'nfl_game':
      return ESPN_LEAGUES.nfl;
    case 'nba_game':
      return ESPN_LEAGUES.nba;
    case 'wnba_game':
      return ESPN_LEAGUES.wnba;
    case 'mls_game':
      return ESPN_LEAGUES.mls;
    case 'ncaaf_game':
      return ESPN_LEAGUES.ncaaf;
    case 'ncaab_game':
      return ESPN_LEAGUES.ncaab;
    default:
      return null;
  }
}

/**
 * Insert (or update) an attended_events row from a fetched SportsGameMatch.
 * Mirrors loadCanonicalEvent's logic but tailored to the manual-import
 * shape — no source rows, no tickets, no performers, just the event and
 * its event_data.
 */
async function loadGameAsAttendedEvent(
  db: Database,
  game: SportsGameMatch,
  myTeamId: number,
  attended: 0 | 1,
  notes: string | null,
  result: ManualImportResult
): Promise<void> {
  // Resolve venue if it's a home game (we have it seeded). Away games:
  // venue isn't auto-creatable from the game record, leave null.
  const myTeamSide: 'home' | 'away' =
    game.home_team.id === myTeamId ? 'home' : 'away';
  let venueId: number | null = null;
  if (myTeamSide === 'home') {
    const venueName = guessHomeVenue(game.league, myTeamId);
    if (venueName) {
      try {
        const v = await resolveVenue(venueName, db);
        venueId = v.venue_id;
      } catch {
        venueId = null;
      }
    }
  }

  const now = new Date().toISOString();
  const eventType = game.league + '_game';
  const perspective = applyMyTeamPerspective(game, myTeamSide);
  const eventData = {
    league: game.league,
    season: game.season,
    game_type: game.game_type,
    home_team: game.home_team,
    away_team: game.away_team,
    home_score: game.home_score,
    away_score: game.away_score,
    ...perspective,
  };
  const title = `${game.away_team.name} at ${game.home_team.name}`;

  // Pre-check for an existing row so we can report inserted-vs-updated
  // accurately. (D1's RETURNING on UPDATE-on-conflict is unreliable.)
  const [existing] = await db
    .select({ id: attendedEvents.id })
    .from(attendedEvents)
    .where(
      and(
        eq(attendedEvents.userId, 1),
        eq(attendedEvents.externalSource, game.external_source),
        eq(attendedEvents.externalId, game.external_id)
      )
    )
    .limit(1);

  // Upsert by (external_source, external_id) — same dedupe key as the
  // loader uses, so manual imports merge with cron-loaded events for
  // the same game.
  const upsertResult = await db
    .insert(attendedEvents)
    .values({
      userId: 1,
      category: 'sports',
      eventType,
      eventDate: game.game_date,
      eventDatetime: game.game_datetime_utc,
      venueId,
      title,
      subtitle: null,
      externalId: game.external_id,
      externalSource: game.external_source,
      eventData: JSON.stringify(eventData),
      attended,
      notes,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [attendedEvents.externalSource, attendedEvents.externalId],
      set: {
        // Manual import is high-confidence — overwrite venue + scores
        // when they're newer/better. attended flag is overwritten too
        // (so re-running the season shorthand with a different
        // exceptions list converges).
        venueId: sql`coalesce(${venueId}, ${attendedEvents.venueId})`,
        eventData: JSON.stringify(eventData),
        attended,
        notes: sql`coalesce(${notes}, ${attendedEvents.notes})`,
        updatedAt: now,
      },
    })
    .returning({ id: attendedEvents.id });

  result.loaded++;
  if (existing) result.updated++;
  else result.inserted++;
  if (attended === 0) result.skipped_attended_zero++;
  void upsertResult; // returned in case caller needs the new id; unused here
}

/**
 * Best-effort home-venue lookup keyed off the user's team. For now the
 * Seattle teams + UW; extend as needed. Used to populate venue_id on
 * manual-import home games — the loader's venue resolver works on
 * names, so we just need to provide the right one.
 */
function guessHomeVenue(league: string, teamId: number): string | null {
  const HOME_VENUES: Record<string, string> = {
    'mlb:136': 'T-Mobile Park', // Mariners
    'nfl:26': 'Lumen Field', // Seahawks
    'wnba:14': 'Climate Pledge Arena', // Storm
    'mls:9726': 'Lumen Field', // Sounders
    'ncaaf:264': 'Husky Stadium', // UW Huskies football
    'ncaab:264': 'Alaska Airlines Arena', // UW Huskies basketball
  };
  return HOME_VENUES[`${league}:${teamId}`] ?? null;
}
