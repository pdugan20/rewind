# Attending Domain — Design

Canonical shapes, contracts, and decisions. Referenced by TRACKER.md tasks. Schema for the read-side already shipped on `worktree-attending-domain` (commit `aba384e`); this doc covers the ingestion pipeline.

## Google OAuth foundation

### `google_tokens` table

Mirrors `strava_tokens` and `trakt_tokens` exactly. New file: `src/db/schema/google.ts`.

```sql
CREATE TABLE IF NOT EXISTS google_tokens (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id integer DEFAULT 1 NOT NULL,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at integer NOT NULL,        -- epoch seconds
  scopes text NOT NULL,                -- space-separated; verify on refresh
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_google_tokens_user_id ON google_tokens (user_id);
```

`scopes` is text, not normalized — the only reads are "does this token have what I need." On refresh we re-verify scopes match expectations and `console.log('[ERROR] ...')` if not (then bail rather than guess).

### Env vars (wrangler.toml + `Env` interface)

```
GOOGLE_CLIENT_ID         = "...apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET     = "..."
```

No `GOOGLE_REDIRECT_URI` — the Desktop OAuth flow uses `http://127.0.0.1:<dynamic-port>` for the loopback, and the prod Worker never touches the redirect (it only does refresh).

### `services/google/auth.ts`

Single exported function:

```ts
export async function getGoogleAccessToken(
  db: Database,
  env: Env
): Promise<string>;
```

Behavior: read row → if `expires_at - now() > 60s`, return cached `access_token`. Otherwise POST to `https://oauth2.googleapis.com/token` with `grant_type=refresh_token` (form-encoded body, NOT JSON), update row, return new token. Throws `Error('Google token refresh failed: ...')` on non-200.

```ts
const body = new URLSearchParams({
  client_id: env.GOOGLE_CLIENT_ID,
  client_secret: env.GOOGLE_CLIENT_SECRET,
  refresh_token: row.refreshToken,
  grant_type: 'refresh_token',
});
const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body,
});
const json = await res.json<{
  access_token: string;
  expires_in: number;
  scope: string;
}>();
```

### One-shot setup script

`scripts/tools/setup-google.ts` modeled on `scripts/tools/setup-trakt.ts`. Spins up a localhost loopback server, opens a browser to Google's consent URL with `access_type=offline&prompt=consent`, captures the code, exchanges it for an access+refresh token pair, and inserts into `google_tokens`.

**Important**: the consent screen MUST be in "In production" status before this runs — otherwise refresh_token expires after 7 days. For a personal-use app under 100 users, "In production" can be reached without verification (Google shows an "unverified app" warning that you click through).

## Calendar extractor

### `services/google/calendar-client.ts`

```ts
export interface CalendarEvent {
  id: string;
  summary: string;
  location: string | null;
  description: string | null;
  startDateTime: string | null; // ISO 8601 with offset
  startDate: string | null; // YYYY-MM-DD for all-day
  end: { dateTime?: string; date?: string };
}

export async function listCalendarEvents(
  accessToken: string,
  opts: {
    timeMin?: string;
    timeMax?: string;
    q?: string;
    syncToken?: string;
    pageToken?: string;
  }
): Promise<{
  events: CalendarEvent[];
  nextSyncToken?: string;
  nextPageToken?: string;
}>;
```

Endpoint: `GET https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&maxResults=250&...`. Pagination via `nextPageToken` (loop until absent). For incremental sync, pass `syncToken` from the previous run; first run doesn't (full re-pull).

`syncToken` storage: a row in `sync_runs` with `domain='attending'`, `sync_type='calendar_sync_token'`, `metadata = JSON.stringify({ token })`. Read on next run. On 410 Gone (token expired), drop and full-re-pull.

### Allowlist matcher

`services/attending/allowlist.ts` — pure constants module. Matched against `summary` (case-insensitive substring) and `location` (case-insensitive substring against name + every alias).

```ts
export const TEAM_KEYWORDS = [
  'mariners',
  'seahawks',
  'storm',
  'sounders',
  'kraken',
  'huskies',
  'uw football',
  'uw basketball',
  'washington huskies',
];

export const VENUE_KEYWORDS = [
  't-mobile park',
  'safeco field', // Mariners
  'climate pledge arena',
  'keyarena', // Storm, Kraken
  'lumen field',
  'centurylink field',
  'qwest field', // Seahawks, Sounders
  'husky stadium',
  'alaska airlines field', // UW football
  'alaska airlines arena',
  'hec edmundson', // UW basketball
  'showbox',
  'paramount theatre',
  'moore theatre',
  'neumos', // music
];
```

A calendar event matches if its summary or location contains any keyword. Confirmed matches write to `attended_event_sources` with `source_type='gcal'`, `source_ref=<calendar_event_id>`, `raw_data=<full event JSON>`.

## Gmail extractor

### `services/google/gmail-client.ts`

```ts
export async function listGmailMessages(
  accessToken: string,
  query: string,
  opts: { pageToken?: string; maxResults?: number }
): Promise<{ messages: { id: string }[]; nextPageToken?: string }>;

export async function getGmailMessage(
  accessToken: string,
  id: string
): Promise<GmailMessage>;

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string; // epoch ms as string
  headers: Record<string, string>;
  bodyText: string | null; // first text/plain part, decoded
  bodyHtml: string | null; // first text/html part, decoded
  raw: object; // the full payload, in case parsers need more
}
```

Use `format=full`. Walk `payload.parts[]` recursively for `text/plain` and `text/html`; base64url-decode (`-`/`_`, no padding) `body.data`. If `payload.parts` is absent, the message body is at `payload.body.data` directly.

### Gmail query string

Built from the vendor allowlist:

```
from:(noreply@ticketmaster.com OR
      customer_support@email.ticketmaster.com OR
      noreply@seatgeek.com OR orders@seatgeek.com OR hi@seatgeek.com OR
      info@ticketclub.com OR orders@ticketclub.com OR
      customer.service@axs.com OR tickets@axs.com OR
      customerservice@stubhub.com OR noreply@stubhub.com OR
      orders@vividseats.com OR customerservice@vividseats.com)
newer_than:2d
```

Cron uses `newer_than:2d`. Backfill drops the date filter or uses `older_than:` with a date range to scope passes.

### Subject-line gate (cheap pre-filter)

Before fetching message body, filter the `messages.list` results by subject (returned in the message-summary response when we then call `messages.get`). Reject any subject containing:

```
['reminder', 'tomorrow', 'transferred', 'sent to you', 'refund',
 'cancellation', 'has been canceled', 'gift card', 'thank you for joining']
```

Accept any subject containing:

```
['order confirmation', 'your tickets', 'your order', 'order #', 'is confirmed', 'order is confirmed']
```

Subjects matching neither get logged at INFO level for review (build the gate over time).

### MIME walker

```ts
function walkParts(payload: any, mime: string): string | null {
  if (payload.mimeType === mime && payload.body?.data) {
    return base64urlDecode(payload.body.data);
  }
  for (const p of payload.parts ?? []) {
    const found = walkParts(p, mime);
    if (found) return found;
  }
  return null;
}
```

`base64urlDecode`: `atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + (4 - s.length % 4) % 4, '='))`. Workers have global `atob`.

## Calendar-embedded ticket data (discovered Phase 2)

Google Calendar **auto-parses** ticket-vendor confirmation emails and writes the structured fields into the event's `description` when the vendor is on Google's email-markup trusted-sender list. Observed in a real Mariners SeatGeek purchase:

```
Reservation Number: 6P2-8YP454J

Provider: SeatGeek

Guests: Patrick Dugan

Seats: 18, 19, 20
```

Implication: for events that show up in Calendar with this auto-enrichment, we can extract `vendor`, `order_id`, and `seat` info **from the calendar event description alone** — no Gmail parse needed. This is a meaningful shortcut for the cron path (we'd skip the Gmail extractor for these and just pull from calendar).

Plan:

- `parse-calendar-description.ts` (Phase 3 sibling): regex-extract `Reservation Number`, `Provider`, `Seats`, `Section`, `Row`, `Total` lines from event descriptions when present.
- Treat this as a "tier 0" extraction path: if the calendar description has the markers, use it; only fall back to Gmail JSON-LD parser when the description is sparse.
- Doesn't change the Gmail parser plan — historical events without calendar entries (or with empty descriptions because the calendar entry predates Google's auto-enrichment) still need Gmail. But for active-cron territory this is gold.

## Universal JSON-LD parser

`services/attending/parse-jsonld.ts`. Single function for Ticketmaster + AXS + StubHub + SeatGeek.

```ts
export interface ParsedReservation {
  reservation_number: string | null;
  event_name: string;
  event_start: string; // ISO 8601 with offset
  venue_name: string | null;
  venue_address: string | null;
  section: string | null;
  row: string | null;
  seat: string | null;
  total_price_cents: number | null;
  currency: string;
  vendor: VendorEnum;
}

export function parseEventReservationFromHtml(
  html: string,
  vendor: VendorEnum
): ParsedReservation[] | null;
```

Approach:

1. Match all `<script type="application/ld+json">...</script>` blocks. Tolerant regex: `/<script[^>]*type=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi`.
2. JSON-parse each block (try/catch — some senders include invalid JSON for tracking).
3. Walk the structure (it can be a single object, an array, or `@graph`), collect everything where `@type === 'EventReservation'`.
4. For each reservation:
   - `reservation_number` ← `reservationNumber`
   - `event_name` ← `reservationFor.name`
   - `event_start` ← `reservationFor.startDate`
   - `venue_name` ← `reservationFor.location.name`
   - `venue_address` ← composed from `reservationFor.location.address` (string or PostalAddress object)
   - `section` ← `reservedTicket.ticketedSeat.seatSection`
   - `row` ← `reservedTicket.ticketedSeat.seatRow`
   - `seat` ← `reservedTicket.ticketedSeat.seatNumber`
   - `total_price_cents` ← `Math.round(parseFloat(totalPrice ?? reservedTicket.priceCurrency) * 100)`
   - `currency` ← `priceCurrency` ?? `'USD'`

Returns array because Ticketmaster + AXS emit one EventReservation per seat. SeatGeek tends to emit one reservation with multiple `reservedTicket` entries — handle that case by expanding into N rows (one per ticketedSeat). Returns `null` if no JSON-LD found (caller falls back to vendor-specific HTML scraper).

### Edge cases

- **AXS mobile entry**: `seatNumber` is the literal string "Mobile Entry". Treat as null seat.
- **StubHub "your tickets are ready"**: same `reservation_number` as the original confirmation. Dedupe key in `attended_event_tickets` is `(vendor, order_id)` UNIQUE — natural dedupe, second insert no-ops.
- **SeatGeek resale**: still includes JSON-LD, just with a different `programMembershipUrl`. No special handling.

## Per-vendor HTML scrapers (deferred)

`services/attending/parse-vivid.ts` and `parse-ticketclub.ts`. Built only after Phase 3 is shipped and we see real volume from these vendors. Pattern:

```ts
function fieldByLabel(html: string, label: string): string | null {
  const re = new RegExp(`${label}:?\\s*</[^>]+>\\s*<[^>]+>([^<]+)<`, 'i');
  return html.match(re)?.[1]?.trim() ?? null;
}
```

Labels to extract per vendor:

- VividSeats: `Section`, `Row`, `Seat`, `Order Total`, `Order #`, `Event Date`, `Venue`
- TicketClub: similar list — needs to see real samples first

## Match step

### Venue resolver

`services/attending/match.ts → resolveVenue(rawName: string, db: Database)`. Case-insensitive lookup against `venues.name` AND `JSON_EACH(venues.aliases)`. If no match, auto-create with `name=rawName`, no aliases, no city/state — flag via `match_confidence = 0.5` so review can flag-and-merge later.

The seed migration (Phase 1) prepopulates: T-Mobile Park (alias: Safeco Field), Climate Pledge Arena (alias: KeyArena), Lumen Field (aliases: CenturyLink Field, Qwest Field), Husky Stadium (alias: Alaska Airlines Field at Husky Stadium), Alaska Airlines Arena (alias: Hec Edmundson Pavilion), Showbox SoDo, Showbox at the Market, Paramount Theatre, Moore Theatre, Neumos.

### Sports match

For sports candidates, after venue resolution:

```ts
async function matchMlbGame(
  date: string,
  venueId: number,
  db: Database
): Promise<MlbGameMatch | null>;
async function matchEspnGame(
  league: EspnLeague,
  date: string,
  teamId: number
): Promise<EspnGameMatch | null>;
```

For MLB: `statsapi.mlb.com/api/v1/schedule?teamId=136&date=YYYY-MM-DD` (date format: `YYYY-MM-DD`). Returns at most 1-2 games (regular + DH). Pick the home game if venue is T-Mobile Park, away game otherwise. Extract `gamePk`, `teams.home/away`, scores, `home.isWinner`.

For ESPN: `https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard?dates=YYYYMMDD`. Filter to events involving `teamId`.

```ts
type EspnLeague =
  | { sport: 'football'; league: 'nfl' }
  | { sport: 'football'; league: 'college-football' }
  | { sport: 'basketball'; league: 'nba' }
  | { sport: 'basketball'; league: 'wnba' }
  | { sport: 'basketball'; league: 'mens-college-basketball' }
  | { sport: 'soccer'; league: 'usa.1' }; // MLS
```

Common response path: `events[].competitions[0].competitors[]` where `homeAway`, `score`, `winner`, `team.id`, `team.displayName` are reliably present. `events[].id` = ESPN game id.

UW Huskies football team id: `264` (ESPN). UW men's basketball: also `264`. (ESPN reuses team_id across sports for the same school.)

### Performer resolver (concerts only)

`resolvePerformer(name: string, mbid: string | null, db: Database)`. Match flow:

1. If `mbid` provided: lookup `performers.mbid = mbid`. If found, return.
2. Lookup `performers.name = name` (exact, case-insensitive). If found, return.
3. **Cross-domain probe**: lookup `lastfm_artists.name = name` (case-insensitive). If found, create a `performers` row with `lastfm_artist_id` set, return.
4. Else create a new `performers` row with no cross-link, return.

The "cross-domain probe" is the heart of the concert↔listening join the user wanted from the start. Future enhancement: fuzzy-match (Levenshtein, normalized) when exact match fails — but only if we see misses in practice.

### Concert enrichment (setlist.fm)

`services/setlist/client.ts`. Endpoint: `https://api.setlist.fm/rest/1.0/search/setlists?artistName={name}&date={DD-MM-YYYY}` (yes, DD-MM-YYYY — gotcha). Headers: `x-api-key: $SETLIST_FM_API_KEY`, `Accept: application/json`. Rate limit: 2 req/s, 1440/day — ample.

Response: `setlist[]` array. Match the first entry whose `venue.name` or `venue.city.name` aligns with the resolved venue. Pull `tour.name`, `info`, `url` (the setlist.fm page URL). Store the setlist URL in `event_data.setlist_fm_url`. Don't store the full setlist — too large, low value to denormalize.

## Dedupe

`services/attending/dedupe.ts`. The dedupe key is **`(user_id, event_date, venue_id)`** — one event per venue per day is virtually always right. Festivals and double-headers are the edge cases:

- **MLB doubleheader**: two games at T-Mobile Park on the same date. Disambiguate by `gamePk` (unique). The dedupe key fails here, so for sports we override: when both candidates have a confirmed `external_id` from the same source (`mlb_stats_api`) and they differ, treat them as separate events.
- **Festival multi-day**: each day is a separate `attended_events` row with the same `series_id`. Dedupe key works as-is (different dates).
- **Concert opener mistaken for a separate event**: the JSON-LD parser returns one `EventReservation` per ticket, but ticket-row count != event count. Always group `reservedTicket` entries from the same `EventReservation` into one event with N tickets.

```ts
function dedupeKey(c: CandidateEvent): string {
  if (c.external_source === 'mlb_stats_api' && c.external_id) {
    return `mlb:${c.external_id}`;
  }
  return `${c.user_id}:${c.event_date}:${c.venue_id ?? 'unknown'}`;
}
```

When merging multiple candidates into one canonical event:

- Take the most-specific `event_datetime` (prefer one with time over date-only).
- Take any non-null fields from any candidate (calendar provides notes, email provides tickets).
- Concatenate `attended_event_sources` rows so all provenance is preserved.

## Load step

`services/attending/load.ts`. Upserts in this order:

1. `venues` (resolver may have created on-the-fly above).
2. `performers` (concerts).
3. `attended_events` — INSERT … ON CONFLICT (`external_source`, `external_id`) DO UPDATE for sports games with `external_id`; INSERT for new events.
4. `attended_event_performers` — many-to-many for concerts (with role/billing).
5. `attended_event_tickets` — INSERT, ON CONFLICT (`vendor`, `order_id`) DO NOTHING.
6. `attended_event_sources` — INSERT, ON CONFLICT (`source_type`, `source_ref`) DO UPDATE SET `event_id`.

All in a single D1 transaction per canonical event. Failure rolls back; the source rows still exist in `attended_event_sources` from the extract phase, so re-run is safe.

## Manual-entry path (Phase 8)

For events with no email/calendar trail (UW football 2007–2010 and similar). Two pieces:

### `scripts/data/manual-attending.json`

```json
[
  {
    "event_date": "2008-09-13",
    "event_type": "ncaaf_game",
    "team_id": 264,
    "opponent": "Oklahoma",
    "is_home": true,
    "notes": "Sun Devil Stadium..."
  },
  {
    "event_date": "2009-10-24",
    "event_type": "ncaaf_game",
    "team_id": 264,
    "opponent": "Oregon",
    "is_home": true
  }
]
```

User curates by hand, probably with help from Wikipedia season pages (e.g. `2008 Washington Huskies football team`). One row per attended game. ~25 home games × 4 seasons ≈ ~100 rows total.

### Seeder route + script

```
POST /v1/admin/sync/attending/manual-import
Content-Type: application/json
{ "events": [...], "dry_run": false }
```

Implementation: for each input row, hit ESPN's college-football scoreboard for the date, find the game involving team_id 264 + opponent, extract the canonical record (final score, ESPN game id, opponent team object), upsert into `attended_events` with `external_source='espn'`, `external_id=<espn_id>`. Returns the count loaded + any rows that couldn't be matched (so user can fix).

`scripts/tools/import-manual-attending.ts` is a thin wrapper that POSTs the JSON file to the endpoint. Mirrors the existing admin scripts.

## Time zones

`event_date` is **YYYY-MM-DD in venue local time**, never UTC. Reasoning: a 7pm Mariners game on June 15 is unambiguously a "June 15" event to a human; storing UTC would rebrand a Tuesday late game as Wednesday on lookup. We don't store TZ explicitly — venue local time is implied by `venue_id` (and we're not doing aggregations across time zones).

`event_datetime` (when known) is full ISO 8601 with offset. Calendar events provide this directly. JSON-LD `startDate` is ISO 8601 with offset too. The MLB Stats API returns `gameDate` in UTC; we convert via the venue's TZ to derive `event_date`.

## Cron entry

In `src/index.ts` `scheduled` handler:

```ts
case '0 4 * * *': {
  const retry = await shouldRetry(db, 'attending');
  if (retry.shouldRetry) {
    console.log(`[SYNC] Retrying failed attending sync (${retry.consecutiveFailures} consecutive failures)`);
  }
  console.log('[SYNC] Attending refresh');
  ctx.waitUntil(
    backfillAttending(db, { source: 'all', mode: 'incremental' }).catch((err) =>
      console.log(`[ERROR] Attending sync failed: ${err instanceof Error ? err.message : String(err)}`)
    )
  );
  break;
}
```

`backfillAttending` already exists as a stub; Phase 6 fills it in. The `mode` param distinguishes daily-window vs full-history.

## /v1/health/sync update

Register `attending` domain. Same shape as existing entries — last successful run timestamp, consecutive failure count, sync_runs latest-row metadata.

## Test strategy

- **Vendor parser fixtures**: per-vendor `*.eml` files in `src/services/attending/__fixtures__/`. Unit tests assert the `ParsedReservation` shape from each.
- **JSON-LD parser tests**: synthetic JSON-LD payloads covering single-reservation, multi-seat-array, `@graph`-wrapped, malformed-JSON.
- **Allowlist matcher tests**: positive + negative samples of summaries and locations.
- **MLB / ESPN client tests**: recorded fixture responses (vitest's MSW or just hardcoded fetch mocks). One game per league, both home and away.
- **Dedupe tests**: deliberate key-collision cases (calendar+email same event, doubleheader, festival multi-day).
- **End-to-end backfill test**: runs the pipeline against a fixture set, asserts the final `attended_events` rows.

## Things explicitly NOT solved here

- **Multi-account Google OAuth**. Single-user assumption baked in (`user_id=1` everywhere). When multi-user matters, `google_tokens.user_id` is already there.
- **Image enrichment for the new domain**. Team logos / venue photos / performer photos all deferred to a follow-up project.
- **MCP tools**. Mechanical port of the read endpoints; deferred follow-up project.
- **Activity feed surfacing**. Deferred follow-up.
- **Portfolio site Mariners 2024 page**. Deferred — different repo.
