import type { Database } from '../../db/client.js';

// Backfill pipeline (TO BE IMPLEMENTED). Five stages, each idempotent:
//
//   1. extract  — pull candidate rows from sources:
//                 - Google Calendar API: events whose summary or location
//                   matches the team/venue allowlist (Mariners, Seahawks,
//                   Storm, Sounders, T-Mobile Park, Climate Pledge Arena,
//                   Lumen Field, Safeco Field, ...).
//                 - Gmail: messages from ticketmaster.com, seatgeek.com,
//                   ticketclub.com, axs.com, stubhub.com, vivid* with
//                   subject ~ 'order confirmation' | 'your tickets'.
//                 - Each candidate writes a row to attended_event_sources
//                   with raw_data JSON.
//
//   2. parse    — per-vendor email parsers + calendar event parser
//                 produce a common CandidateEvent shape:
//                   { event_date, event_datetime?, venue_guess,
//                     teams_or_performers, vendor?, order_id?, price?,
//                     section?, row?, seat?, quantity? }
//
//   3. match    — resolve to a canonical event:
//                 - sports: hit MLB Stats API / ESPN by date + home venue
//                   to confirm the game existed; pull external_id, scores,
//                   opponent, season → eventData JSON.
//                 - concerts: setlist.fm by performer + date for setlist_fm_id.
//                 - venue name → venues row (alias-aware: Safeco→T-Mobile Park).
//                 - performer name → performers row, optionally linked to
//                   lastfm_artists by mbid or normalized name.
//
//   4. dedupe   — collapse by (user_id, event_date, venue_id). One event
//                 per venue per day. Multiple candidates merge into one
//                 attended_events row + multiple attended_event_sources
//                 + (potentially) multiple attended_event_tickets.
//
//   5. load     — upsert attended_events by (external_source, external_id)
//                 when present, else by the dedupe key. Insert tickets
//                 and source-trace rows. Set attended=1 by default; the
//                 user can flip to 0 manually for tickets they didn't use.

export interface BackfillResult {
  candidates_found: number;
  events_loaded: number;
  sources: {
    gcal: number;
    gmail: number;
  };
  dry_run: boolean;
}

export interface BackfillOptions {
  source?: 'gcal' | 'gmail' | 'all';
  dry_run?: boolean;
  from?: string;
  to?: string;
}

export async function backfillAttending(
  _db: Database,
  options: BackfillOptions = {}
): Promise<BackfillResult> {
  const { source = 'all', dry_run = false } = options;

  // Stub: real implementation lives in follow-up tasks for the gcal +
  // per-vendor email parsers. Returns the shape callers should expect.
  console.log(
    `[SYNC] attending backfill stub invoked (source=${source}, dry_run=${dry_run})`
  );

  return {
    candidates_found: 0,
    events_loaded: 0,
    sources: { gcal: 0, gmail: 0 },
    dry_run,
  };
}
