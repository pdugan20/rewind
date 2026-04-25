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

### 3.5 — Additional per-vendor parsers — FOLLOW-UP (not blocking)

These are pure-function additions; can be written from real fixtures during the Phase 9 backfill review.

- [ ] **3.5.1** `parse-ticketmaster.ts` — Ticketmaster + Mariners Fancare templates.
- [ ] **3.5.2** `parse-axs.ts` — AXS confirmation format.
- [ ] **3.5.3** `parse-stubhub.ts` — StubHub.
- [ ] **3.5.4** `parse-vividseats.ts` — VividSeats.
- [ ] **3.5.5** `parse-ticketclub.ts` — TicketClub.

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

## Phase 8: Manual-entry path (UW football 2007–2010 + 2021–2026 season tickets)

Two parallel bulk-loads, same import endpoint, different shape. **Football only** — basketball is out of scope.

### 8.1 — UW football 2007–2010 (per-game manual list)

- [ ] **8.1.1** Curate `scripts/data/manual-attending-uw-2007-2010.json` for UW football home games attended during college. Reference: Wikipedia season pages (`2007 Washington Huskies football team`, etc.). Per-row: `{ event_date, event_type: 'ncaaf_game', team_id: 264, opponent, is_home: true, notes? }`. Estimate: ~100 rows.

### 8.2 — UW football 2021–2026 season-tickets bulk-load (all-home expansion)

- [ ] **8.2.1** Curate `scripts/data/manual-attending-uw-recent.json` using the season-shorthand format: `[{ event_type: 'ncaaf_game', team_id: 264, season: 2021, attendance: 'all_home' }, ...]`. One row per season (~5 rows). Plus an `exceptions: [date, ...]` list per season for games user actually missed. Estimate: ~30 home games before exceptions across 5 seasons.
- [ ] **8.2.2** Seeder script support for the season-shorthand: when input has `attendance: 'all_home'`, fetch ESPN's full schedule for `(team_id, season)`, expand to one row per home game with `attended=1` (or `0` if date is in the exceptions list).

### 8.3 — Shared import endpoint + tooling

- [ ] **8.3.1** Admin endpoint `POST /v1/admin/sync/attending/manual-import` that handles BOTH per-row and season-shorthand inputs. Hits ESPN for canonical records, upserts, returns `{ loaded: N, unmatched: [...] }`.
- [ ] **8.3.2** `scripts/tools/import-manual-attending.ts` thin wrapper that POSTs a file.
- [ ] **8.3.3** Run for UW 2007–2010 list; resolve unmatched.
- [ ] **8.3.4** Run for UW 2021–2026 season-shorthand; user reviews populated rows and flips `attended=0` for actual misses (post-load via direct DB or admin endpoint).

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
