// Match orchestrator. Takes a raw candidate (calendar event or parsed
// reservation), infers event_type from keywords, resolves the venue,
// and dispatches to the right sports / concert enricher to produce a
// canonical event ready for the loader.
//
// Design: pure async function. Mockable upstream services (MLB, ESPN,
// setlist.fm). Failures during sports/concert enrichment are caught
// and logged — the candidate still flows through with a null
// `external_id` so we keep the event row even when enrichment is flaky.

import type { Database } from '../../db/client.js';
import type { Env } from '../../types/env.js';
import { resolveVenue, resolvePerformer } from './match.js';
import { getMlbGamesByDate, MLB_TEAM_IDS } from '../sports/mlb-client.js';
import {
  ESPN_LEAGUES,
  ESPN_TEAM_IDS,
  getEspnGamesByDate,
  type EspnLeague,
} from '../sports/espn-client.js';
import { searchSetlist } from '../setlist/client.js';
import type { SportsGameMatch } from '../sports/types.js';
import { applyMyTeamPerspective } from '../sports/types.js';

export type EventType =
  | 'mlb_game'
  | 'nfl_game'
  | 'nba_game'
  | 'wnba_game'
  | 'mls_game'
  | 'ncaaf_game'
  | 'ncaab_game'
  | 'concert'
  | 'unknown';

export type EventCategory = 'sports' | 'music' | 'arts' | 'unknown';

export interface CandidateInput {
  source_ref: string;
  source_type: 'gcal' | 'gmail' | 'manual';
  event_date: string | null; // YYYY-MM-DD
  event_datetime: string | null;
  title: string | null;
  location: string | null;
  performers?: string[]; // optional, parsed from email or input
}

export interface CanonicalEvent {
  category: EventCategory;
  event_type: EventType;
  event_date: string;
  event_datetime: string | null;
  title: string;
  subtitle: string | null;
  venue_id: number | null;
  external_id: string | null;
  external_source: string | null;
  event_data: Record<string, unknown>;
  match_confidence: number;
  // Performer rows to attach (concerts only)
  performers: Array<{ performer_id: number; role: string }>;
  // Diagnostic notes
  match_notes: string[];
}

/**
 * Infer event type from a candidate's title + location. Sports first
 * (most specific), then a music/arts fallback.
 */
export function inferEventType(
  title: string | null,
  location: string | null
): { event_type: EventType; category: EventCategory } {
  const t = (title ?? '').toLowerCase();
  const l = (location ?? '').toLowerCase();
  const both = `${t} ${l}`;

  // Sports leagues by team keyword. Order matters when multiple teams
  // share a venue — but team names are unique so we can scan freely.
  if (/\bmariners\b/.test(both)) {
    return { event_type: 'mlb_game', category: 'sports' };
  }
  if (/\bseahawks\b/.test(both)) {
    return { event_type: 'nfl_game', category: 'sports' };
  }
  if (/\bstorm\b/.test(both)) {
    return { event_type: 'wnba_game', category: 'sports' };
  }
  if (/\bsounders\b/.test(both)) {
    return { event_type: 'mls_game', category: 'sports' };
  }
  if (
    /\bhusk(y|ies)\b/.test(both) ||
    /\buw\s+football\b/.test(both) ||
    /\buw\s+basketball\b/.test(both) ||
    /\bwashington\s+huskies\b/.test(both)
  ) {
    // Football-vs-basketball disambiguation by venue.
    if (
      /\bhusky stadium\b/.test(both) ||
      /\balaska airlines field\b/.test(both)
    ) {
      return { event_type: 'ncaaf_game', category: 'sports' };
    }
    if (/\balaska airlines arena\b/.test(both) || /\bhec ed/.test(both)) {
      return { event_type: 'ncaab_game', category: 'sports' };
    }
    // No venue hint — default to football per the user's primary
    // attendance pattern.
    return { event_type: 'ncaaf_game', category: 'sports' };
  }

  // Music / arts default. Concert-style venues + the absence of a
  // sports keyword is the strongest signal.
  return { event_type: 'concert', category: 'music' };
}

/**
 * Map sports event_type → ESPN league config (or 'mlb' sentinel).
 */
function leagueForEspn(eventType: EventType): EspnLeague | null {
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
 * Map (event_type, venue) → user's team id for the candidate. Used to
 * pick the right team to query MLB/ESPN with, and to derive
 * my_team_won. For now, the user's only team per league is hard-coded
 * — works for Seattle teams + UW.
 */
function userTeamId(
  eventType: EventType
): { id: number; isMlb: boolean } | null {
  switch (eventType) {
    case 'mlb_game':
      return { id: MLB_TEAM_IDS.mariners, isMlb: true };
    case 'nfl_game':
      return { id: ESPN_TEAM_IDS.seahawks, isMlb: false };
    case 'wnba_game':
      return { id: ESPN_TEAM_IDS.storm, isMlb: false };
    case 'mls_game':
      return { id: ESPN_TEAM_IDS.sounders, isMlb: false };
    case 'ncaaf_game':
    case 'ncaab_game':
      return { id: ESPN_TEAM_IDS.uw_huskies, isMlb: false };
    default:
      return null;
  }
}

/**
 * Look up a sports game by date + user's team. Picks the (rare) home
 * vs. away ambiguity by matching venue when multiple games returned.
 */
async function enrichSports(
  eventType: EventType,
  date: string,
  venueId: number | null,
  notes: string[]
): Promise<{
  match: SportsGameMatch | null;
  myTeamSide: 'home' | 'away' | null;
}> {
  const team = userTeamId(eventType);
  if (!team) return { match: null, myTeamSide: null };

  let games: SportsGameMatch[];
  try {
    if (team.isMlb) {
      games = await getMlbGamesByDate(date, team.id);
    } else {
      const league = leagueForEspn(eventType);
      if (!league) return { match: null, myTeamSide: null };
      games = await getEspnGamesByDate(league, date, team.id);
    }
  } catch (err) {
    notes.push(
      `sports lookup failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return { match: null, myTeamSide: null };
  }

  if (games.length === 0) {
    notes.push('no sports game found for date+team');
    return { match: null, myTeamSide: null };
  }

  // For doubleheaders / multiple matches, we'd disambiguate by venue
  // (home stadium == home game). With venueId unknown or single result,
  // pick the first.
  const game = games[0];
  const myTeamSide: 'home' | 'away' =
    game.home_team.id === team.id ? 'home' : 'away';

  void venueId; // reserved for future doubleheader disambiguation
  return { match: game, myTeamSide };
}

async function enrichConcert(
  title: string,
  date: string,
  performersList: string[] | undefined,
  env: Env,
  db: Database,
  notes: string[]
): Promise<{
  setlist: Awaited<ReturnType<typeof searchSetlist>>;
  performerIds: Array<{ performer_id: number; role: string }>;
}> {
  // Performer name from explicit list, or fall back to the title with
  // common venue-pattern stripped ("X at Showbox" → "X").
  const headlinerNames =
    performersList && performersList.length > 0
      ? performersList
      : [stripVenueSuffix(title)];

  const performerIds: Array<{ performer_id: number; role: string }> = [];
  for (let i = 0; i < headlinerNames.length; i++) {
    const name = headlinerNames[i].trim();
    if (!name) continue;
    try {
      const p = await resolvePerformer(name, null, db);
      performerIds.push({
        performer_id: p.performer_id,
        role: i === 0 ? 'headliner' : 'support',
      });
    } catch (err) {
      notes.push(
        `performer resolve failed for "${name}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  // setlist.fm enrichment. Skip silently if no API key.
  let setlist: Awaited<ReturnType<typeof searchSetlist>> = null;
  try {
    setlist = await searchSetlist(env.SETLIST_FM_API_KEY, {
      artistName: headlinerNames[0],
      date,
    });
    if (!setlist) notes.push('no setlist.fm match');
  } catch (err) {
    notes.push(
      `setlist.fm lookup failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return { setlist, performerIds };
}

/**
 * Strip ` at <Venue>` / ` @ <Venue>` from the end of a title to get a
 * cleaner artist name. "Phoebe Bridgers at Climate Pledge Arena" →
 * "Phoebe Bridgers".
 */
export function stripVenueSuffix(title: string): string {
  return title
    .replace(/\s+(?:at|@)\s+.*$/i, '')
    .replace(/\s+-\s+.*$/i, '')
    .trim();
}

/**
 * Top-level orchestrator. Takes a raw candidate, returns a fully
 * enriched CanonicalEvent.
 */
export async function enrichCandidate(
  input: CandidateInput,
  db: Database,
  env: Env
): Promise<CanonicalEvent | null> {
  if (!input.event_date) {
    return null;
  }
  const notes: string[] = [];

  const { event_type, category } = inferEventType(input.title, input.location);

  // Venue resolution
  let venueId: number | null = null;
  let venueConfidence = 1.0;
  if (input.location) {
    try {
      const v = await resolveVenue(input.location, db);
      venueId = v.venue_id;
      venueConfidence = v.confidence;
    } catch (err) {
      notes.push(
        `venue resolve failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    notes.push('no location provided');
  }

  let externalId: string | null = null;
  let externalSource: string | null = null;
  let eventData: Record<string, unknown> = {};
  let confidence = venueConfidence;
  const attachedPerformers: Array<{ performer_id: number; role: string }> = [];

  if (category === 'sports') {
    const { match, myTeamSide } = await enrichSports(
      event_type,
      input.event_date,
      venueId,
      notes
    );
    if (match && myTeamSide) {
      externalId = match.external_id;
      externalSource = match.external_source;
      const perspective = applyMyTeamPerspective(match, myTeamSide);
      eventData = {
        league: match.league,
        season: match.season,
        game_type: match.game_type,
        home_team: match.home_team,
        away_team: match.away_team,
        home_score: match.home_score,
        away_score: match.away_score,
        ...perspective,
      };
    } else {
      // Sports event with no match — keep low confidence so review
      // surfaces it.
      confidence = Math.min(confidence, 0.4);
    }
  } else if (event_type === 'concert') {
    const { setlist, performerIds } = await enrichConcert(
      input.title ?? '',
      input.event_date,
      input.performers,
      env,
      db,
      notes
    );
    attachedPerformers.push(...performerIds);
    if (setlist) {
      externalId = setlist.setlist_id;
      externalSource = 'setlist_fm';
      eventData = {
        setlist_url: setlist.setlist_url,
        artist_name: setlist.artist_name,
        artist_mbid: setlist.artist_mbid,
        tour_name: setlist.tour_name,
      };
    }
  }

  return {
    category,
    event_type,
    event_date: input.event_date,
    event_datetime: input.event_datetime,
    title: input.title ?? '(untitled)',
    subtitle: null,
    venue_id: venueId,
    external_id: externalId,
    external_source: externalSource,
    event_data: eventData,
    match_confidence: confidence,
    performers: attachedPerformers,
    match_notes: notes,
  };
}
