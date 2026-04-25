// Thin client over Google Calendar API v3 — direct fetch, no SDK.
// Used by the attending-domain extractor to pull candidate events.
//
// Two pull modes:
//   1. Range pull — pass timeMin/timeMax. Used for backfill.
//   2. Incremental — pass syncToken from a prior call. Used by the daily
//      cron. Google returns only events that changed since the token was
//      issued, plus a fresh nextSyncToken for the next run.
//
// On 410 GONE the syncToken has expired (Google rotates tokens after
// roughly 30 days, sometimes sooner). The caller should drop the stored
// token and re-run with timeMin/timeMax.

const CALENDAR_BASE =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export interface CalendarEventDate {
  dateTime?: string; // ISO 8601 with offset, for timed events
  date?: string; // YYYY-MM-DD, for all-day events
  timeZone?: string;
}

export interface CalendarEvent {
  id: string;
  summary: string | null;
  location: string | null;
  description: string | null;
  start: CalendarEventDate;
  end: CalendarEventDate;
  status: string | null; // 'confirmed' | 'tentative' | 'cancelled'
  htmlLink: string | null;
}

export interface ListCalendarOptions {
  timeMin?: string; // ISO 8601 (inclusive)
  timeMax?: string; // ISO 8601 (exclusive)
  q?: string; // free-text query against summary/description/location
  syncToken?: string; // mutually exclusive with timeMin/timeMax
  pageToken?: string; // for follow-up pages within a single pull
  maxResults?: number; // default 250 (Google's max)
}

export interface ListCalendarResult {
  events: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export class CalendarSyncTokenExpiredError extends Error {
  constructor() {
    super('Calendar syncToken expired (410); caller should re-pull by range.');
    this.name = 'CalendarSyncTokenExpiredError';
  }
}

/**
 * Fetch one page of Calendar events. Caller drives pagination with
 * `nextPageToken`. When `nextPageToken` is absent, the response carries
 * `nextSyncToken` — store it for the next incremental run.
 */
export async function listCalendarEvents(
  accessToken: string,
  opts: ListCalendarOptions
): Promise<ListCalendarResult> {
  const params = new URLSearchParams();

  if (opts.syncToken) {
    params.set('syncToken', opts.syncToken);
  } else {
    if (opts.timeMin) params.set('timeMin', opts.timeMin);
    if (opts.timeMax) params.set('timeMax', opts.timeMax);
    // singleEvents=true expands recurring events into individual instances —
    // almost always what we want, and required when ordering by startTime.
    params.set('singleEvents', 'true');
    params.set('orderBy', 'startTime');
  }

  if (opts.q) params.set('q', opts.q);
  if (opts.pageToken) params.set('pageToken', opts.pageToken);
  params.set('maxResults', String(opts.maxResults ?? 250));
  // Trim the response to the fields we actually parse. Roughly halves
  // payload size.
  params.set(
    'fields',
    'nextPageToken,nextSyncToken,items(id,summary,location,description,start,end,status,htmlLink)'
  );

  const url = `${CALENDAR_BASE}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 410) {
    throw new CalendarSyncTokenExpiredError();
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Calendar events.list ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    items?: Array<Partial<CalendarEvent>>;
    nextPageToken?: string;
    nextSyncToken?: string;
  };

  const events: CalendarEvent[] = (data.items ?? []).map((raw) => ({
    id: raw.id ?? '',
    summary: raw.summary ?? null,
    location: raw.location ?? null,
    description: raw.description ?? null,
    start: raw.start ?? {},
    end: raw.end ?? {},
    status: raw.status ?? null,
    htmlLink: raw.htmlLink ?? null,
  }));

  return {
    events,
    nextPageToken: data.nextPageToken,
    nextSyncToken: data.nextSyncToken,
  };
}

/**
 * Convenience: drain all pages of a Calendar pull into a single array.
 * Returns the final `nextSyncToken` so the caller can persist it.
 *
 * Caller-beware: this loads every event into memory. For a many-year
 * backfill, prefer paginating yourself and streaming candidates into
 * attended_event_sources page-by-page.
 */
export async function listAllCalendarEvents(
  accessToken: string,
  opts: ListCalendarOptions
): Promise<{ events: CalendarEvent[]; nextSyncToken?: string }> {
  const all: CalendarEvent[] = [];
  let pageToken: string | undefined;
  let lastSyncToken: string | undefined;

  do {
    const page = await listCalendarEvents(accessToken, {
      ...opts,
      pageToken,
    });
    all.push(...page.events);
    pageToken = page.nextPageToken;
    if (page.nextSyncToken) lastSyncToken = page.nextSyncToken;
  } while (pageToken);

  return { events: all, nextSyncToken: lastSyncToken };
}
