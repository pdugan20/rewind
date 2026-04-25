# Project: Attending Domain

Live events you bought tickets for — Mariners games, Seahawks games, Storm games, **UW Huskies football** (and basketball), concerts, theater. Today this data is scattered across Google Calendar entries, ticket-vendor email confirmations, college-era memory, and the back of receipt boxes. This project pulls it into Rewind as a first-class domain so the portfolio site can render a season grid (Mariners 2024, UW 2008, etc.) with attended-or-not overlay, and so the daily cron keeps it fresh going forward.

## Motivation

Five concrete things this unlocks:

1. **A Mariners season page** on `pat-portfolio` showing the full schedule + which games I attended + W/L when I was there.
2. Same shape extensible to **Seahawks, Storm, Sounders, UW Huskies football/basketball, Blazers/Warriors-when-traveling**, etc. — the portfolio doesn't care which league. UW gets special weight: most home football games attended 2007–2010 (college years), still attending semi-regularly today.
3. **Concerts I went to**, cross-linked to my listening history (did I go see artists I scrobble?). The schema already supports the cross-link via `performers.lastfm_artist_id`.
4. **MCP queries** like "what Mariners games did I attend in 2023?" / "what concerts did I see in Seattle last year?" via Claude Desktop.
5. A **typed, queryable record** of years of paid-ticket events — recovered from email and calendar before the data ages out (Gmail keeps things forever in practice but vendor template churn can silently break new parsers against old emails if you wait too long).

## Status

Branch `worktree-attending-domain`:

| Phase | Status                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Scaffolding — DONE (`c934041`). Schema, routes, admin stub, OpenAPI tag.                                                                                                                                                                                                                                                                                                                                                 |
| 1     | Google OAuth foundation — DONE LOCALLY (`2100971`, `de082da`). End-to-end smoke validated against `dugan.pat@gmail.com` (216k messages accessible, both scopes granted). Production seed deferred to Phase 9.                                                                                                                                                                                                            |
| 2     | Calendar extractor — DONE. 8-year dry-run scanned 8,882 events, matched 53 across Mariners, Seahawks, Huskies, concerts. Idempotent via `.onConflictDoNothing()`. 707/707 tests pass.                                                                                                                                                                                                                                    |
| 3     | Gmail extractor — DONE with reality-check pivot. JSON-LD coverage from research turned out to be zero in practice; pivoted to domain-level Gmail filter + per-vendor labeled-text parsers (SeatGeek shipped, others as backfill exposes them). Brittleness analysis added to DESIGN.md. 90-day dry-run found 13 confirmations, 4 fully parsed (Mariners SeatGeek with full venue + 3 seats + total). 765/765 tests pass. |
| 4     | Match + enrich pipeline — DONE. Venue resolver, MLB Stats client, ESPN unified client (NFL/NBA/WNBA/MLS/NCAAF/NCAAB), setlist.fm client (free key gated), performer cross-domain resolver, orchestrator. Validated against real calendar: 2024 UW football season fully enriched (Apple Cup loss to WSU, USC OT win, Michigan W, etc.) plus Mariners games with scores. 823/823 tests pass.                              |
| 5–9   | Pending. See TRACKER.md.                                                                                                                                                                                                                                                                                                                                                                                                 |

This project covers the data-ingestion pipeline: Google OAuth foundation, Calendar + Gmail extractors, sports/concert enrichment, dedupe/load, cron wiring, and one-time backfill execution.

## Scope

The pipeline is five stages — `extract → parse → match → dedupe → load` — fed by two ingestion sources (Google Calendar + Gmail) and three enrichment sources (MLB Stats API, ESPN unofficial, setlist.fm).

| Phase | Scope                                                                                                                                                                                            | Dependency                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| 1     | Google OAuth foundation: `google_tokens` table, refresh-token service, one-shot setup CLI                                                                                                        | None (mirrors `services/strava/auth.ts`) |
| 2     | Calendar extractor: events.list with allowlist, syncToken-based incremental                                                                                                                      | Phase 1                                  |
| 3     | Gmail extractor + universal JSON-LD parser (covers TM/AXS/StubHub/SeatGeek)                                                                                                                      | Phase 1                                  |
| 4     | Match/enrich: venue resolver, MLB Stats API, shared ESPN client, setlist.fm                                                                                                                      | Phase 2 + 3                              |
| 5     | Dedupe + load: candidate→canonical, upsert, performer cross-link to `lastfm_artists`                                                                                                             | Phase 4                                  |
| 6     | Cron wiring + health: daily entry, retry registration, `/v1/health/sync` inclusion                                                                                                               | Phase 5                                  |
| 7     | Review surface: dry-run mode, admin candidate-approval endpoint                                                                                                                                  | Phase 5                                  |
| 8     | **Manual-entry path** for events with no email/calendar trail (UW football 2007–2010, etc.): a CSV/JSON import endpoint + a tiny seeder script that pairs hand-written rows with ESPN enrichment | Phase 4 (needs ESPN client)              |
| 9     | Backfill execution: one-time historical sweep (auto + manual), spot-check, cleanup                                                                                                               | Phase 1–8                                |

Vendor coverage in Phase 3:

- **JSON-LD parser** (one implementation, four vendors): Ticketmaster, AXS, StubHub, SeatGeek. Google's "email markup" trusted-sender list confirms these emit valid `schema.org/EventReservation` payloads.
- **HTML scrapers** (per-vendor, deferred until volume justifies): VividSeats, TicketClub. Labeled-field regex over `Section:`, `Row:`, `Seat:`, `Order Total:` rather than CSS selectors — templates change but human-readable labels rarely do.

Sports coverage in Phase 4:

- **MLB**: `statsapi.mlb.com` direct (no auth, stable since ~2018). Mariners team_id = 136.
- **NFL / WNBA / NBA / MLS / NCAAF / NCAAB**: shared ESPN client (`site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard?dates=YYYYMMDD`). Same response shape across all six — one client, six leagues. UW Huskies football = `football/college-football` (team_id 264, "Washington Huskies"); basketball = `basketball/mens-college-basketball`. ESPN's college coverage goes back through the 2000s, which matters for the 2007–2010 backfill. ESPN endpoints are unsupported and could break; wrapped in try/catch with logged fallback so we notice fast.
- **Concerts**: setlist.fm by artist-MBID + date. Free API key, 2 req/s, 1440 req/day. Gotcha: date format is DD-MM-YYYY, not ISO.

## Non-goals

- **MLB schedule sync into Rewind.** The portfolio fetches the full schedule from MLB Stats API directly at render time and joins against Rewind's attendance. Mirroring 162 games × N seasons of public data into D1 is scope creep we don't need.
- **Live game enrichment.** We pull final scores after the game is played. We do not render in-progress games or live boxscores.
- **Multi-account Google OAuth.** Single personal `@gmail.com` account. If a work Workspace account is added later, the schema doesn't need to change — `google_tokens` already has `user_id`.
- **Auto-detection of arbitrary events.** The Calendar allowlist is explicit (Mariners, Seahawks, Storm, Sounders, T-Mobile Park, Climate Pledge Arena, Lumen Field, Safeco Field, plus venues for travel attendance). Random calendar entries about lunch don't get scanned.
- **Resale tracking and refunds.** A ticket I bought and resold is still recorded as "I bought tickets for date X." We don't model the resale chain — the `attended` boolean (1/0) is sufficient for "did I actually go." Refund emails get filtered out at the subject-line gate, not modeled separately.
- **MCP tools, activity-feed integration, image enrichment, portfolio site page.** Each is a follow-up project. This one ships clean data; downstream consumers come next. (See `## Follow-up projects` below.)

## Architecture

### Pipeline

```text
Google Calendar API ─┐                                             ┌─→ MLB Stats API
                     │                                             │
Gmail API ───────────┼─→ extract ─→ parse ─→ match ─────────────→ ┼─→ ESPN unified client
                     │              ↓         ↓                    │
                     │         JSON-LD     venue resolver           └─→ setlist.fm
                     │         HTML        performer resolver
                     │         iCal        (cross-link to
                     │                      lastfm_artists)
                     ↓
              attended_event_sources         ↓
              (provenance trail —    ─────→ dedupe ─→ load
               raw_data preserved          (by date+venue)   ↓
               so re-parsing doesn't                   attended_events
               lose context)                            attended_event_tickets
                                                       attended_event_performers
```

### Where each piece lives

```text
src/
  services/
    google/
      auth.ts              -- OAuth refresh-token flow (mirrors strava/auth.ts)
      calendar-client.ts   -- events.list + syncToken
      gmail-client.ts      -- messages.list + messages.get + MIME walker
    attending/
      backfill.ts          -- pipeline orchestrator (currently a stub)
      extract.ts           -- runs Calendar + Gmail extractors
      parse-jsonld.ts      -- universal EventReservation parser
      parse-vivid.ts       -- HTML scraper (deferred)
      parse-ticketclub.ts  -- HTML scraper (deferred)
      match.ts             -- venue resolver, performer resolver, sports lookup
      dedupe.ts            -- candidate merger (date + venue key)
      load.ts              -- upsert into attended_events / tickets / performers
      allowlist.ts         -- team/venue allowlist constants
    sports/
      mlb-client.ts        -- statsapi.mlb.com
      espn-client.ts       -- shared NFL/WNBA/NBA/MLS client
    setlist/
      client.ts            -- setlist.fm
  db/schema/
    attending.ts           -- already shipped
    google.ts              -- google_tokens (NEW, Phase 1)
  routes/
    attending.ts           -- already shipped (read endpoints)
    admin-sync.ts          -- POST /v1/admin/sync/attending stub already wired
scripts/tools/
  setup-google.ts          -- one-shot OAuth seed (mirrors setup-trakt.ts)
docs/projects/attending-domain/
  README.md DESIGN.md TRACKER.md
```

### Data flow per cron run (going-forward sync)

1. Cron fires daily at `0 4 * * *`.
2. Calendar extractor runs on `events.list` with `syncToken` (or full re-pull for first run / token-expired).
3. Gmail extractor runs `messages.list` with `q=from:(<vendor list>) newer_than:2d`.
4. Each candidate row written to `attended_event_sources` with `raw_data` JSON.
5. Parsers run; produce `CandidateEvent` shapes.
6. Match step: venue resolved, sports games confirmed against MLB/ESPN, concerts looked up against setlist.fm.
7. Dedupe groups candidates by `(user_id, event_date, venue_id)`.
8. Load upserts canonical `attended_events` rows + tickets + performers.
9. `sync_runs` row written for retry tracking.

### One-time backfill — three tracks

The full historical sweep runs in three independent passes that converge on `attended_events`:

1. **Auto track (Calendar + Gmail)**: same pipeline as the daily cron, but bypasses the `newer_than:2d` Gmail filter and walks Calendar back to ~2015 (whatever `timeMin` we pick). This catches anything with a digital paper trail. Recommended: `dry_run=true` first, eyeball candidates with `match_confidence < 0.8`, then run for real.

2. **Manual track** — for events with no email/calendar trail. Two bodies of work, both UW football:
   - **UW football 2007–2010** (college years, ~25 home games × 4 seasons ≈ ~100 rows). Sourced from Wikipedia season pages.
   - **UW football 2021–2026** (~6 home games × 5 seasons ≈ ~30 rows). User attends basically every home game via a friend's season-ticket package. Friend purchased the tickets, so no Gmail confirmation and no vendor-generated calendar entry. Recovery strategy: fetch the full UW home schedule from ESPN's college-football endpoint for each season, mark `attended=1` by default, user review-and-flips the misses.

   The manual seeder reads `scripts/data/manual-attending.json` listing `{ event_date, event_type, opponent, notes? }` per game. For the recent bulk-load, a season-shorthand triggers expansion: `{ event_type: 'ncaaf_game', team_id: 264, season: 2024, attendance: 'all_home' }` expands to one row per home game in that season's schedule with `attended=1` defaulted. The script hits ESPN to pull the canonical game record (final score, opponent) then loads.

3. **Email gap-fill (older purchases)**: even pre-2015 Gmail may contain ticket emails. A second auto-track pass with broadened date range (`from:` + `older_than:`) catches these. Lower yield but worth the one-time run.

The three tracks are commutative — run them in any order, dedupe by `(user_id, event_date, venue_id)` handles overlap (e.g., a Husky game with both an old photo memory and a long-buried StubHub email collapses to one row with two source rows in `attended_event_sources`).

## Decisions

| Decision                                                                           | Why                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct `fetch()` to googleapis, not the `googleapis` npm package                   | The package pulls Node-only deps and bloats Workers bundles. One auth helper + a few endpoint callers is ~150 lines.                                                                                                                                                                                                                                                                                          |
| User OAuth refresh token (not service account)                                     | Service accounts can't impersonate `@gmail.com` accounts without a Workspace admin console. Personal Gmail is the only target.                                                                                                                                                                                                                                                                                |
| **Publish OAuth consent screen to "In production"** before relying on the cron     | "Testing" mode expires refresh tokens after 7 days. Personal apps publish without verification (warning click-through is fine).                                                                                                                                                                                                                                                                               |
| Universal JSON-LD parser before per-vendor HTML scrapers                           | One parser covers ~80% of expected ticket volume (TM/AXS/StubHub/SeatGeek). VividSeats + TicketClub HTML work is deferred.                                                                                                                                                                                                                                                                                    |
| Calendar `syncToken` from day one; Gmail `newer_than:2d` query, not `history.list` | Calendar's syncToken is dead simple. Gmail's history API only wins above ~10k messages/day; the query approach is more crash-safe.                                                                                                                                                                                                                                                                            |
| MLB Stats API direct; ESPN unified client for everything else                      | Mirrors data-source stability. MLB is rock-solid; ESPN is "works but unsupported" — single client = single failure mode to detect.                                                                                                                                                                                                                                                                            |
| Sports team data lives in `attended_events.event_data` JSON, not a `teams` table   | Decided in scaffolding. Concerts use the `performers` table (cross-link to listening); team metadata is just JSON.                                                                                                                                                                                                                                                                                            |
| `event_date` is **YYYY-MM-DD in venue local time**, not UTC                        | A 7pm Mariners game on June 15 is unambiguously a "June 15" event. Storing UTC would split late games into the next day on lookup.                                                                                                                                                                                                                                                                            |
| Pre-seed `venues` table with Seattle venues in a migration                         | Saves alias-resolution flakiness on the first backfill run. Adds T-Mobile Park (alias: Safeco Field), Climate Pledge Arena (alias: KeyArena), Lumen Field (aliases: CenturyLink Field, Qwest Field), **Husky Stadium (alias: Alaska Airlines Field at Husky Stadium), Alaska Airlines Arena (alias: Hec Edmundson Pavilion)**, Showbox SoDo, Showbox at the Market, Paramount Theatre, Moore Theatre, Neumos. |
| `event_type` enum includes `ncaaf_game` and `ncaab_game` from day one              | Folded in with the existing pro-leagues set. The college games predate any reliable email trail (2007–2010), so they need a manual-entry path; the schema treats them no differently from MLB games once loaded.                                                                                                                                                                                              |
| Reviews via dry-run + admin endpoint, no separate UI                               | A JSON candidate list returned from `POST /v1/admin/sync/attending?dry_run=true` is enough. The portfolio is the actual UI later.                                                                                                                                                                                                                                                                             |

## Open questions

These are non-blocking — defaults are picked; flag during implementation if any need to change.

1. **Ticket-vendor coverage beyond the named six.** I default-listed Ticketmaster, SeatGeek, TicketClub, AXS, StubHub, VividSeats. If significant historical purchases used other vendors (Brown Paper Tickets, Eventbrite, Tixr, etc.), add them to the Gmail sender allowlist; JSON-LD support is variable.
2. **Pre-2019 Mariners ticket emails using "Safeco Field"** — venue resolver needs the alias from day one (already in the seed migration plan).
3. **Travel-attended games at non-Seattle venues.** The allowlist needs Yankee Stadium, Wrigley Field, etc. — but it's hard to enumerate without seeing the data. Approach: backfill once with the Seattle-only allowlist, then a second pass with a broader "any MLB stadium" matcher that just requires `event_data.league = mlb` to be valid.

4. **UW football 2021–2026 season-tickets bulk-load**: user attends basically every home game via a friend's season-ticket package — no email or vendor calendar entry exists. Recovery is "all-home plus exceptions": fetch the full UW football home schedule from ESPN for each season (~6 games/year × 5 years ≈ 30 rows), mark `attended=1` by default, user review-and-flips the misses. Football only — basketball backfill is out of scope. Folded into Phase 8 alongside UW 2007–2010.
5. **Refund-and-rebuy handling.** If a 2020 game was refunded then rebuilt to a 2021 makeup, the email trail shows two purchases. Default: both records kept; the canonical event is the one with `attended=1`. Acceptable.
6. **OAuth scope minimization.** `gmail.readonly` is the most-restricted scope that lets us read message bodies. Using `gmail.metadata` would dodge Google's "sensitive scope" classification but loses the body which is the entire point. We accept the click-through warning.
7. **NCAAF + NCAAB enum naming.** Settled on `ncaaf_game` and `ncaab_game` (matches the existing `mlb_game`, `nfl_game`, `wnba_game`, `mls_game`, `nba_game` shape — `<league>_game`). The schema includes `ncaab_game` for future-proofing but it's not in scope for v1 manual backfill.

## Follow-up projects

These are intentionally **not** in this project. Each is a clean follow-up once the data is flowing:

- **MCP tools for attending** (`get_attended_events`, `get_attended_season`, `get_attended_event_details`, `get_attending_stats`). Mechanical port of existing tools.
- **Activity feed integration** — surface attended events alongside scrobbles/runs/watches in `/v1/feed`.
- **Image pipeline for the new domain** — team logos (TheSportsDB free), venue photos (Google Places photo API or manual), performer photos (already covered when `lastfm_artist_id` is populated).
- **Portfolio site Mariners 2024 page** in `pat-portfolio` — fetches MLB Stats API + Rewind `/attending/seasons/mlb/2024` + renders the grid.
- **Year-in-review for attending** — most-attended team, total tickets bought, total spent, etc.
