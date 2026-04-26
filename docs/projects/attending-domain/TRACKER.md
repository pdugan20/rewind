# Attending Domain — Task Tracker

Legend: [ ] pending, [x] done, [~] in progress.

Phases are designed to ship independently — each delivers verifiable value (tests pass, an admin endpoint returns real data) on its own. Earlier phases gate later ones; within a phase, sub-tasks usually parallelize.

## Phase 0: Scaffolding — DONE (commit aba384e)

- [x] **0.1** `src/db/schema/attending.ts` — venues, performers, attended_events, attended_event_performers, attended_event_tickets, attended_event_sources
- [x] **0.2** `migrations/0031_attending_domain.sql` — hand-authored to match the project's IF-NOT-EXISTS convention
- [x] **0.3** `src/routes/attending.ts` — GET /events, /events/:id, /seasons/:league/:season, /venues, /stats
- [x] **0.4** `POST /v1/admin/sync/attending` — wired to `services/attending/backfill.ts` stub
- [x] **0.5** `Attending` tag in OpenAPI metadata; snapshots regenerated
- [x] **0.6** Local migration applied (`npm run db:migrate`)
- [ ] **0.7** Remote migration applied (`npm run db:remote`) — gated on Phase 1+ readiness, no point applying to prod until ingestion works

## Phase 1: Google OAuth foundation — DONE LOCALLY (commits 2100971, de082da)

Goal: a single function `getGoogleAccessToken(db, env)` returns a valid access token, with a one-shot CLI to seed the refresh token from my laptop.

Verified end-to-end against `dugan.pat@gmail.com` — smoke endpoint returned email + `messages_total: 216591` + both required scopes. Production seed is consolidated into Phase 9 (no point doing it before there's a cron that reads the token).

### 1.1 — Token table + env vars — DONE

- [x] **1.1.1** `src/db/schema/google.ts` defining `googleTokens` (id, userId, accessToken, refreshToken, expiresAt, scopes, createdAt, updatedAt). Mirrors `strava_tokens` shape.
- [x] **1.1.2** Hand-authored `migrations/0032_google_tokens.sql` (CREATE TABLE IF NOT EXISTS).
- [x] **1.1.3** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` added to `Env` interface (Worker secrets via `wrangler secret put`, not `[vars]` — matches Trakt/Strava pattern).
- [x] **1.1.4** Local migration applied. Lint + typecheck clean.

### 1.2 — Google Cloud Console setup (user-side, one-time) — DONE

- [x] **1.2.1** GCP project "rewind-attending" created.
- [x] **1.2.2** Calendar API + Gmail API enabled.
- [x] **1.2.3** OAuth consent screen configured via the new "Google Auth Platform" wizard (Branding + Audience + Data Access + Clients pages — Google rebranded the old single-page flow). Both scopes added under Data Access.
- [x] **1.2.4** Audience → **Publish App** clicked → status "In production." Verified screenshot. (Avoids the 7-day refresh-token expiry trap.)
- [x] **1.2.5** Desktop OAuth client "rewind-attending-desktop" created; client_id/secret extracted from downloaded JSON, JSON deleted from `~/Downloads`.
- [ ] **1.2.6** DEFERRED to Phase 9: `wrangler secret put GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` for prod. Local uses `.dev.vars` (already populated).

### 1.3 — Auth service — DONE

- [x] **1.3.1** `src/services/google/auth.ts` exporting `getGoogleAccessToken(db, env): Promise<string>`. Caches via `expires_at`; refreshes when within 60s of expiry. Form-encoded POST to `https://oauth2.googleapis.com/token`.
- [x] **1.3.2** Verifies returned `scope` field includes both `calendar.readonly` and `gmail.readonly` on each refresh; throws if not.
- [x] **1.3.3** Unit tests (5 cases): expiry math both directions, successful refresh persists, scope drift throws, 400 from token endpoint propagates.

### 1.4 — One-shot setup CLI — DONE (LOCAL)

- [x] **1.4.1** `scripts/tools/setup-google.ts` — Authorization Code flow with localhost loopback. Bug fix in `de082da`: capture redirect URI before `server.close()` (address() returns null after close).
- [x] **1.4.2** Ran successfully against local D1. Token row in `google_tokens` confirmed; both scopes granted.
- [ ] **1.4.3** DEFERRED to Phase 9: `--remote` flag once prod is migrated.

### 1.5 — Smoke test — DONE + VALIDATED

- [x] **1.5.1** `POST /v1/admin/google/test` (hidden) — refreshes the token and hits `https://gmail.googleapis.com/gmail/v1/users/me/profile`, returns `{ email, messages_total, scopes, expires_at }`. Switched from `/oauth2/v2/userinfo` (commit `de082da`) because that endpoint requires the `userinfo.email` scope which we don't request — Gmail's getProfile is gated by `gmail.readonly` which we do have, and doubles as proof we can read mail. Validated locally: 216k messages accessible.

## Phase 2: Calendar extractor — DONE

Goal: `extractCalendarCandidates(db, env, opts)` writes candidate rows to `attended_event_sources` from Google Calendar with allowlist filtering.

**Validated against real calendar**: 8-year dry-run scanned 8,882 events, matched 53 candidates across Mariners, Seahawks, Huskies, concerts. Non-dry-run idempotent (run-twice → `inserted: 1`, then `inserted: 0` via `.onConflictDoNothing()`).

**Side observation captured**: Google Calendar auto-extracts SeatGeek confirmation emails into the event description (e.g. "Reservation Number: 6P2-8YP454J\nProvider: SeatGeek\nGuests: ...\nSeats: 18, 19, 20"). For events with this enrichment, ticket data is recoverable from calendar alone — no email parser needed. Folded into Phase 3 plan.

### 2.1 — Calendar client — DONE

- [x] **2.1.1** `src/services/google/calendar-client.ts` with `listCalendarEvents(accessToken, opts)`. Pagination via `nextPageToken`; 410-on-syncToken throws `CalendarSyncTokenExpiredError`.
- [x] **2.1.2** `src/services/google/calendar-sync-token.ts` reads/writes the token via `sync_runs` rows (domain='attending', sync_type='calendar_sync_token', metadata JSON).
- [x] **2.1.3** Unit tests (6 cases): range pull, syncToken pull, 410 recovery, non-200 with body, multi-page drain, sparse-fields tolerance.

### 2.2 — Allowlist matcher — DONE

- [x] **2.2.1** `src/services/attending/allowlist.ts` with `TEAM_KEYWORDS`, `VENUE_KEYWORDS`, `VENDOR_SENDERS`. Full Seattle venue set including Husky Stadium aliases.
- [x] **2.2.2** `matchesAllowlist(summary, location)` — case-insensitive substring scan over both fields.
- [x] **2.2.3** 43 unit tests: every keyword positive-matches as both summary and location, plus negative cases (lunch, dentist, project review).

### 2.3 — Calendar extractor — DONE

- [x] **2.3.1** `src/services/attending/extract.ts → extractCalendarCandidates()`. Filters allowlist, drops cancelled events, inserts via `.onConflictDoNothing()` on `(source_type, source_ref)`. Self-heals on syncToken expiry (range fallback + token rewrite).
- [x] **2.3.2** Wired into `services/attending/backfill.ts`. Admin endpoint `POST /v1/admin/sync/attending` returns the `gcal` envelope with scan/match/insert counts and (for dry runs) the candidate list.
- [x] **2.3.3** Validated against real account. Found expected events including a Mariners game with full SeatGeek ticket data in the calendar description.

## Phase 3: Gmail extractor — DONE (with reality-check pivot)

Goal: every ticket-confirmation email matching the vendor allowlist is captured to `attended_event_sources` (with full body), parsed when we have a vendor parser.

**Reality check during validation**: zero of the six vendors include JSON-LD in their actual confirmation emails (research from earlier was wrong). Pivoted to:

- Domain-level Gmail filter (`from:@ticketmaster.com`) — survives sender-address rotation. Specific-address allowlists drifted between research and reality (SeatGeek confirmations come from `transactions@`, not `orders@`; AXS uses `axs@axs.com`, not `customer.service@`; etc.). DESIGN.md captures the brittleness analysis.
- Per-vendor labeled-text parsers — labeled-regex over the text/plain body. SeatGeek done; others can be added incrementally as the backfill exposes the formats.
- All confirmation emails captured (with body_text up to 12KB) even when parsing produces zero reservations, so future parsers can re-run without re-fetching from Gmail.

**Validated end-to-end**: 90-day dry-run scanned 13 confirmations, 4 fully parsed (3 SeatGeek seats from a Mariners game with venue + section/row/seat + total $72.90), 9 captured with raw bodies for follow-up parsers.

### 3.1 — Gmail client — DONE

- [x] **3.1.1** `src/services/google/gmail-client.ts` with `listGmailMessages` + `getGmailMessage`. MIME walker handles single-part, multi-part, and nested multipart payloads. base64url decoder via `atob` + URL-char swap.
- [x] **3.1.2** Replaced `VENDOR_SENDERS` with **`VENDOR_DOMAINS`** in allowlist.ts. `buildGmailVendorQuery()` produces `from:(@ticketmaster.com OR @seatgeek.com OR ...)`.
- [x] **3.1.3** `judgeSubject()` 3-way classifier: accept / reject / uncertain. Reject patterns drop reminders, transfers, refunds, surveys, marketing.
- [x] **3.1.4** Unit tests (23 cases): MIME walker shapes, base64url edge cases, subject gate full coverage.

### 3.2 — Universal JSON-LD parser — DONE

- [x] **3.2.1** `parse-jsonld.ts → parseEventReservationFromHtml(html, vendor)`. Returns `ParsedReservation[] | null`.
- [x] **3.2.2** Handles single-object, array, and `@graph`-wrapped JSON-LD shapes.
- [x] **3.2.3** Multi-seat expansion: SeatGeek's array-of-reservedTicket pattern → N rows.
- [x] **3.2.4** Edge cases: AXS "Mobile Entry" → null seat; missing `priceCurrency` → "USD"; malformed JSON → swallow per block, keep going.
- [x] **3.2.5** 21 unit tests covering all shapes + multi-seat + vendor inference. **Plus parser stays in place even though no current vendor uses it** — costs nothing, ready if any vendor adds JSON-LD support.

### 3.3 — Calendar-description parser (tier-0) — DONE

- [x] **3.3.1** `parse-calendar-description.ts` extracts `Reservation Number`, `Provider`, `Seats`, `Section`, `Row`, `Total` from Google Calendar's auto-enriched event descriptions. Tested against the real Mariners SeatGeek pattern observed in Phase 2.
- [x] **3.3.2** 9 unit tests. Tier-0 because for cron-going-forward this is the most robust path — Google maintains the email-markup parser, not us.

### 3.4 — Gmail extractor + first per-vendor parser — DONE

- [x] **3.4.1** `extractGmailCandidates()` in `extract.ts`. Subject-gates messages, walks the JSON-LD path then per-vendor text path, INSERTs every confirmation to `attended_event_sources` (with body_text capped at 12KB) regardless of parse success.
- [x] **3.4.2** `parse-seatgeek.ts` + 5 fixture tests. Anchors parsing to the post-"Order Details" block to avoid false-matches in marketing prose.
- [x] **3.4.3** Wired into `backfill.ts`. Admin endpoint returns the `gmail` envelope with `scanned/fetched/parsed/skipped_subject/skipped_no_jsonld` counts and the per-message candidates list (in dry-run).
- [x] **3.4.4** Validated against real account: 90-day dry-run found 13 confirmations across vendors. 4 fully parsed (all SeatGeek). 9 captured with body for future parsers.

### 3.5 — Additional per-vendor parsers — DONE

All five parsers shipped with real-fixture validation. Each handles
multiple template generations observed in the inbox (legacy + modern).

- [x] **3.5.1** `parse-ticketclub.ts` — handles legacy 2018 (labeled
      lines, "Saturday, Oct 27 2018 at Time TBD") and modern 2025 (inline
      Section/Row/Qty • bullets, "@" date separator) layouts. 15 tests.
      Reprocess result: 75 newly_parsed → 27 new events loaded (Mariners
      4→8 in 2024, +13 concerts).
- [x] **3.5.2** `parse-ticketmaster.ts` — handles legacy 2018 (RÜFÜS
      DU SOL, "Tue, Nov 06 2018 - 8:00 PM") and modern 2019+ (Mariners,
      "Thu • May 16 2019 • 7:10 PM" bullets). Covers official Ticketmaster
  - team-branded sub-brands (Mariners Fancare). 8 tests. Reprocess
    result: 5 new events loaded.
- [x] **3.5.3** `parse-axs.ts` — "Your confirmation number is X" anchor
      with "scheduled on YYYY-MM-DD HH:MM" date. 3 events loaded.
- [x] **3.5.4** `parse-vivid.ts` — "Order #\n<num>" + "Section: X Row: Y"
      inline. 1 event loaded.
- [x] **3.5.5** `parse-stubhub.ts` — distinctive single-line "EVENT at
      VENUE, City" format. 2 events loaded.

### 3.5.x — Reprocess endpoint — DONE

- [x] `POST /v1/admin/attending/reprocess?vendor=<domain>` re-runs
      parsers + enrich + load over pending source rows. Has `refetch_missing_body`
      flag to re-pull from Gmail when body data is absent (required for
      rows captured before Phase 9.5 added body_html storage). Used after
      every new parser ships.

### 3.5 — Subject-gate hardening

- [x] Added 14 new reject patterns observed during Phase 9: "on sale",
      "special offers", "see it live", "on tour", "vip package",
      "verified fan", "sign in activity", "password has been updated",
      "request to reset password", "chances to win", "how likely are you",
      "how was it", "rate your experience", "tell us about". Removes ~88
      Ticketmaster marketing emails per backfill pass.

## Phase 4: Match + enrich pipeline — DONE

Goal: every candidate from Phase 2/3 has a resolved venue and (where applicable) a confirmed sports-game record or concert setlist.

**Validated end-to-end against real calendar**: 2024 UW football season fully enriched (Apple Cup 19-24 loss to WSU, USC OT win 26-21, Michigan 27-17 W, etc.) plus Mariners games with scores, all from MLB Stats API + ESPN — zero hand-tuning required for any season-tickets-style schedule.

### 4.1 — Venue seed migration — DONE

- [x] **4.1.1** `migrations/0033_seed_venues.sql` — 14 Seattle venues with aliases (Safeco Field → T-Mobile Park, KeyArena → Climate Pledge, CenturyLink/Qwest → Lumen, Hec Ed → Alaska Airlines Arena, etc.). `INSERT OR IGNORE` for safe re-apply.

### 4.2 — Venue resolver — DONE

- [x] **4.2.1** `src/services/attending/match.ts → resolveVenue()`. Tiered: exact name → alias exact → substring fallback → auto-create. Confidence levels 1.0 / 0.95 / 0.85 / 0.5.
- [x] **4.2.2** 14 unit tests including all alias paths and the calendar-location-format cleanup.

### 4.3 — MLB Stats client — DONE

- [x] **4.3.1** `src/services/sports/mlb-client.ts → getMlbGamesByDate(date, teamId)`. Hits `statsapi.mlb.com/api/v1/schedule?teamId={id}&date={YYYY-MM-DD}&sportId=1`.
- [x] **4.3.2** Returns canonical `SportsGameMatch[]` (typically 1, but supports doubleheaders).
- [x] **4.3.3** Uses MLB's `officialDate` field which is venue-local — no UTC conversion needed.
- [x] **4.3.4** 5 fixture tests + live-validated against real Mariners game (746331 vs Astros 2024-09-25).

### 4.4 — ESPN unified client — DONE

- [x] **4.4.1** `src/services/sports/espn-client.ts → getEspnGamesByDate(league, date, teamId)`. Discriminated union via `ESPN_LEAGUES` constant.
- [x] **4.4.2** Returns the same `SportsGameMatch` shape as MLB so the loader is league-agnostic.
- [x] **4.4.3** 7 fixture tests across all six leagues + live-validated against UW Huskies 2008 (Notre Dame 33-7 loss) and 2024 Apple Cup.
- [x] **4.4.4** Caller wraps in try/catch (in `enrich.ts → enrichSports`) — ESPN failure logs and returns null; pipeline keeps moving.

### 4.5 — setlist.fm client — DONE (key gated)

- [x] **4.5.1** Schema + env wiring. `SETLIST_FM_API_KEY` is optional in `Env`; client returns null when absent so concerts load without enrichment.
- [x] **4.5.2** `src/services/setlist/client.ts → searchSetlist()`. DD-MM-YYYY conversion via `toSetlistDate()`. Returns `SetlistMatch` with setlist URL, tour, venue.
- [x] **4.5.3** 9 fixture tests including the date-format gotcha and 404-no-match handling.
- [ ] **USER ACTION**: apply for free API key at https://www.setlist.fm/settings/api when ready to enrich concerts. Add to `.dev.vars` then re-run dry-run on concert candidates.

### 4.6 — Performer resolver — DONE

- [x] **4.6.1** `resolvePerformer()` in match.ts. Tiered: mbid → exact name → **cross-domain probe to lastfm_artists** → auto-create.
- [x] **4.6.2** 5 unit tests covering each tier including the cross-domain link (creates `performers` row with `lastfm_artist_id` populated when artist already exists in listening domain).

### 4.7 — Match orchestrator — DONE

- [x] **4.7.1** `src/services/attending/enrich.ts → enrichCandidate()`. Resolves venue, infers event_type, dispatches to sports or concert enricher, returns `CanonicalEvent`.
- [x] **4.7.2** Event-type inference covers all 7 leagues + Husky football/basketball venue disambiguation. 18 unit tests.
- [x] **4.7.3** Wired into `backfill.ts` as a dry-run-only preview path (caps at 20 candidates per call). Live test confirmed end-to-end pipeline working: 6 UW football games of 2024 fully matched with scores + opponents.

## Phase 5: Dedupe + load — DONE

Goal: candidates collapse correctly into canonical `attended_events` rows; loader is idempotent.

**Validated end-to-end against real D1**: ran the full pipeline on Aug-Dec 2024 — wrote 10 attended_events rows (6 UW football + 2 Mariners + 2 concerts), all sources linked back, second run produced 0 inserts + 10 updates (idempotent). The `/v1/attending/seasons/ncaaf/2024` endpoint returned the season summary cleanly: `{ attended_count: 6, wins: 5, losses: 1, data: [...] }`.

### 5.1 — Dedupe — DONE (folded into loader)

- [x] **5.1.1** Dedupe key built into `findExistingEvent()` in load.ts: `(external_source, external_id)` first, falling back to `(user_id, event_date, venue_id)`. No separate dedupe.ts file — the merge logic happens at upsert-time inside the loader.
- [x] **5.1.2** Cross-source merge handled by re-runs: calendar candidate inserts → next run with email finds the same row by date+venue and updates rather than duplicating. Validated by re-running Phase 5 live test (10 inserted, 10 updated on second pass, total still 10).
- [x] **5.1.3** Test coverage in `load.test.ts`: insert path, update-by-external-id, source linkage, performer/ticket dedupe.

### 5.2 — Loader — DONE

- [x] **5.2.1** `services/attending/load.ts → loadCanonicalEvent(canonical, tickets, sourceRefs, db)`. INSERT or UPDATE attended_events; INSERT performers + tickets with `.onConflictDoNothing()`; UPDATE attended_event_sources to link `event_id` back.
- [x] **5.2.2** Upsert semantics: dedupe match → UPDATE with COALESCE-style merge (existing values preserved unless candidate has strictly-better data). Tickets dedupe on `(vendor, order_id)`. Performers dedupe on `(event_id, performer_id)`.
- [x] **5.2.3** 8 unit tests covering insert/update/ticket-dedupe/performer-link/source-link/category-coercion paths.

### 5.3 — Pipeline glue — DONE

- [x] **5.3.1** `services/attending/backfill.ts` runs extract → enrich → load on non-dry-run. Per-candidate try/catch so one failure doesn't kill the batch. Internal candidate buffers (gcalCandidates / gmailCandidates) keep the in-memory list separate from the dry-run-only response field.
- [x] **5.3.2** End-to-end live validation: Aug-Dec 2024 calendar pull wrote 10 canonical events with full sports enrichment; admin endpoint returns `load: { enriched: 10, inserted: 10, updated: 0, failed: 0 }`. Re-running same window produced `inserted: 0, updated: 10` confirming idempotency.

## Phase 6: Cron wiring + health — DONE

- [x] **6.1** `0 4 * * *` case in `src/index.ts → scheduled`. Calls `backfillAttending(db, env, { source: 'all', mode: 'incremental' })`. Wraps in `.catch()` with `[ERROR] Attending sync failed: ...` log.
- [x] **6.2** Added `"0 4 * * *"` entry to `wrangler.toml` `triggers.crons` array.
- [x] **6.3** `shouldRetry` doesn't have a hard-coded valid-domain list — calling `shouldRetry(db, 'attending')` works as-is. **Note**: the calendar_sync_token rows we write to `sync_runs` are filtered out of `/v1/health/sync` via a `METADATA_SYNC_TYPES` exclusion list, so they don't mask the real cron sync status. `backfillAttending` now writes its own `sync_runs` row at start (`status='running'`) and updates to `completed`/`failed` at end.
- [x] **6.4** `DOMAINS` list in `system.ts` includes `attending`. `/v1/health/sync` filters out metadata sync types so the surfaced status reflects actual cron health.
- [x] **6.5** Smoke test passed: `wrangler dev` + `curl /cdn-cgi/handler/scheduled?cron=0+4+*+*+*` triggered the cron, full pipeline ran end-to-end, 61 events loaded, `/v1/health/sync` shows `attending: status=completed, sync_type=incremental, items=61`.

## Phase 7: Review surface — DONE

- [x] **7.1** `POST /v1/admin/sync/attending` with `dry_run: true` returns the enriched candidate list with `match_confidence`, source provenance, and event_data. (Already in place from Phase 4 wiring.)
- [x] **7.2** Three new admin endpoints in `src/routes/admin-attending.ts`:
  - `GET /v1/admin/attending/pending?source_type=&limit=` — lists `attended_event_sources` rows where `event_id IS NULL`.
  - `POST /v1/admin/attending/sources/:id/promote` — re-runs enrich+load on the source. Optional body `{ title?, event_date?, event_datetime?, location?, performers? }` overrides individual fields when the parser got something wrong. Returns `400` with a helpful error if `event_date` can't be derived.
  - `POST /v1/admin/attending/sources/:id/reject` — hard-deletes the source row (cron's syncToken means we won't re-extract it).
- [x] **7.3** Live-validated:
  - Seeded 11 pending rows from a 90-day Gmail backfill.
  - Rejected a Ticketmaster password-reset email (count 11→10).
  - Promoted a high-confidence SeatGeek confirmation that lacked event_date in its parser output — first call returned 400 with the override hint, second call with `{event_date, location}` succeeded with `action: updated` (deduped against the calendar-loaded event for the same date+venue).

## Phase 8: Manual-entry path (UW football 2007–2010 + 2021–2026 season tickets) — INFRA DONE, USER CURATION PENDING

Two parallel bulk-loads, same import endpoint, different shape. **Football only** — basketball is out of scope.

**Infrastructure validated end-to-end**: live test imported 2024 UW football home season via `attendance: 'all_home'` shorthand with the Apple Cup (2024-09-14) listed as an exception. ESPN team-schedule endpoint returned 7 home games; loader populated all scores correctly (35-3, 30-9, 19-24, 24-5, 27-17, 26-21, 31-19); `/v1/attending/seasons/ncaaf/2024` returned `attended_count=6, W=6, L=0` (the Apple Cup loss correctly excluded from W/L because attended=0).

### 8.1 + 8.2 — UW football coverage scaffold — STARTER FILE READY

User attendance pattern (per user clarification):

- **Undergrad 2007–2010 + grad year 2013**: every home game.
- **SF decade ~2010–2016**: alternating away games at Cal or Stanford (Pac-12 home/away rotation). 2017 Stanford, 2018 Cal, 2019 Stanford already loaded from Ticket Club confirmations.
- **Return to Seattle 2021–2026**: most home games, friend's-tickets pattern.

`scripts/data/manual-attending-uw-football.json` scaffolded with:

- Block A: 5 season-shorthand rows (2007, 2008, 2009, 2010, 2013) with empty `exceptions` arrays for the user to fill if they remember missing any home games.
- Block C: 3 season-shorthand rows (2022, 2023, 2025) for the post-return Seattle years (2024 already in DB from calendar/email; 2026 is in-season).

Block B (per-game SF-decade away games at Cal/Stanford) left to user — Wikipedia "YYYY Washington Huskies football team" pages give the schedule, user picks the Bay Area road game per year.

- [x] **8.1.1** USER ACTION: scaffold reviewed & populated. Run via:
  ```bash
  REWIND_ADMIN_KEY=$ADMIN_KEY npx tsx scripts/tools/import-manual-attending.ts \
    scripts/data/manual-attending-uw-football.json --remote
  ```
  Server-side expansion produces ~30-40 attended_events from the 8 starter rows.
- [ ] **8.1.2** USER ACTION (optional): add per-game Block B rows for 2010-2016 away games at Cal/Stanford. Schema: `{ event_date: 'YYYY-MM-DD', event_type: 'ncaaf_game', team_id: 264, opponent: 'Cal', is_home: false }`. ~5-7 rows.
- [ ] **8.1.3** USER ACTION (optional): for any season-shorthand rows, populate `exceptions: ["YYYY-MM-DD"]` for home games actually missed (sick days, travel, etc.) — `attended` flag flips to 0 for those.

### 8.3 — Shared import endpoint + tooling — DONE

- [x] **8.3.1** `POST /v1/admin/sync/attending/manual-import` accepts an array of mixed per-game and season-shorthand entries. For per-game: hits MLB Stats API (mlb_game) or ESPN team-schedule (everything else) by date+team. For season-shorthand: hits ESPN team-schedule for the full season, filters to home games, expands one row per home game with `attended=0` for dates in `exceptions`.
- [x] **8.3.2** `scripts/tools/import-manual-attending.ts` reads a JSON file and POSTs to the endpoint. Supports `--remote` for prod imports.
- [x] **8.3.3** `getEspnTeamSchedule()` added to `espn-client.ts` so season-shorthand only needs one API call per season instead of 12+. Score-parser extended to handle the schedule endpoint's `{ value, displayValue }` shape (vs the scoreboard endpoint's flat string).
- [x] **8.3.4** Loader handles the ESPN UTC-vs-Pacific TZ off-by-one (per-game lookups accept date OR date+1 to match games stamped at UTC midnight = next day vs venue-local).
- [x] **8.3.5** Season-endpoint W/L count filters to `attended=1` only — your attended record (6-0) instead of the team's record (6-1) when exceptions are flagged.

## Phase 9: Backfill execution against prod — RUNBOOK

All steps are USER ACTIONS. No code changes — this is operational. Phase 8 manual lists need to be curated before 9.5/9.6 run.

### Status — auto-track DONE 2026-04-25

- [x] **9.1** Migrations 0031/0032/0033 applied to remote D1.
- [x] **9.2** GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET set as Worker secrets. Refresh token seeded into remote `google_tokens`.
- [x] **9.3** `POST https://api.rewind.rest/v1/admin/google/test` returned `dugan.pat@gmail.com`, 216592 messages, both scopes — prod auth working end-to-end.
- [x] **9.4** Calendar full pull (2015–2026): scanned 11030, matched 59, loaded 57 + 2 dedupe-updates.
- [x] **9.5** Gmail full pull (2010–2026): scanned 694, fetched 665, parsed 20 (SeatGeek), inserted 4 events + 1 update. 660 sources captured for Phase 3.5 vendor parsers.
- [x] **9.8** Pending review: 660 Gmail sources await per-vendor parsers. Junk-detection done at the subject-gate level (29 rejected before fetch); the 660 are real confirmations that just don't have a parser yet.
- [x] **9.9** Spot-check confirmed: `/v1/attending/seasons/mlb/2024` shows 4 attended games W=2 L=2; `/v1/attending/seasons/ncaaf/2024` shows 6 W=5 L=1 (Apple Cup currently attended=1 per calendar entry — will flip to 0 when manual season-import runs); `/v1/attending/stats` shows 61 events across MLB/NCAAF/NFL/WNBA/NCAAB/concerts spanning 2016–2026.
- [x] **9.10** `/v1/health/sync` shows attending status=completed, sync_type=range, items_synced=4, last_sync recent.
- [ ] **9.6 + 9.7** USER ACTION: manual UW football imports (gated on Phase 8.1.1 / 8.2.1 curation).

---

### 9.1 — Apply migrations to remote D1

```bash
npx wrangler d1 migrations apply rewind-db --remote
```

Should apply `0031_attending_domain`, `0032_google_tokens`, `0033_seed_venues` (additive — safe).

### 9.2 — Set Google secrets + seed prod refresh token

```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
# (paste the same values from .dev.vars)

npx tsx scripts/tools/setup-google.ts --remote
```

Browser opens to Google consent (same flow as local). Token written to remote D1's `google_tokens`.

### 9.3 — Smoke-test prod auth

```bash
curl -X POST https://api.rewind.rest/v1/admin/google/test \
  -H "Authorization: Bearer $ADMIN_KEY"
```

Expect: `{ email, messages_total, scopes, expires_at }` matching the local smoke test.

### 9.4 — Auto track: calendar full historical pull

```bash
# Dry-run first to eyeball
curl -X POST https://api.rewind.rest/v1/admin/sync/attending \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"source":"gcal","dry_run":true,"from":"2015-01-01T00:00:00Z","to":"2026-12-31T23:59:59Z"}'

# Then real:
curl -X POST https://api.rewind.rest/v1/admin/sync/attending \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"source":"gcal","dry_run":false,"from":"2015-01-01T00:00:00Z","to":"2026-12-31T23:59:59Z"}'
```

### 9.5 — Auto track: Gmail full historical pull

Higher volume. Spend extra time on the dry-run review:

```bash
curl -X POST https://api.rewind.rest/v1/admin/sync/attending \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"source":"gmail","dry_run":true,"from":"2010-01-01","to":"2026-12-31"}'
```

Eyeball candidates with `match_confidence < 0.8`. Reject any obvious junk via `POST /v1/admin/attending/sources/:id/reject` (after the real pull writes them). Then run `dry_run: false`.

### 9.6 — Manual import: UW football 2007–2010

Once `scripts/data/manual-attending-uw-2007-2010.json` is curated (Phase 8.1.1):

```bash
REWIND_ADMIN_KEY=$ADMIN_KEY npx tsx scripts/tools/import-manual-attending.ts \
  scripts/data/manual-attending-uw-2007-2010.json --remote
```

### 9.7 — Manual import: UW football 2021–2026 season tickets

Once `scripts/data/manual-attending-uw-recent.json` is curated (Phase 8.2.1):

```bash
REWIND_ADMIN_KEY=$ADMIN_KEY npx tsx scripts/tools/import-manual-attending.ts \
  scripts/data/manual-attending-uw-recent.json --remote
```

### 9.8 — Review pending sources

```bash
curl https://api.rewind.rest/v1/admin/attending/pending?limit=200 \
  -H "Authorization: Bearer $ADMIN_KEY"
```

For each unloaded source row, decide: promote (with overrides if needed) or reject.

### 9.9 — Spot-check via read endpoints

```bash
# Mariners 2024 attended games:
curl https://api.rewind.rest/v1/attending/seasons/mlb/2024 \
  -H "Authorization: Bearer $READ_KEY"

# UW football 2008 (college era):
curl https://api.rewind.rest/v1/attending/seasons/ncaaf/2008 \
  -H "Authorization: Bearer $READ_KEY"

# Aggregate stats:
curl https://api.rewind.rest/v1/attending/stats \
  -H "Authorization: Bearer $READ_KEY"
```

Sanity check: counts make sense, scores look right, attended/unattended split is plausible.

### 9.10 — Confirm cron is running

After 24 hours (one cron tick), check `/v1/health/sync`:

```bash
curl https://api.rewind.rest/v1/health/sync \
  -H "Authorization: Bearer $READ_KEY"
```

Look for `attending: { last_sync: <recent>, status: completed }`.

## Phase 10: MCP tools + season-grid card UI — DONE (#55)

Five tools registered, manifest snapshot bumped 40 → 45, MDX docs added.

- [x] **10.1** `mcp-server/src/tools/attending.ts` — `get_attended_events`, `get_attended_season` (with `_meta.ui.resourceUri`), `get_attended_event`, `get_attended_player`, `get_attending_stats`. Text fallback uses `summarizeAppearance()` for batting/pitching lines.
- [x] **10.2** UI bundle: `mcp-server/web/attended-season.{html,tsx}` + `components/SeasonGrid.tsx` + `components/SeasonGameCard.tsx`. `useApp` + `app.ontoolresult` binding; `app.openLink` for outbound. CSS variables for host theming. Built via vite-plugin-singlefile (455KB inlined HTML).
- [x] **10.3** `registerUiResource('ui://rewind/attended-season.html', ...)` in `server.ts` with CSP allowing `cdn.rewind.rest`.
- [x] **10.4** `mcp-server/scripts/check-docs.mjs` updated: tools added to `domains/attending.mdx`, `ui://rewind/attended-season.html` in `UNDOCUMENTED_ALLOWLIST`.
- [x] **10.5** Tests: `server.test.ts` tool-count assertion bumped to 45; manifest snapshot regenerated via `npm run mcp:update`.

## Phase 11: Activity feed integration — DONE (#57, #61, #62, #63, #64)

Goal: every attended event appears in `/v1/feed`, `/v1/feed/on-this-day`, and `/v1/feed/domain/attending` alongside scrobbles/runs/watches/articles.

**Validated end-to-end**: backfill ran cleanly to 263 attending rows in `activity_feed`; cross-domain feed surfaces attending entries dated correctly; on-this-day pulls them.

- [x] **11.1** `src/services/attending/feed-items.ts` — `feedItemFromCanonical(eventId, canonical, venueName)` and `feedItemFromRow(row)` helpers. Verb is category-aware (`Saw <…>` for sports/music, `Attended <…>` for arts). `sourceId: 'event:{id}'`, `domain: 'attending'`, `eventType: 'event_attended' | 'event_missed'`.
- [x] **11.2** `loadCanonicalEvent` (load.ts) inserts a feed row inline after writing source linkage. Wrapped in try/catch — feed-insert failures are non-fatal (mirrors lastfm/strava pattern).
- [x] **11.3** `src/services/attending/backfill-feed.ts` — one-shot `backfillAttendingFeed(db, opts)` walks `attended_events`, joins venues, and feeds rows into `insertFeedItems`. Exposed via `POST /v1/admin/attending/backfill-feed`.
- [x] **11.4** `insertFeedItems` rewritten to chunk both the dedupe `IN (...)` SELECT (CHUNK=80) and the multi-row INSERT VALUES (CHUNK=8 × 11 cols = 88 params) under D1's ~100-param effective cap. Also dropped the param-heavy pre-count in `backfill-feed` in favor of `count(*)` before/after.
- [x] **11.5** Domain enum on `/v1/feed/domain/{domain}` Zod schema includes `'attending'`; OpenAPI snapshot regenerated.

## Phase 12: Per-game player stats + photos (MLB) — DONE (#51–#54)

Goal: each MLB attended event has per-player batting/pitching/fielding lines + headshots queryable via `get_attended_player` and rendered inline in the season-grid card.

- [x] **12.1** `attended_event_players` writes from MLB Stats `boxscore.teams.{home,away}.players`. Captures batting line, pitching line, fielding line, decision (W/L/SV), batting order.
- [x] **12.2** Player photos: silo (transparent PNG) from `img.mlbstatic.com/.../headshot/silo/current/{id}.png` for every player; ESPN full headshot from `a.espncdn.com/combiner/i?img=/i/headshots/mlb/players/full/{id}.png` cross-referenced from ESPN summary.
- [x] **12.3** Cross-ref scoping (#53, #54): ESPN summary players intersected with the MLB boxscore roster for the same game; first-name-required match dedupes shared last names like Suárez.
- [x] **12.4** PT/UTC date drift handled (#52): ESPN scoreboard stamps games at UTC midnight which is the next day in venue-local; matcher accepts date or date+1.
- [x] **12.5** `images` row promotion fix (`cc6c5b2`): placeholder `image_version` advances 0 → 1 once the real image lands so CDN cache busts properly.

**Result**: 839 unique players, 1,977 game appearances, 100% silo coverage, 60% full ESPN coverage.

## Phase 13+ — Follow-up projects (NOT in this project, tracked in GitHub issues)

Each gets its own `docs/projects/<name>/` doc when started:

- [ ] **Year-in-review for attending** — `/v1/attending/year/{year}` mirroring listening/running.
- [ ] **NFL/NBA/WNBA box scores** — extend MLB enrichment to ESPN-covered leagues for the 13 non-MLB games.
- [ ] **Concert performer photos** — cross-link `lastfm_artist_id` to image so concert detail responses gain artist headshots.
- [ ] **Setlists for concerts** — setlist.fm beyond v1 (opener vs headliner discovery).
- [ ] **ESPN photo backfill** — ~340 unmatched players (mostly relief pitchers).
- [ ] **Team logos / venue photos** — TheSportsDB + Google Places.
- [ ] **Portfolio site Mariners 2024 page** in `pat-portfolio`.
- [ ] **Portfolio UW 2008 season page** — same pattern, different league.
