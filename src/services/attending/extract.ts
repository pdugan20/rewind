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
import {
  listGmailMessages,
  getGmailMessage,
  judgeSubject,
  type GmailMessage,
} from '../google/gmail-client.js';
import { matchesAllowlist, buildGmailVendorQuery } from './allowlist.js';
import {
  parseEventReservationFromHtml,
  inferVendorFromSender,
  type ParsedReservation,
} from './parse-jsonld.js';
import { parseSeatGeekText } from './parse-seatgeek.js';
import { parseTicketClubHtml } from './parse-ticketclub.js';
import { parseTicketmasterHtml } from './parse-ticketmaster.js';
import { parseAxsHtml } from './parse-axs.js';
import { parseVividHtml } from './parse-vivid.js';
import { parseStubhubHtml } from './parse-stubhub.js';
import { parseEventbriteHtml } from './parse-eventbrite.js';

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

// ─── Gmail extractor ───────────────────────────────────────────────

export interface ExtractGmailOptions {
  newerThanDays?: number; // cron-incremental (default 2)
  olderThanDate?: string; // YYYY-MM-DD, for backfill segments
  newerThanDate?: string; // YYYY-MM-DD, for backfill segments
  dryRun?: boolean;
  maxMessages?: number; // safety cap; default no cap
}

export interface ExtractGmailResult {
  scanned: number; // messages.list returned this many ids
  fetched: number; // .get'd this many bodies (after subject gate)
  parsed: number; // produced at least one ParsedReservation
  inserted: number;
  skipped_subject: number;
  skipped_no_jsonld: number; // body had no JSON-LD blocks at all
  candidates: ParsedGmailCandidate[];
}

export interface ParsedGmailCandidate {
  source_ref: string; // Gmail message id
  subject: string | null;
  from: string | null;
  internal_date: string; // ISO 8601
  reservations: ParsedReservation[];
  body_text: string | null;
  body_html: string | null;
}

export async function extractGmailCandidates(
  db: Database,
  env: Env,
  opts: ExtractGmailOptions = {}
): Promise<ExtractGmailResult> {
  const dryRun = opts.dryRun ?? false;
  const accessToken = await getGoogleAccessToken(db, env);

  const dateFragment = buildDateFragment(opts);
  const query = `${buildGmailVendorQuery()}${dateFragment ? ' ' + dateFragment : ''}`;
  console.log(`[SYNC] Gmail extractor query: ${query}`);

  const result: ExtractGmailResult = {
    scanned: 0,
    fetched: 0,
    parsed: 0,
    inserted: 0,
    skipped_subject: 0,
    skipped_no_jsonld: 0,
    candidates: [],
  };

  let pageToken: string | undefined;
  do {
    const page = await listGmailMessages(accessToken, query, {
      pageToken,
      maxResults: 100,
    });
    result.scanned += page.messages.length;

    for (const ref of page.messages) {
      if (opts.maxMessages && result.fetched >= opts.maxMessages) break;
      const msg = await getGmailMessage(accessToken, ref.id);
      const verdict = judgeSubject(msg.headers.subject);
      if (verdict === 'reject') {
        result.skipped_subject++;
        continue;
      }
      result.fetched++;

      // Always capture as a candidate, even when the JSON-LD parser
      // finds nothing. Reality from Phase 3 check: most vendors do NOT
      // emit JSON-LD; the source row stores the raw text/html for
      // per-vendor labeled-text parsers (Phase 3.4) to consume later.
      const candidate = parseMessageCapture(msg);
      if (candidate.reservations.length === 0) result.skipped_no_jsonld++;
      else result.parsed++;
      result.candidates.push(candidate);
    }

    pageToken = page.nextPageToken;
    if (opts.maxMessages && result.fetched >= opts.maxMessages) break;
  } while (pageToken);

  if (!dryRun && result.candidates.length > 0) {
    result.inserted = await insertGmailSourceRows(db, result.candidates);
  }

  return result;
}

function buildDateFragment(opts: ExtractGmailOptions): string {
  const parts: string[] = [];
  if (opts.newerThanDays != null) {
    parts.push(`newer_than:${opts.newerThanDays}d`);
  }
  if (opts.newerThanDate) {
    parts.push(`after:${opts.newerThanDate.replace(/-/g, '/')}`);
  }
  if (opts.olderThanDate) {
    parts.push(`before:${opts.olderThanDate.replace(/-/g, '/')}`);
  }
  return parts.join(' ');
}

// Always returns a candidate — `reservations` is empty when neither
// JSON-LD nor any vendor-specific parser found anything. The raw HTML +
// text are kept in the source row so a later parser pass can re-process
// without re-fetching from Gmail.
function parseMessageCapture(msg: GmailMessage): ParsedGmailCandidate {
  const subject = msg.headers.subject ?? null;
  const from = msg.headers.from ?? null;
  const vendor = inferVendorFromSender(from ?? undefined);
  const html = msg.bodyHtml ?? '';

  // Tiered parsing: try JSON-LD first (cheap, covers any vendor that
  // emits it), then per-vendor labeled-text/HTML parsers. Empty
  // `reservations` means no parser path matched — source row still
  // gets stored so reprocess can re-try later.
  let reservations = parseEventReservationFromHtml(html, vendor) ?? [];
  if (reservations.length === 0) {
    if (vendor === 'seatgeek') {
      reservations = parseSeatGeekText(msg.bodyText) ?? [];
    } else if (vendor === 'ticketclub') {
      reservations = parseTicketClubHtml(html) ?? [];
    } else if (vendor === 'ticketmaster') {
      reservations = parseTicketmasterHtml(html, msg.id) ?? [];
    } else if (vendor === 'axs') {
      reservations = parseAxsHtml(html) ?? [];
    } else if (vendor === 'vividseats') {
      reservations = parseVividHtml(html) ?? [];
    } else if (vendor === 'stubhub') {
      reservations = parseStubhubHtml(html) ?? [];
    } else if (vendor === 'eventbrite') {
      reservations = parseEventbriteHtml(html) ?? [];
    }
  }

  return {
    source_ref: msg.id,
    subject,
    from,
    internal_date: new Date(parseInt(msg.internalDate, 10)).toISOString(),
    reservations,
    // Capped at 12k chars each — enough for the structured fields
    // (Order number, Section, Row, Seats, Total) which always appear
    // in the first portion of these emails. Stores BOTH text/plain and
    // text/html because some vendors (Ticket Club, older Ticketmaster)
    // ship HTML-only emails — body_text would be null in that case.
    body_text: msg.bodyText ? msg.bodyText.slice(0, 12000) : null,
    body_html: msg.bodyHtml ? msg.bodyHtml.slice(0, 24000) : null,
  };
}

async function insertGmailSourceRows(
  db: Database,
  candidates: ParsedGmailCandidate[]
): Promise<number> {
  let inserted = 0;
  for (const c of candidates) {
    const result = await db
      .insert(attendedEventSources)
      .values({
        userId: 1,
        sourceType: 'gmail',
        sourceRef: c.source_ref,
        rawData: JSON.stringify({
          subject: c.subject,
          from: c.from,
          internal_date: c.internal_date,
          reservations: c.reservations,
          body_text: c.body_text,
          body_html: c.body_html,
        }),
        matchConfidence: c.reservations.length > 0 ? 1.0 : 0.3,
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

// ─── Helpers (calendar) ─────────────────────────────────────────────

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
