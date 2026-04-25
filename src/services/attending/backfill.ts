import type { Database } from '../../db/client.js';
import type { Env } from '../../types/env.js';
import {
  extractCalendarCandidates,
  extractGmailCandidates,
  type CandidateCalendarEvent,
  type ParsedGmailCandidate,
} from './extract.js';
import { enrichCandidate, type CanonicalEvent } from './enrich.js';
import { loadCanonicalEvent } from './load.js';
import { parseCalendarDescriptionTickets } from './parse-calendar-description.js';
import type { ParsedReservation } from './parse-jsonld.js';

// Backfill pipeline. Five stages, each idempotent:
//
//   1. extract  — pull candidate rows from sources (calendar + gmail).
//                 Phase 2 implements gcal; Phase 3 adds gmail.
//   2. parse    — per-vendor email parsers + calendar parser produce a
//                 common CandidateEvent shape. Phase 3.
//   3. match    — venue resolver, sports stats lookup (MLB/ESPN), concert
//                 setlist lookup. Phase 4.
//   4. dedupe   — collapse candidates by (user_id, event_date, venue_id).
//                 Phase 5.
//   5. load     — upsert attended_events / tickets / performers / sources
//                 in a transaction. Phase 5.

export interface BackfillResult {
  candidates_found: number;
  events_loaded: number;
  sources: {
    gcal: number;
    gmail: number;
  };
  dry_run: boolean;
  // Phase-2-specific extras (will be merged into a richer envelope later):
  gcal?: {
    scanned: number;
    matched: number;
    inserted: number;
    candidates?: CandidateCalendarEvent[];
    resynced_from_expiry?: boolean;
  };
  // Phase-3 extras
  gmail?: {
    scanned: number;
    fetched: number;
    parsed: number;
    inserted: number;
    skipped_subject: number;
    skipped_no_jsonld: number;
    candidates?: ParsedGmailCandidate[];
  };
  // Phase-4 extras (only present in dry-run; enrichment doesn't write)
  enriched?: CanonicalEvent[];
  // Phase-5 extras (non-dry-run pipeline metrics)
  load?: {
    enriched: number;
    inserted: number;
    updated: number;
    failed: number;
    ticket_inserts: number;
    performer_inserts: number;
  };
}

export interface BackfillOptions {
  source?: 'gcal' | 'gmail' | 'all';
  dry_run?: boolean;
  // Range pull window. Required when source='gcal' AND no syncToken exists
  // yet (first run); optional otherwise — passing them forces a range pull
  // even when a syncToken is stored. For incremental cron runs, leave both
  // unset.
  from?: string; // ISO 8601 timeMin
  to?: string; // ISO 8601 timeMax
  // 'incremental' uses the stored syncToken (cron path).
  // 'range' ignores stored syncToken and uses from/to (backfill).
  // Auto-derived when not set: 'range' if from is provided, else 'incremental'.
  mode?: 'incremental' | 'range';
}

export async function backfillAttending(
  db: Database,
  env: Env,
  options: BackfillOptions = {}
): Promise<BackfillResult> {
  const {
    source = 'all',
    dry_run = false,
    from,
    to,
    mode = from ? 'range' : 'incremental',
  } = options;

  console.log(
    `[SYNC] attending backfill source=${source} mode=${mode} dry_run=${dry_run}`
  );

  const result: BackfillResult = {
    candidates_found: 0,
    events_loaded: 0,
    sources: { gcal: 0, gmail: 0 },
    dry_run,
  };

  // Internal candidate buffers — used by Phase 5 load. The API response
  // only echoes them on dry-run (see end of function).
  let gcalCandidates: CandidateCalendarEvent[] = [];
  let gmailCandidates: ParsedGmailCandidate[] = [];

  if (source === 'gcal' || source === 'all') {
    const gcal = await extractCalendarCandidates(db, env, {
      timeMin: from,
      timeMax: to,
      mode,
      dryRun: dry_run,
    });
    gcalCandidates = gcal.candidates;
    result.gcal = {
      scanned: gcal.scanned,
      matched: gcal.matched,
      inserted: gcal.inserted,
      candidates: dry_run ? gcal.candidates : undefined,
      resynced_from_expiry: gcal.resyncedFromExpiry,
    };
    result.sources.gcal = gcal.matched;
    result.candidates_found += gcal.matched;
  }

  // For dry-run only: also run enrichment over the candidates we found,
  // so the response shows the canonical-event preview. Skipped on
  // non-dry-run because Phase 5 (load) does its own enrich+dedupe pass.
  const enrichedPreview: CanonicalEvent[] = [];
  if (dry_run && source === 'gcal' && gcalCandidates.length > 0) {
    for (const c of gcalCandidates.slice(0, 20)) {
      try {
        const enriched = await enrichCandidate(
          {
            source_ref: c.source_ref,
            source_type: 'gcal',
            event_date: c.event_date,
            event_datetime: c.event_datetime,
            title: c.summary,
            location: c.location,
          },
          db,
          env
        );
        if (enriched) enrichedPreview.push(enriched);
      } catch (err) {
        console.log(
          `[ERROR] enrich preview failed for ${c.source_ref}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (enrichedPreview.length > 0) {
      result.enriched = enrichedPreview;
    }
  }

  if (source === 'gmail' || source === 'all') {
    const gmail = await extractGmailCandidates(db, env, {
      newerThanDate: from ? from.slice(0, 10) : undefined,
      olderThanDate: to ? to.slice(0, 10) : undefined,
      newerThanDays: mode === 'incremental' && !from && !to ? 2 : undefined,
      dryRun: dry_run,
    });
    gmailCandidates = gmail.candidates;
    result.gmail = {
      scanned: gmail.scanned,
      fetched: gmail.fetched,
      parsed: gmail.parsed,
      inserted: gmail.inserted,
      skipped_subject: gmail.skipped_subject,
      skipped_no_jsonld: gmail.skipped_no_jsonld,
      candidates: dry_run ? gmail.candidates : undefined,
    };
    result.sources.gmail = gmail.parsed;
    result.candidates_found += gmail.parsed;
  }

  // Phase 5: enrich + dedupe + load. Skipped on dry-run (the
  // dry-run preview above handles inspection).
  if (!dry_run) {
    const loadStats = {
      enriched: 0,
      inserted: 0,
      updated: 0,
      failed: 0,
      ticket_inserts: 0,
      performer_inserts: 0,
    };

    // Calendar candidates → enrich → load
    for (const c of gcalCandidates) {
      try {
        const stats = await enrichAndLoadCalendarCandidate(c, db, env);
        mergeLoadStats(loadStats, stats);
      } catch (err) {
        loadStats.failed++;
        console.log(
          `[ERROR] load failed for gcal ${c.source_ref}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Gmail candidates → enrich → load
    for (const c of gmailCandidates) {
      try {
        const stats = await enrichAndLoadGmailCandidate(c, db, env);
        if (stats) mergeLoadStats(loadStats, stats);
      } catch (err) {
        loadStats.failed++;
        console.log(
          `[ERROR] load failed for gmail ${c.source_ref}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    result.load = loadStats;
    result.events_loaded = loadStats.inserted;
  }

  return result;
}

// ─── Per-candidate enrich + load helpers ────────────────────────────

interface InnerLoadStats {
  enriched: number;
  inserted: number;
  updated: number;
  ticket_inserts: number;
  performer_inserts: number;
}

function mergeLoadStats(
  agg: BackfillResult['load'] & object,
  add: InnerLoadStats
): void {
  agg.enriched += add.enriched;
  agg.inserted += add.inserted;
  agg.updated += add.updated;
  agg.ticket_inserts += add.ticket_inserts;
  agg.performer_inserts += add.performer_inserts;
}

async function enrichAndLoadCalendarCandidate(
  c: CandidateCalendarEvent,
  db: Database,
  env: Env
): Promise<InnerLoadStats> {
  const stats: InnerLoadStats = {
    enriched: 0,
    inserted: 0,
    updated: 0,
    ticket_inserts: 0,
    performer_inserts: 0,
  };

  const enriched = await enrichCandidate(
    {
      source_ref: c.source_ref,
      source_type: 'gcal',
      event_date: c.event_date,
      event_datetime: c.event_datetime,
      title: c.summary,
      location: c.location,
    },
    db,
    env
  );
  if (!enriched) return stats;
  stats.enriched = 1;

  // Tier-0 tickets: extract from calendar event description (the
  // SeatGeek-in-calendar pattern from Phase 2). The raw_data on the
  // source row holds the full Calendar event payload.
  let tickets: ParsedReservation[] = [];
  // We don't have the raw_data here in the candidate (only summary +
  // location were lifted). Skip calendar-description ticket extraction
  // for now — covered when source rows are re-processed from D1.
  // TODO Phase 7 review surface: add a re-process path that pulls
  // raw_data and runs parseCalendarDescriptionTickets.
  void parseCalendarDescriptionTickets; // silence unused-import lint
  void tickets;
  tickets = [];

  const result = await loadCanonicalEvent(
    enriched,
    tickets,
    [{ source_type: 'gcal', source_ref: c.source_ref }],
    db
  );
  if (result.action === 'inserted') stats.inserted = 1;
  else if (result.action === 'updated') stats.updated = 1;
  stats.ticket_inserts = result.ticket_inserts;
  stats.performer_inserts = result.performer_inserts;
  return stats;
}

async function enrichAndLoadGmailCandidate(
  c: ParsedGmailCandidate,
  db: Database,
  env: Env
): Promise<InnerLoadStats | null> {
  const stats: InnerLoadStats = {
    enriched: 0,
    inserted: 0,
    updated: 0,
    ticket_inserts: 0,
    performer_inserts: 0,
  };

  // Pick the first parsed reservation as the candidate's basis. If
  // there's no reservation (parser couldn't extract), skip — we don't
  // know what the event is, so nothing to enrich/load. Source row
  // remains in attended_event_sources with reservations=[] for future
  // re-processing.
  const firstRes = c.reservations[0];
  if (!firstRes) return null;

  // event_date from event_start (ISO 8601 → YYYY-MM-DD). If event_start
  // is partial like "MM-DDTHH:MM" (SeatGeek without year), reject —
  // need year. The internal_date can give a fallback year.
  const eventDate = extractDate(firstRes.event_start, c.internal_date);
  if (!eventDate) return null;

  const enriched = await enrichCandidate(
    {
      source_ref: c.source_ref,
      source_type: 'gmail',
      event_date: eventDate,
      event_datetime: firstRes.event_start,
      title: firstRes.event_name,
      location: firstRes.venue_address ?? firstRes.venue_name,
    },
    db,
    env
  );
  if (!enriched) return stats;
  stats.enriched = 1;

  const result = await loadCanonicalEvent(
    enriched,
    c.reservations,
    [{ source_type: 'gmail', source_ref: c.source_ref }],
    db
  );
  if (result.action === 'inserted') stats.inserted = 1;
  else if (result.action === 'updated') stats.updated = 1;
  stats.ticket_inserts = result.ticket_inserts;
  stats.performer_inserts = result.performer_inserts;
  return stats;
}

/**
 * Extract YYYY-MM-DD from an ISO datetime, falling back to the
 * email's internal_date for SeatGeek-style "MM-DDTHH:MM" partials
 * that lack a year. The email arrival year is a near-perfect fallback
 * (confirmations are sent within days of purchase, before the event).
 */
function extractDate(
  eventStart: string | null,
  internalDate: string
): string | null {
  if (!eventStart) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(eventStart)) {
    return eventStart.slice(0, 10);
  }
  if (/^\d{2}-\d{2}T/.test(eventStart)) {
    // SeatGeek partial: graft on the year from email internal_date.
    const fallbackYear = new Date(internalDate).getUTCFullYear();
    if (Number.isFinite(fallbackYear) && fallbackYear > 2000) {
      return `${fallbackYear}-${eventStart.slice(0, 5)}`;
    }
  }
  return null;
}
