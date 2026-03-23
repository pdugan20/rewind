# Reading Domain -- Task Tracker

## Phase 1: Foundation

Set up the database schema, Instapaper OAuth client, and token management.

**1.1 -- Schema**

- [x] **1.1.1** Create migration file with `reading_items` and `reading_highlights` tables (include future book columns)
- [x] **1.1.2** Add Drizzle schema definitions in `src/db/schema/reading.ts`
- [x] **1.1.3** Apply migration locally (`npm run db:migrate`)
- [x] **1.1.4** ~~Verify with Drizzle Studio~~ Verified via migration apply

**1.2 -- Instapaper OAuth Client**

- [x] **1.2.1** Create `src/services/instapaper/client.ts` -- OAuth 1.0a request signing, API methods (listBookmarks, getText, listFolders, listHighlights)
- [x] **1.2.2** Write test script `scripts/tools/instapaper-test.ts` -- xAuth token exchange and API exploration
- [x] **1.2.3** Run auth, store tokens in `.dev.vars` (access token + secret)
- [x] **1.2.4** Test against live API -- verified bookmark listing, confirmed no image field in API response

**1.3 -- Environment Setup**

- [x] **1.3.1** Add `INSTAPAPER_CONSUMER_KEY`, `INSTAPAPER_CONSUMER_SECRET`, `INSTAPAPER_ACCESS_TOKEN`, `INSTAPAPER_ACCESS_TOKEN_SECRET` to `src/types/env.ts`
- [x] **1.3.2** Document env vars in project CLAUDE.md

## Phase 2: Sync

Build the sync worker that pulls data from Instapaper into D1.

**2.1 -- Bookmark Sync**

- [x] **2.1.1** Create `src/services/instapaper/transforms.ts` -- status derivation, domain extraction, word count, bookmark transform
- [x] **2.1.2** Create `src/services/instapaper/sync.ts` -- sync function with folder iteration, upsert, enrichment, highlights
- [x] **2.1.3** Implement `started_at` derivation (first time progress > 0)
- [x] **2.1.4** Implement `finished_at` derivation (progress >= 0.75)
- [x] **2.1.5** Test sync locally -- 22 items synced successfully, enrichment times out on large batches (expected, backfill script handles this)

**2.2 -- Metadata Enrichment**

- [x] **2.2.1** Create OG metadata fetcher -- lightweight HTML head parser for og:image, og:site_name, article:author
- [x] **2.2.2** Integrate `get_text` -- store full HTML content, compute word count
- [x] **2.2.3** Compute `estimated_read_min` from word count (238 WPM)
- [x] **2.2.4** Run enrichment for new bookmarks only (skip already-enriched items)

**2.3 -- Highlight Sync**

- [x] **2.3.1** Fetch highlights per bookmark from Instapaper API
- [x] **2.3.2** Upsert into `reading_highlights` table (onConflictDoNothing)
- [x] **2.3.3** Handle highlight deletions (remove highlights not returned by API)

**2.4 -- Cron Registration**

- [x] **2.4.1** Add reading sync to cron handler in `src/index.ts` (every 6 hours, alongside Letterboxd)
- [x] **2.4.2** Add `shouldRetry` logic for failed syncs
- [x] **2.4.3** Add `POST /admin/sync/reading` endpoint in `admin-sync.ts`

## Phase 3: API

Build the REST endpoints for the Reading domain.

**3.1 -- Route Setup**

- [x] **3.1.1** Create `src/routes/reading.ts` with OpenAPI app (13 endpoints)
- [x] **3.1.2** Register route in `src/index.ts` at `/reading`
- [x] **3.1.3** Add `Reading` tag to OpenAPI config in `src/lib/openapi.ts`

**3.2 -- Core Endpoints**

- [x] **3.2.1** `GET /reading/recent` -- recently saved or finished, with date filtering
- [x] **3.2.2** `GET /reading/currently-reading` -- items with status 'reading'
- [x] **3.2.3** `GET /reading/articles` -- paginated, filterable by status, tag, domain, starred, with sort/order
- [x] **3.2.4** `GET /reading/articles/{id}` -- detail with embedded highlights
- [x] **3.2.5** `GET /reading/archive` -- finished articles

**3.3 -- Highlights Endpoints**

- [x] **3.3.1** `GET /reading/highlights` -- all highlights, newest first, with pagination
- [x] **3.3.2** `GET /reading/highlights/random` -- single random highlight with article context

**3.4 -- Stats & Discovery Endpoints**

- [x] **3.4.1** `GET /reading/stats` -- total articles, finished count, reading pace, avg read time, highlight count
- [x] **3.4.2** `GET /reading/calendar` -- daily reading activity
- [x] **3.4.3** `GET /reading/streaks` -- current and longest reading streaks
- [x] **3.4.4** `GET /reading/tags` -- tag breakdown with counts
- [x] **3.4.5** `GET /reading/domains` -- top source domains with article counts
- [x] **3.4.6** `GET /reading/year/{year}` -- year in review

**3.5 -- OpenAPI Quality**

- [x] **3.5.1** operationIds on all 13 reading endpoints
- [x] **3.5.2** Response examples with curated data on all endpoints
- [x] **3.5.3** Zod schemas for all request/response shapes
- [x] **3.5.4** OpenAPI snapshot updated, 0 Spectral errors

## Phase 4: Integration

Connect the Reading domain to cross-domain features and docs.

**4.1 -- Image Pipeline**

- [x] **4.1.1** Add `reading/articles` as entity type in image pipeline with `articleUrl` search hint
- [x] **4.1.2** Create OG image source client (`src/services/images/sources/og-image.ts`)
- [x] **4.1.3** Process images via standard pipeline (R2 upload, thumbhash, color extraction)
- [x] **4.1.4** Add `processReadingImages()` in sync-images.ts

**4.2 -- Feed Integration**

- [x] **4.2.1** Add `article_saved` feed event on new bookmarks _(done in sync.ts Phase 2)_
- [x] **4.2.2** Add `article_finished` feed event when status changes to finished _(done in sync.ts Phase 2)_
- [x] **4.2.3** Add reading items to search index via `afterSync` _(done in sync.ts Phase 2)_

**4.3 -- Documentation**

- [x] **4.3.1** Generate 13 MDX endpoint pages via `@mintlify/scraping`
- [x] **4.3.2** Add Reading section to docs.json navigation (Guides + API Reference)
- [x] **4.3.3** Write Reading domain overview page with icon, status table, endpoint links
- [x] **4.3.4** Add changelog entry for March 22, 2026
- [x] **4.3.5** Update openapi.json in docs-mintlify

## Phase 5: Backfill

Import historical Instapaper data.

**5.1 -- Assess Scale**

- [x] **5.1.1** Count: 47 unread, 500 starred, 500 archive = 1,047 total
- [x] **5.1.2** Backfill time: ~5 minutes without enrichment

**5.2 -- Import Script**

- [x] **5.2.1** Create `scripts/imports/import-instapaper.ts` with checkpoint/resume
- [x] **5.2.2** Fetch all folders (500 per call)
- [x] **5.2.3** Highlight import alongside bookmarks (126 highlights)
- [x] **5.2.4** Progress logging every 50 articles
- [x] **5.2.5** --skip-enrich and --resume flags

**5.3 -- Post-Backfill**

- [x] **5.3.1** Migration applied to remote D1
- [x] **5.3.2** Deployed to production
- [x] **5.3.3** Verified: 1,047 articles, 323 finished, 69 reading, 126 highlights
- [x] **5.3.4** Enrichment pass: 557 enriched, 473 got article text, 490 failed (paywalled: NYT 349, WSJ 52, Bloomberg 31)
- [x] **5.3.5** Image pipeline wired up: uses pre-resolved og_image_url, runs after sync, secrets deployed to production

## Phase 6: Tests

- [x] **6.1** Unit tests for Instapaper client (5 tests — mocked fetch, OAuth header validation)
- [x] **6.2** Unit tests for transforms (20 tests — status derivation, domain extraction, word count, bookmark transform)
- [x] **6.3** Integration tests (30 tests — recent, articles, detail, highlights, stats, domains, archive, tags, streaks, currently-reading, cache headers)
- [x] **6.4** Contract tests covered by integration tests + OpenAPI snapshot test
- [x] **6.5** E2E route shape test (4 tests — all 13 routes registered, GET methods verified)
