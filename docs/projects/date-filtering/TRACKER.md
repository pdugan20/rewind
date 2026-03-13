# Date Filtering -- Tracker

## Completed (Pre-project)

Work completed prior to this project that is directly related:

- [x] **0.1** Exclude filtered items (audiobooks, holiday music) from all listening endpoints -- 22 queries across 11 endpoints (commit c3d5042, closes #2)

## Phase 1: Recent Endpoints

Add `date`/`from`/`to` to all `/recent` endpoints. Estimated effort: ~1.5hrs.

**1.1 -- Shared Date Utilities**

- [x] **1.1.1** Create `src/lib/date-filters.ts` with `DateFilterQuery` Zod schema and `buildDateCondition()` helper

**1.2 -- Listening**

- [x] **1.2.1** Add `date`/`from`/`to` query params to `recentRoute` schema
- [x] **1.2.2** Add date filtering to `/listening/recent` handler using `buildDateCondition`

**1.3 -- Running**

- [x] **1.3.1** Add `date`/`from`/`to` query params to running `recentRoute` schema
- [x] **1.3.2** Add date filtering to `/running/recent` handler

**1.4 -- Watching**

- [x] **1.4.1** Add `date`/`from`/`to` query params to watching `recentRoute` schema
- [x] **1.4.2** Add date filtering to `/watching/recent` handler
- ~~**1.4.4** Fix `/watching/movies` year param~~ -- not a bug, `year` correctly filters by release year

**1.5 -- Collecting**

- [x] **1.5.1** Add `date`/`from`/`to` query params to `/collecting/recent` schema
- [x] **1.5.2** Add date filtering to `/collecting/recent` handler (filter on `date_added`)
- [x] **1.5.3** Add `date`/`from`/`to` query params to `/collecting/media/recent` schema
- [x] **1.5.4** Add date filtering to `/collecting/media/recent` handler (filter on `collected_at`)

**1.6 -- Verify**

- [x] **1.6.1** Run full test suite (446 passed), lint, typecheck
- [x] **1.6.2** Update OpenAPI snapshot

## Phase 2: Feed, Activities, and Collecting Calendar

Add date filtering to the cross-domain feed, expand running activities filtering, and create the missing collecting calendar endpoint. Estimated effort: ~1.5hrs.

**2.1 -- Feed**

- [x] **2.1.1** Add `date`/`from`/`to` query params to `/feed` route schema (merged into CursorPaginationQuerySchema)
- [x] **2.1.2** Add date conditions to `/feed` handler, combining with existing cursor pagination
- [x] **2.1.3** Add `date`/`from`/`to` to `/feed/domain/{domain}` route schema and handler

**2.2 -- Running Activities**

- [x] **2.2.1** Add `date`/`from`/`to` query params to `/running/activities` route schema (alongside existing `year`)
- [x] **2.2.2** Update handler: `date`/`from`/`to` takes precedence over `year` when both provided

**2.3 -- Collecting Calendar**

- [x] **2.3.1** Define `calendarRoute` schema in `collecting.ts` (year param, response with days/total/max_day)
- [x] **2.3.2** Implement `/collecting/calendar` handler -- merges vinyl (date_added) + media (collected_at) into unified calendar
- [x] **2.3.3** Combined vinyl + media into single calendar (no separate endpoints needed)

**2.4 -- Verify**

- [x] **2.4.1** Run full test suite (446 passed, 2 flaky Worker pool failures pass in isolation), lint, typecheck
- [x] **2.4.2** Update OpenAPI snapshot

## Phase 3: Date-Scoped Stats and Remaining Gaps

Add date filtering to stats endpoints and close remaining parity gaps. Estimated effort: ~3-4hrs.

**3.1 -- Listening Stats**

- [x] **3.1.1** Add `DateFilterQuery` params to `/listening/stats` route schema
- [x] **3.1.2** When date params present, compute live from scrobbles (totals, uniques, scrobbles_per_day scoped to range)
- [x] **3.1.3** Lifetime path unchanged -- uses pre-computed `lastfmUserStats` table

**3.2 -- Watching Stats**

- [x] **3.2.1** Add `DateFilterQuery` params to `/watching/stats` route schema
- [x] **3.2.2** When date params present, compute live from `watchHistory` (totals, runtime, top genre/decade/director scoped)
- [x] **3.2.3** Lifetime path unchanged -- uses pre-computed `watchStats` table + supplemental queries

**3.3 -- Collecting Stats**

- [x] **3.3.1** Add `DateFilterQuery` params to `/collecting/stats` route schema
- [x] **3.3.2** When date params present, compute live from `discogsCollection` (total items, unique artists, top genre)

**3.4 -- Watching Trends Parity**

- [x] **3.4.1** Add `DateFilterQuery` to `/watching/trends` route schema
- [x] **3.4.2** Apply date condition to query (keeps `period` for weekly/monthly grouping)

**3.5 -- Collecting List Filtering**

- [x] **3.5.1** Merge `DateFilterQuery` into `CollectionQuerySchema`, add date condition to `/collecting/collection` handler (filter on `date_added`)
- [x] **3.5.2** Merge `DateFilterQuery` into `MediaQuerySchema`, add date condition to `/collecting/media` handler (filter on `collected_at`)

**3.6 -- Verify**

- [x] **3.6.1** Run full test suite (446 passed), lint, typecheck
- [x] **3.6.2** Update OpenAPI snapshot

## Phase 4: Discovery Features

New endpoints for temporal discovery. Estimated effort: ~3-4hrs.

**4.1 -- "On This Day" Endpoint**

- [x] **4.1.1** Response shape: `{ month, day, years: [{ year, items: [FeedItem] }] }` -- grouped by year, most recent first
- [x] **4.1.2** Route schema: `GET /feed/on-this-day?month=3&day=13`
- [x] **4.1.3** Handler queries `activity_feed` with `substr(occurred_at, 6, 5)` match, groups by year

**4.2 -- First-Seen Dates on Detail Endpoints**

- [x] **4.2.1** Add `first_scrobbled_at` to `/listening/artists/{id}` -- MIN(scrobbled_at) via scrobbles join
- [x] **4.2.2** Add `first_scrobbled_at` to `/listening/albums/{id}` -- MIN(scrobbled_at) via scrobbles join
- [x] **4.2.3** Add `first_watched_at` to `/watching/movies/{id}` -- derived from watch_history (last item, already fetched desc)
- [x] **4.2.4** Add `first_watched_at` to `/watching/shows/{id}` -- earliest episode watched_at (first item, already fetched asc)
- ~~**4.2.5** Add `first_added_at` to `/collecting/collection/{id}`~~ -- already has `date_added` which is equivalent

**4.3 -- Verify**

- [x] **4.3.1** Run full test suite (446 passed), lint, typecheck
- [x] **4.3.2** Update OpenAPI snapshot

## Phase 5: Documentation and Cleanup

Update all docs and close out issues. Estimated effort: ~1-2hrs.

**5.1 -- Domain Documentation**

- [x] **5.1.1** Update `docs/domains/listening.md` -- date params on recent, stats; first_scrobbled_at on detail endpoints
- [x] **5.1.2** Update `docs/domains/running.md` -- date params on recent and activities
- [x] **5.1.3** Update `docs/domains/watching.md` -- date params on recent, stats, trends; first_watched_at on detail endpoints
- [x] **5.1.4** Update `docs/domains/collecting.md` -- date params on collection, stats, recent; new calendar and media endpoints

**5.2 -- Architecture and API Docs**

- [x] **5.2.1** Add "Date Filtering" section to `docs/ARCHITECTURE.md` documenting the `date`/`from`/`to` convention
- [x] **5.2.2** OpenAPI snapshot already up to date from Phase 4 commit

**5.3 -- GitHub Issues**

- [x] **5.3.1** Close issue #2 (filtered items in top endpoints)
- [x] **5.3.2** Close issue #3 (date filtering on /listening/recent)
- [x] **5.3.3** Open issue #4 for deferred work: date filtering on `/search` (FTS5 + timestamps)

**5.4 -- Final Verification**

- [ ] **5.4.1** Run full test suite, lint, typecheck
- [ ] **5.4.2** Deploy to production
- [ ] **5.4.3** Smoke test date filtering on live endpoints
- [ ] **5.4.4** Archive this project to `docs/projects/archived/date-filtering/`

## Deferred

- **Date filtering on `/search`** (issue #4): Requires adding a timestamp column to the `search_index` FTS5 table, a migration to backfill existing rows, and updates to all sync indexing logic. Separate project.
