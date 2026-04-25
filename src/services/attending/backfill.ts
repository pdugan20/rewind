import type { Database } from '../../db/client.js';
import type { Env } from '../../types/env.js';
import {
  extractCalendarCandidates,
  extractGmailCandidates,
  type CandidateCalendarEvent,
  type ParsedGmailCandidate,
} from './extract.js';

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

  if (source === 'gcal' || source === 'all') {
    const gcal = await extractCalendarCandidates(db, env, {
      timeMin: from,
      timeMax: to,
      mode,
      dryRun: dry_run,
    });
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

  if (source === 'gmail' || source === 'all') {
    const gmail = await extractGmailCandidates(db, env, {
      newerThanDate: from ? from.slice(0, 10) : undefined,
      olderThanDate: to ? to.slice(0, 10) : undefined,
      newerThanDays: mode === 'incremental' && !from && !to ? 2 : undefined,
      dryRun: dry_run,
    });
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

  return result;
}
