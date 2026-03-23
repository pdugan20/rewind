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
- [ ] **2.3.3** Handle highlight deletions (remove highlights not returned by API)

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

- [ ] **4.1.1** Add `reading/articles` as entity type in image pipeline
- [ ] **4.1.2** Create OG image source client -- fetches `og:image` URL from article
- [ ] **4.1.3** Process images during sync (R2 upload, thumbhash, color extraction)
- [ ] **4.1.4** Integrate with `processReadingImages()` in sync-images.ts

**4.2 -- Feed Integration**

- [ ] **4.2.1** Add `article_saved` feed event on new bookmarks
- [ ] **4.2.2** Add `article_finished` feed event when status changes to finished
- [ ] **4.2.3** Add reading items to search index via `afterSync`

**4.3 -- Documentation**

- [ ] **4.3.1** Generate MDX endpoint pages via `@mintlify/scraping`
- [ ] **4.3.2** Add Reading section to docs.json navigation
- [ ] **4.3.3** Write Reading domain overview page (`domains/reading.mdx`)
- [ ] **4.3.4** Add changelog entry
- [ ] **4.3.5** Update openapi.json in docs-mintlify

## Phase 5: Backfill

Import historical Instapaper data.

**5.1 -- Assess Scale**

- [ ] **5.1.1** Count total bookmarks across all folders (unread, starred, archive)
- [ ] **5.1.2** Estimate backfill time based on count and rate limits

**5.2 -- Import Script**

- [ ] **5.2.1** Create `scripts/imports/import-instapaper.ts`
- [ ] **5.2.2** Paginate through all folders (500 per page)
- [ ] **5.2.3** Batch `get_text` calls with 500ms delays for word count
- [ ] **5.2.4** Batch OG metadata fetches with 200ms delays
- [ ] **5.2.5** Batch highlight fetches
- [ ] **5.2.6** Log progress every 50 articles

**5.3 -- Post-Backfill**

- [ ] **5.3.1** Run image pipeline for all articles with OG images
- [ ] **5.3.2** Populate feed with historical reading events
- [ ] **5.3.3** Build search index entries
- [ ] **5.3.4** Apply migration to remote D1
- [ ] **5.3.5** Deploy and verify on production

## Phase 6: Tests

- [ ] **6.1** Unit tests for Instapaper client (mocked API responses)
- [ ] **6.2** Unit tests for transforms (status derivation, domain extraction, word count)
- [ ] **6.3** Integration tests for reading endpoints (response shapes, pagination, filtering)
- [ ] **6.4** Contract tests (responses match OpenAPI spec)
- [ ] **6.5** E2E route shape test (all expected routes registered)
