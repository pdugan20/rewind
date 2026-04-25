import type { Database } from '../../db/client.js';
import type { Env } from '../../types/env.js';
import { attendedEventSources } from '../../db/schema/attending.js';
import { getGoogleAccessToken } from '../google/auth.js';
import {
  listCalendarEvents,
  CalendarSyncTokenExpiredError,
  type CalendarEvent,
} from '../google/calendar-client.js';
import {
  readCalendarSyncToken,
  writeCalendarSyncToken,
} from '../google/calendar-sync-token.js';
import { matchesAllowlist } from './allowlist.js';

export interface ExtractCalendarOptions {
  // Range pull window. Used for backfill, or for the initial pull before
  // a syncToken exists.
  timeMin?: string; // ISO 8601
  timeMax?: string; // ISO 8601
  // 'incremental' uses the stored syncToken (cron path).
  // 'range' ignores the stored syncToken and pulls by timeMin/timeMax (backfill).
  mode?: 'incremental' | 'range';
  // Don't write to attended_event_sources, just return the candidate list.
  dryRun?: boolean;
}

export interface ExtractCalendarResult {
  scanned: number;
  matched: number;
  inserted: number;
  candidates: CandidateCalendarEvent[];
  syncToken?: string;
  resyncedFromExpiry?: boolean;
}

export interface CandidateCalendarEvent {
  source_ref: string;
  event_date: string | null; // YYYY-MM-DD (start.date or start.dateTime → date)
  event_datetime: string | null; // ISO 8601 with offset, when known
  summary: string | null;
  location: string | null;
  status: string | null;
  html_link: string | null;
}

/**
 * Pull Calendar events from Google, filter by allowlist, write candidates
 * to `attended_event_sources` for the parse/match steps.
 *
 * Idempotent: re-runs that see the same calendar event id will hit the
 * UNIQUE (source_type, source_ref) index and DO NOTHING.
 *
 * Modes:
 *   - 'incremental' (default): use stored syncToken; on 410 expiry, fall
 *     back to a 90-day range pull and refresh the token.
 *   - 'range': pull by timeMin/timeMax; do not consume or update the
 *     stored syncToken.
 */
export async function extractCalendarCandidates(
  db: Database,
  env: Env,
  opts: ExtractCalendarOptions = {}
): Promise<ExtractCalendarResult> {
  const mode = opts.mode ?? 'incremental';
  const dryRun = opts.dryRun ?? false;

  const accessToken = await getGoogleAccessToken(db, env);

  let storedToken: string | null = null;
  if (mode === 'incremental') {
    storedToken = await readCalendarSyncToken(db);
  }

  const events: CalendarEvent[] = [];
  let nextSyncToken: string | undefined;
  let resyncedFromExpiry = false;

  try {
    nextSyncToken = await drainEvents(
      accessToken,
      storedToken
        ? { syncToken: storedToken }
        : { timeMin: opts.timeMin, timeMax: opts.timeMax },
      events
    );
  } catch (err) {
    if (err instanceof CalendarSyncTokenExpiredError) {
      // Token expired — drop it and re-pull a 90-day window so the cron
      // self-heals without manual intervention.
      console.log(
        '[INFO] Calendar syncToken expired; falling back to range pull'
      );
      events.length = 0;
      const now = new Date();
      const fallbackTimeMin = new Date(
        now.getTime() - 90 * 24 * 60 * 60 * 1000
      ).toISOString();
      const fallbackTimeMax = new Date(
        now.getTime() + 30 * 24 * 60 * 60 * 1000
      ).toISOString();
      nextSyncToken = await drainEvents(
        accessToken,
        { timeMin: fallbackTimeMin, timeMax: fallbackTimeMax },
        events
      );
      resyncedFromExpiry = true;
    } else {
      throw err;
    }
  }

  const candidates: CandidateCalendarEvent[] = [];
  for (const ev of events) {
    if (!ev.id) continue;
    if (!matchesAllowlist(ev.summary, ev.location)) continue;
    if (ev.status === 'cancelled') continue;
    candidates.push(toCandidate(ev));
  }

  let inserted = 0;
  if (!dryRun && candidates.length > 0) {
    inserted = await insertSourceRows(db, events, candidates);
  }

  // Persist the new syncToken (only on incremental success or expiry recovery).
  if (!dryRun && (mode === 'incremental' || resyncedFromExpiry)) {
    if (nextSyncToken) {
      await writeCalendarSyncToken(db, nextSyncToken);
    }
  }

  return {
    scanned: events.length,
    matched: candidates.length,
    inserted,
    candidates,
    syncToken: nextSyncToken,
    resyncedFromExpiry,
  };
}

async function drainEvents(
  accessToken: string,
  baseOpts: { syncToken: string } | { timeMin?: string; timeMax?: string },
  out: CalendarEvent[]
): Promise<string | undefined> {
  let pageToken: string | undefined;
  let lastSyncToken: string | undefined;
  do {
    const page = await listCalendarEvents(accessToken, {
      ...baseOpts,
      pageToken,
    });
    out.push(...page.events);
    pageToken = page.nextPageToken;
    if (page.nextSyncToken) lastSyncToken = page.nextSyncToken;
  } while (pageToken);
  return lastSyncToken;
}

function toCandidate(ev: CalendarEvent): CandidateCalendarEvent {
  // Prefer dateTime over date; for date-only entries we get just YYYY-MM-DD.
  const startDateTime = ev.start.dateTime ?? null;
  const eventDate =
    ev.start.date ?? (startDateTime ? startDateTime.slice(0, 10) : null);

  return {
    source_ref: ev.id,
    event_date: eventDate,
    event_datetime: startDateTime,
    summary: ev.summary,
    location: ev.location,
    status: ev.status,
    html_link: ev.htmlLink,
  };
}

async function insertSourceRows(
  db: Database,
  events: CalendarEvent[],
  candidates: CandidateCalendarEvent[]
): Promise<number> {
  const eventById = new Map(events.map((e) => [e.id, e]));
  let inserted = 0;
  for (const c of candidates) {
    const raw = eventById.get(c.source_ref);
    if (!raw) continue;
    const result = await db
      .insert(attendedEventSources)
      .values({
        userId: 1,
        sourceType: 'gcal',
        sourceRef: c.source_ref,
        rawData: JSON.stringify(raw),
        matchConfidence: 1.0,
      })
      .onConflictDoNothing({
        target: [
          attendedEventSources.sourceType,
          attendedEventSources.sourceRef,
        ],
      })
      .returning({ id: attendedEventSources.id });
    if (result.length > 0) inserted++;
  }
  return inserted;
}
