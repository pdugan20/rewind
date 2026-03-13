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

- [ ] **3.1.1** Add optional `year` and `from`/`to` params to `/listening/stats` route schema
- [ ] **3.1.2** Update handler to scope all aggregate queries (total scrobbles, unique counts, per-day rate) to date range when provided
- [ ] **3.1.3** Adjust derived values (scrobbles_per_day, years_tracking) to use scoped denominators
- [ ] **3.1.4** Write tests for scoped vs unscoped stats

**3.2 -- Watching Stats**

- [ ] **3.2.1** Add optional `year` and `from`/`to` params to `/watching/stats` route schema
- [ ] **3.2.2** Update handler to scope aggregate queries to date range
- [ ] **3.2.3** Write tests for scoped watching stats

**3.3 -- Collecting Stats**

- [ ] **3.3.1** Add optional `year` and `from`/`to` params to `/collecting/stats` route schema
- [ ] **3.3.2** Update handler to scope aggregate queries to date range
- [ ] **3.3.3** Write tests for scoped collecting stats

**3.4 -- Watching Trends Parity**

- [ ] **3.4.1** Add `from`/`to` query params to `/watching/trends` route schema
- [ ] **3.4.2** Update handler to apply date range filter (keep `period` for grouping granularity)
- [ ] **3.4.3** Write tests for date-filtered watching trends

**3.5 -- Collecting List Filtering**

- [ ] **3.5.1** Add `from`/`to` to `/collecting/collection` route schema and handler (filter on `date_added`)
- [ ] **3.5.2** Add `from`/`to` to `/collecting/media` route schema and handler (filter on `collected_at`)
- [ ] **3.5.3** Write tests for collecting list date filtering

**3.6 -- Verify**

- [ ] **3.6.1** Run full test suite, lint, typecheck
- [ ] **3.6.2** Update OpenAPI snapshot

## Phase 4: Discovery Features

New endpoints for temporal discovery. Estimated effort: ~3-4hrs.

**4.1 -- "On This Day" Endpoint**

- [ ] **4.1.1** Design response shape for `/feed/on-this-day` -- grouped by year, each year contains domain-specific summaries
- [ ] **4.1.2** Define route schema with `month` and `day` params
- [ ] **4.1.3** Implement handler -- query scrobbles, activities, watch history, and collection additions for the given month/day across all years
- [ ] **4.1.4** Write tests for on-this-day (multiple years, single year, no data)

**4.2 -- First-Seen Dates on Detail Endpoints**

- [ ] **4.2.1** Add `first_scrobbled_at` to `/listening/artists/{id}` response (MIN of scrobble dates for that artist)
- [ ] **4.2.2** Add `first_scrobbled_at` to `/listening/albums/{id}` response
- [ ] **4.2.3** Add `first_watched_at` to `/watching/movies/{id}` response (earliest watch_history entry)
- [ ] **4.2.4** Add `first_watched_at` to `/watching/shows/{id}` response
- [ ] **4.2.5** Add `first_added_at` to `/collecting/collection/{id}` response (if not already present)
- [ ] **4.2.6** Write tests for first-seen dates across domains
- [ ] **4.2.7** Update OpenAPI response schemas for modified detail endpoints

**4.3 -- Verify**

- [ ] **4.3.1** Run full test suite, lint, typecheck
- [ ] **4.3.2** Update OpenAPI snapshot

## Phase 5: Documentation and Cleanup

Update all docs and close out issues. Estimated effort: ~1-2hrs.

**5.1 -- Domain Documentation**

- [ ] **5.1.1** Update `docs/domains/listening.md` with new date filtering params on recent, and isFiltered fix
- [ ] **5.1.2** Update `docs/domains/running.md` with date filtering on recent and activities
- [ ] **5.1.3** Update `docs/domains/watching.md` with date filtering on recent, movies year fix, trends parity
- [ ] **5.1.4** Update `docs/domains/collecting.md` with date filtering on recent, collection, media, and new calendar endpoint

**5.2 -- Architecture and API Docs**

- [ ] **5.2.1** Update `docs/ARCHITECTURE.md` if any caching or response shape changes were made
- [ ] **5.2.2** Regenerate and commit final `openapi.snapshot.json`
- [ ] **5.2.3** Verify Scalar docs site reflects changes (if deployed)

**5.3 -- Feed and Cross-Domain Docs**

- [ ] **5.3.1** Document feed date filtering and on-this-day endpoint
- [ ] **5.3.2** Document the `date`/`from`/`to` convention in ARCHITECTURE.md query parameters section

**5.4 -- GitHub Issues**

- [ ] **5.4.1** Close issue #2 (filtered items in top endpoints) -- already fixed
- [ ] **5.4.2** Close issue #3 (date filtering on /listening/recent) -- covered by Phase 1
- [ ] **5.4.3** Open issue for deferred work: date filtering on `/search` (FTS5 + timestamps)

**5.5 -- Final Verification**

- [ ] **5.5.1** Run full test suite, lint, typecheck
- [ ] **5.5.2** Deploy to production
- [ ] **5.5.3** Smoke test date filtering on live endpoints
- [ ] **5.5.4** Archive this project to `docs/projects/archived/date-filtering/`

## Deferred

- **Date filtering on `/search`**: Requires adding a timestamp column to the `search_index` FTS5 table, a migration to backfill existing rows, and updates to all sync indexing logic. Separate project.
