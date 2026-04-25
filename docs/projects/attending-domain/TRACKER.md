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

## Phase 1: Google OAuth foundation

Goal: a single function `getGoogleAccessToken(db, env)` returns a valid access token, with a one-shot CLI to seed the refresh token from my laptop.

### 1.1 — Token table + env vars — DONE

- [x] **1.1.1** `src/db/schema/google.ts` defining `googleTokens` (id, userId, accessToken, refreshToken, expiresAt, scopes, createdAt, updatedAt). Mirrors `strava_tokens` shape.
- [x] **1.1.2** Hand-authored `migrations/0032_google_tokens.sql` (CREATE TABLE IF NOT EXISTS).
- [x] **1.1.3** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` added to `Env` interface (Worker secrets via `wrangler secret put`, not `[vars]` — matches Trakt/Strava pattern).
- [x] **1.1.4** Local migration applied. Lint + typecheck clean.

### 1.2 — Google Cloud Console setup (user-side, one-time)

- [ ] **1.2.1** Create new GCP project ("rewind-attending").
- [ ] **1.2.2** Enable Calendar API and Gmail API.
- [ ] **1.2.3** Configure OAuth consent screen (External, fill required fields, add user email as test user).
- [ ] **1.2.4** **Publish to "In production".** Click through "unverified app" — required to avoid the 7-day refresh-token expiry.
- [ ] **1.2.5** Create OAuth Client ID, type **Desktop app**.
- [ ] **1.2.6** Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as Worker secrets via `wrangler secret put`.

### 1.3 — Auth service — DONE

- [x] **1.3.1** `src/services/google/auth.ts` exporting `getGoogleAccessToken(db, env): Promise<string>`. Caches via `expires_at`; refreshes when within 60s of expiry. Form-encoded POST to `https://oauth2.googleapis.com/token`.
- [x] **1.3.2** Verifies returned `scope` field includes both `calendar.readonly` and `gmail.readonly` on each refresh; throws if not.
- [x] **1.3.3** Unit tests (5 cases): expiry math both directions, successful refresh persists, scope drift throws, 400 from token endpoint propagates.

### 1.4 — One-shot setup CLI — CODE DONE, AWAITING USER RUN

- [x] **1.4.1** `scripts/tools/setup-google.ts` — Authorization Code flow with localhost loopback. Captures code, exchanges for access+refresh, verifies scopes, writes to local or remote D1 via `wrangler d1 execute`.
- [ ] **1.4.2** USER ACTION: complete Phase 1.2 (GCP setup), put creds in `.dev.vars`, then `npx tsx scripts/tools/setup-google.ts`. Confirm row in `google_tokens`.
- [ ] **1.4.3** USER ACTION: same with `--remote` flag once prod is migrated.

### 1.5 — Smoke test — DONE

- [x] **1.5.1** `POST /v1/admin/google/test` (hidden) — refreshes the token and hits `/oauth2/v2/userinfo`, returns `{ email, scopes, expires_at }`. Will validate end-to-end auth once the user runs Phase 1.2 + 1.4.

## Phase 2: Calendar extractor

Goal: `extractCalendarCandidates(db, env, opts)` writes candidate rows to `attended_event_sources` from Google Calendar with allowlist filtering.

### 2.1 — Calendar client

- [ ] **2.1.1** `src/services/google/calendar-client.ts` with `listCalendarEvents(accessToken, opts)`. Handles `pageToken` pagination + 410-on-syncToken recovery (clear stored token, full re-pull).
- [ ] **2.1.2** Stores `nextSyncToken` in `sync_runs` row with `domain='attending', sync_type='calendar_sync_token'`.
- [ ] **2.1.3** Unit tests with mocked fetch: full pull, syncToken pull, pagination, 410 recovery.

### 2.2 — Allowlist matcher

- [ ] **2.2.1** `src/services/attending/allowlist.ts` exporting `TEAM_KEYWORDS` and `VENUE_KEYWORDS` constants per DESIGN.md. Includes Mariners, Seahawks, Storm, Sounders, Kraken, **Huskies (football + basketball)**, plus full Seattle venue list including Husky Stadium / Alaska Airlines Field at Husky Stadium / Alaska Airlines Arena.
- [ ] **2.2.2** `matchesAllowlist(summary: string, location: string | null): boolean` — case-insensitive substring scan.
- [ ] **2.2.3** Unit tests: positive (each keyword) + negative (random calendar entries don't match).

### 2.3 — Calendar extractor

- [ ] **2.3.1** `src/services/attending/extract.ts → extractCalendarCandidates()`. For each matching event, INSERT into `attended_event_sources` with `source_type='gcal'`, `source_ref=<event.id>`, `raw_data=JSON.stringify(event)`. ON CONFLICT DO NOTHING (re-runs are idempotent).
- [ ] **2.3.2** Wire into `services/attending/backfill.ts` so the existing admin endpoint can run it (`source: 'gcal'`).
- [ ] **2.3.3** Run against real account: `POST /v1/admin/sync/attending {"source":"gcal","dry_run":true,"from":"2015-01-01"}`. Eyeball results, sanity-check counts.

## Phase 3: Gmail extractor + JSON-LD parser

Goal: every ticket-confirmation email matching the vendor allowlist is decoded into a `ParsedReservation` (or null + logged for review).

### 3.1 — Gmail client

- [ ] **3.1.1** `src/services/google/gmail-client.ts → listGmailMessages(accessToken, query, opts)` and `getGmailMessage(accessToken, id)`. Walks MIME tree; base64url-decode helper.
- [ ] **3.1.2** Vendor sender allowlist constant (`VENDOR_SENDERS`) in `services/attending/allowlist.ts`. Builds the Gmail query string from it.
- [ ] **3.1.3** Subject-line gate function — accept patterns + reject patterns.
- [ ] **3.1.4** Unit tests: MIME walker (single-part, multi-part, nested multipart), base64url edge cases, subject gate.

### 3.2 — Universal JSON-LD parser

- [ ] **3.2.1** `src/services/attending/parse-jsonld.ts → parseEventReservationFromHtml(html, vendor)`. Returns `ParsedReservation[] | null`.
- [ ] **3.2.2** Handles single-object, array, and `@graph`-wrapped JSON-LD shapes.
- [ ] **3.2.3** Multi-seat expansion: if one EventReservation has an array of `reservedTicket` entries (SeatGeek pattern), emit N rows.
- [ ] **3.2.4** Edge cases: AXS "Mobile Entry" string for `seatNumber` → null; missing `priceCurrency` → "USD"; malformed JSON → catch and return null for that block (not throw).
- [ ] **3.2.5** Fixture-based tests: real (anonymized) emails from Ticketmaster, AXS, StubHub, SeatGeek. At least 2 per vendor (single-seat + multi-seat).

### 3.3 — Gmail extractor

- [ ] **3.3.1** `extractGmailCandidates()` in `src/services/attending/extract.ts`. Loops `listGmailMessages` pages, fetches each with `getGmailMessage`, applies subject gate, runs JSON-LD parser, INSERT to `attended_event_sources` with `source_type='gmail'`, `source_ref=<message.id>`, `raw_data=ParsedReservation` (or the raw HTML if parser returned null + a `parse_error` field).
- [ ] **3.3.2** Wire into `backfill.ts` (`source: 'gmail'`).
- [ ] **3.3.3** Run against real account: `POST /v1/admin/sync/attending {"source":"gmail","dry_run":true}`. Confirm we get reasonable hit rates from each vendor.

### 3.4 — Per-vendor HTML scrapers (DEFERRED — only if Phase 3.3 dry-run shows gaps)

- [ ] **3.4.1** `src/services/attending/parse-vivid.ts` — labeled-regex extractor. Test fixtures.
- [ ] **3.4.2** `src/services/attending/parse-ticketclub.ts` — same pattern. Test fixtures.
- [ ] **3.4.3** Wire into `extractGmailCandidates`: try JSON-LD first, fall back to vendor-specific scraper based on sender.

## Phase 4: Match + enrich pipeline

Goal: every candidate from Phase 2/3 has a resolved venue and (where applicable) a confirmed sports-game record or concert setlist.

### 4.1 — Venue seed migration

- [ ] **4.1.1** `migrations/0033_seed_venues.sql` — INSERT INTO venues for the Seattle venue set in DESIGN.md, with `aliases` populated. Use INSERT OR IGNORE so re-applying is safe.

### 4.2 — Venue resolver

- [ ] **4.2.1** `src/services/attending/match.ts → resolveVenue(rawName: string, db): Promise<{ venue_id: number; confidence: number }>`. Direct match → 1.0; alias match → 1.0; auto-create fallback → 0.5.
- [ ] **4.2.2** Unit tests including the Safeco→T-Mobile, KeyArena→Climate Pledge alias paths.

### 4.3 — MLB Stats client

- [ ] **4.3.1** `src/services/sports/mlb-client.ts → getMlbGame(date: string, teamId: number): Promise<MlbGameMatch | null>`. Hits `statsapi.mlb.com/api/v1/schedule?teamId={id}&date={YYYY-MM-DD}`. Filters to the home/away-matching game.
- [ ] **4.3.2** Returns canonical record: `{ gamePk, home_team, away_team, home_score, away_score, my_team_won, season, gameType, innings }`.
- [ ] **4.3.3** UTC-to-Pacific conversion for `gameDate` → `event_date` (game-day in venue local).
- [ ] **4.3.4** Fixture tests for: regular-season win, regular-season loss, doubleheader (both games), postseason game.

### 4.4 — ESPN unified client

- [ ] **4.4.1** `src/services/sports/espn-client.ts → getEspnGame(league: EspnLeague, date: string, teamId: number)`. Discriminated union on league.
- [ ] **4.4.2** Returns canonical record matching the MLB shape (use a common `SportsGameMatch` type so the loader doesn't care which league).
- [ ] **4.4.3** Fixture tests across all six leagues: NFL, college-football (UW), NBA, WNBA, college-basketball (UW), MLS.
- [ ] **4.4.4** Try/catch wrapper that logs `[WARN] ESPN endpoint returned non-200 — game unenriched` and returns null. Pipeline doesn't fail on ESPN flake.

### 4.5 — setlist.fm client

- [ ] **4.5.1** Apply for setlist.fm API key (web form at setlist.fm/settings/api). Add `SETLIST_FM_API_KEY` to env vars + Worker secrets.
- [ ] **4.5.2** `src/services/setlist/client.ts → getSetlist(artistName: string, date: string)`. **DD-MM-YYYY** date format conversion. 2-req/sec throttle (use the existing rate-limit pattern or a tiny sleep).
- [ ] **4.5.3** Fixture tests with cached responses.

### 4.6 — Performer resolver

- [ ] **4.6.1** `resolvePerformer(name: string, mbid: string | null, db)` per DESIGN.md (mbid → exact-name → cross-domain probe to lastfm_artists → auto-create).
- [ ] **4.6.2** Unit tests for each fall-through tier.

### 4.7 — Match orchestrator

- [ ] **4.7.1** `services/attending/match.ts → enrichCandidate(candidate, db, env)` that runs venue resolution, then sports OR concert enrichment based on inferred event_type, returns enriched candidate.
- [ ] **4.7.2** Event-type inference: keyword-based (Mariners → mlb_game, Huskies + football season → ncaaf_game, etc.). Unit tests for each league.

## Phase 5: Dedupe + load

Goal: candidates collapse correctly into canonical `attended_events` rows; loader is idempotent.

### 5.1 — Dedupe

- [ ] **5.1.1** `services/attending/dedupe.ts → dedupeKey(candidate)` per DESIGN.md.
- [ ] **5.1.2** `mergeCandidates(candidates: CandidateEvent[]): CanonicalEvent[]` — groups by key, merges fields (most-specific datetime, union of source rows).
- [ ] **5.1.3** Unit tests: calendar+email same-event collapse, MLB doubleheader stays separate, festival multi-day stays separate.

### 5.2 — Loader

- [ ] **5.2.1** `services/attending/load.ts → loadCanonicalEvent(canonical, db)`. Single transaction: venue → performers → attended_events → attended_event_performers → attended_event_tickets → attended_event_sources.
- [ ] **5.2.2** Upsert semantics per DESIGN.md (ON CONFLICT for sports, ON CONFLICT DO NOTHING for tickets).
- [ ] **5.2.3** Unit tests: insert new, update existing, ticket dedupe, source-trace promotion.

### 5.3 — Pipeline glue

- [ ] **5.3.1** `services/attending/backfill.ts` — replace stub with the real orchestrator that runs extract → parse → match → dedupe → load. Returns the `BackfillResult` shape that's already defined.
- [ ] **5.3.2** End-to-end test against fixture set: 5 calendar events + 10 emails → expected `attended_events` rows.

## Phase 6: Cron wiring + health

- [ ] **6.1** Add `0 4 * * *` case in `src/index.ts → scheduled`. Calls `backfillAttending` with `mode: 'incremental'`. Wraps in try/catch with `[ERROR] Attending sync failed: ...` log.
- [ ] **6.2** Add to `wrangler.toml` `triggers.crons` if not auto-registered (check existing pattern).
- [ ] **6.3** Register `attending` in `lib/sync-retry.ts` `shouldRetry` valid-domain check.
- [ ] **6.4** Update `/v1/health/sync` to include attending — show last successful run, consecutive failures, last sync timestamp.
- [ ] **6.5** Smoke test: `wrangler dev` triggers the cron locally; verify it runs end-to-end without error.

## Phase 7: Review surface

- [ ] **7.1** Modify `POST /v1/admin/sync/attending` so `dry_run=true` returns the candidate list with their match confidence and source provenance, rather than just a count. JSON-shape: `{ candidates: [{ event_date, title, venue, source_type, source_ref, match_confidence, would_create_new_event }] }`.
- [ ] **7.2** Admin endpoint `POST /v1/admin/attending/candidates/:id/promote` and `/reject` to manually approve a low-confidence candidate or drop it.
- [ ] **7.3** Document the workflow in DESIGN.md (which exists already — link it from here).

## Phase 8: Manual-entry path (UW football 2007–2010 + similar gaps)

- [ ] **8.1** Curate `scripts/data/manual-attending.json` for UW football home games attended 2007–2010. Reference: Wikipedia season pages (`2007 Washington Huskies football team`, etc.). Per-row: `{ event_date, event_type: 'ncaaf_game', team_id: 264, opponent, is_home: true, notes? }`. Estimate: ~100 rows.
- [ ] **8.2** Admin endpoint `POST /v1/admin/sync/attending/manual-import` that reads the JSON, hits ESPN for each row to pull canonical record, upserts. Returns `{ loaded: N, unmatched: [...] }`.
- [ ] **8.3** `scripts/tools/import-manual-attending.ts` thin wrapper that POSTs the file.
- [ ] **8.4** Run it; resolve any unmatched rows by hand.
- [ ] **8.5** **Decide**: scope-creep check — does basketball 2007–2010 also get a manual list? Or defer? (DESIGN open question.)

## Phase 9: Backfill execution

This is the moment of truth — the schema, parsers, and enrichment all converge on a real database.

- [ ] **9.1** `wrangler d1 execute rewind-db --remote` to apply migrations 0032 + 0033 to prod.
- [ ] **9.2** Seed Google refresh token to remote D1 via the Phase 1.4 setup script with `--remote`.
- [ ] **9.3** **Auto track — calendar full pull**: `POST /v1/admin/sync/attending {"source":"gcal","dry_run":true,"from":"2015-01-01","to":"2026-12-31"}`. Eyeball candidate count by year. Run for real.
- [ ] **9.4** **Auto track — Gmail full pull**: same with `source:gmail`. Higher candidate volume; spend more time on the dry-run review. Run for real.
- [ ] **9.5** **Manual track**: `POST /v1/admin/sync/attending/manual-import` for UW 2007–2010.
- [ ] **9.6** **Email gap-fill**: `POST /v1/admin/sync/attending {"source":"gmail","dry_run":true,"from":"2010-01-01","to":"2014-12-31"}`. Catches anything pre-2015 that's still in Gmail.
- [ ] **9.7** Spot-check via the read endpoints:
  - `GET /v1/attending/seasons/mlb/2024` — does the W/L count look right?
  - `GET /v1/attending/seasons/ncaaf/2008` — UW games show up?
  - `GET /v1/attending/stats` — totals by year/category make sense?
- [ ] **9.8** Mark any obviously wrong rows (`attended=0` for tickets I didn't use, etc.) via direct DB or the admin endpoint.

## Phase 10+ — Follow-up projects (NOT in this project)

Each gets its own `docs/projects/<name>/` doc when started:

- [ ] **MCP tools for attending** — `get_attended_events`, `get_attended_season`, `get_attending_stats`, etc. Mechanical port from existing tool patterns.
- [ ] **Activity feed integration** — surface attended events alongside scrobbles/runs/watches in `/v1/feed`.
- [ ] **Image pipeline for attending** — team logos (TheSportsDB), venue photos (Google Places photo API), performer photos (already covered by `lastfm_artist_id` link).
- [ ] **Portfolio site Mariners 2024 page** in `pat-portfolio` — fetches MLB Stats API + `/v1/attending/seasons/mlb/2024`. Generalize to other team/year combos.
- [ ] **Portfolio UW 2008 season page** — same pattern, different league.
- [ ] **Year-in-review for attending** — most-attended team/venue, total tickets bought, total spent.
