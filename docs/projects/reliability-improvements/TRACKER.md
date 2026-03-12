# Reliability & Architecture Improvements

Systematic improvements to data integrity, performance, consistency, and API completeness identified during a full codebase audit.

## Phase 1: Movie Deduplication

Fix the highest-risk data integrity issue: Plex, Letterboxd, and Trakt can create duplicate `movies` rows for the same film because they use different lookup keys.

**1.1 -- Audit and Migration**

- [x] **1.1.1** Write a diagnostic query to identify existing duplicate movies (same tmdbId, different rows; or matching title+year without tmdbId) -- 0 duplicates found, 1 movie without tmdbId (TV special edge case)
- [x] **1.1.2** Create a migration script that merges duplicate movie records -- not needed, no duplicates exist
- [x] **1.1.3** Run migration against production D1 and verify no orphaned watch records -- not needed

**1.2 -- Unified Movie Resolution**

- [x] **1.2.1** Create `src/services/watching/resolve-movie.ts` -- single entry point for all sources to find-or-create a movie by tmdbId (primary), then fallback to title+year TMDB search
- [x] **1.2.2** Refactor Plex sync (`plex/sync.ts` and `plex/webhook.ts`) to always resolve tmdbId before inserting and use `resolve-movie.ts`
- [x] **1.2.3** Refactor Letterboxd sync (`letterboxd/sync.ts`) to use `resolve-movie.ts`
- [x] **1.2.4** Refactor Trakt sync (`trakt/sync.ts`) to use `resolve-movie.ts`
- [x] **1.2.5** Refactor manual entry (`watching.ts` admin POST) to use `resolve-movie.ts`
- [x] **1.2.6** Write tests for unified movie resolution (Plex item with only ratingKey, Letterboxd with tmdbId, Trakt with tmdbId, title+year fallback, conflict scenarios)

## Phase 2: Cron Staggering and Sync Reliability

Eliminate D1 write contention from parallel cron jobs and add retry logic for failed syncs.

**2.1 -- Stagger Cron Schedules**

- [x] **2.1.1** Split the daily `0 3 * * *` cron into separate schedules: Last.fm top lists at `0 3 * * *`, Strava at `15 3 * * *`, Plex at `30 3 * * *`, Discogs/Trakt at `45 3 * * 0` (Sunday only)
- [x] **2.1.2** Update `wrangler.toml` cron triggers
- [x] **2.1.3** Update `index.ts` cron handler switch cases
- [x] **2.1.4** Update docs/ARCHITECTURE.md sync schedule table

**2.2 -- Sync Retry Logic**

- [x] **2.2.1** Add a helper `shouldRetry(db, domain)` that checks if the most recent sync_run for a domain failed -- `src/lib/sync-retry.ts`, counts consecutive failures (max 2 retries)
- [x] **2.2.2** In each cron handler, call `shouldRetry` and log retry attempts before running the sync
- [x] **2.2.3** Add a `retryCount` field to sync_runs to prevent infinite retry loops (max 2 retries) -- migration `0012_add_sync_runs_retry_count.sql`
- [x] **2.2.4** Write tests for retry logic -- 8 tests in `src/lib/sync-retry.test.ts`

## Phase 3: Strava Stats Optimization

Make stats recomputation incremental instead of full-table-scan on every sync.

**3.1 -- Incremental Year Summaries**

- [x] **3.1.1** Refactor `recomputeStats` to accept optional `changedYears` parameter, splitting into `recomputeIncremental` (year-scoped) and `recomputeFull` (all activities)
- [x] **3.1.2** Track which years were affected during sync (`syncRunning`, `syncSingleActivity`, `deleteActivity`) and pass to recomputation
- [x] **3.1.3** Keep full recomputation as fallback when no `changedYears` provided (admin scripts, deletions without activity data)

**3.2 -- Incremental Lifetime Stats**

- [x] **3.2.1** Refactor incremental lifetime stats to aggregate from `strava_year_summaries` table instead of scanning all activities
- [x] **3.2.2** Streaks and Eddington still query activity data in incremental mode but use lightweight single-column queries instead of full `SELECT *` -- streak optimization deferred as the column scan is already fast
- [x] **3.2.3** Write tests comparing incremental vs full recomputation results -- 5 tests in `stats-recompute.test.ts`

## Phase 4: Admin Endpoint Consistency

Normalize all admin paths and add missing admin operations.

**4.1 -- Path Normalization**

- [x] **4.1.1** Standardize all sync endpoints to `/v1/admin/sync/:domain` pattern -- created `admin-sync.ts` with canonical paths, removed old handlers from domain route files
- [x] **4.1.2** Add redirect from old paths to new paths (301 redirects in admin-sync.ts for `/listening/admin/sync`, `/running/admin/sync`, `/watching/admin/sync/watching`)
- [x] **4.1.3** Update docs/API.md -- added DELETE /v1/admin/running/activities/:id and POST /v1/admin/running/recompute

**4.2 -- Missing Admin Endpoints**

- [x] **4.2.1** Add `DELETE /v1/admin/running/activities/:id` -- soft-deletes activity and triggers incremental stats recompute
- [x] **4.2.2** Add `POST /v1/admin/running/recompute` -- triggers full stats recomputation without Strava sync
- [x] **4.2.3** Write tests for new admin endpoints -- 5 tests in `admin-sync.test.ts` (auth checks, delete activity, recompute stats)

## Phase 5: Auth and Rate Limiting

Cache auth lookups and either enforce or remove rate limiting.

**5.1 -- Auth Caching**

- [x] **5.1.1** In-memory auth cache in `auth.ts` -- Map<keyHash, CachedKey> with 60s TTL per isolate (Cloudflare Cache API not needed; in-memory is faster and resets naturally on isolate recycle)
- [x] **5.1.2** Invalidate cache entry when a key is revoked via `DELETE /v1/admin/keys/:id` -- `invalidateAuthCache(keyHash)` called in `keys.ts`
- [x] **5.1.3** Write tests for cache hit/miss/invalidation behavior -- 4 tests in `auth.test.ts` (missing header, valid token, cached second request, revoked key after invalidation)

**5.2 -- Rate Limiting**

- [x] **5.2.1** Sliding window rate limiting enforced in `auth.ts` middleware using existing `rateLimitRpm` field and `checkRateLimit` from `rate-limit.ts`
- [x] **5.2.2** In-memory sliding window counters in `rate-limit.ts` (per-key request count with 60s window, resets on isolate recycle)
- [x] **5.2.3** Return `429 Too Many Requests` with `Retry-After` and `X-RateLimit-*` headers when limit exceeded
- [x] **5.2.4** Write tests for rate limit enforcement -- 3 tests in `auth.test.ts` (rate limit headers present, 429 on limit exceeded, window reset)

## Phase 6: Missing API Endpoints

Add endpoints that consumers would reasonably expect.

**6.1 -- Browse Endpoints**

- [x] **6.1.1** Add `GET /v1/listening/albums` -- paginated, filterable by artist/search, sortable by playcount/name/recent
- [x] **6.1.2** Add `GET /v1/listening/artists` -- paginated, filterable by search, sortable by playcount/name
- [x] **6.1.3** Write tests for browse endpoints -- 4 tests in `browse-endpoints.test.ts` (artists paginated, artist search filter, albums with artist info, albums filtered by artist)

**6.2 -- Rating and Review Endpoints**

- [x] **6.2.1** Add `GET /v1/watching/ratings` -- movies with user_rating, sortable by rating/date, paginated with images
- [x] **6.2.2** Add `GET /v1/watching/reviews` -- movies with review text, paginated with images
- [x] **6.2.3** Write tests for rating/review endpoints -- 2 tests in `browse-endpoints.test.ts` (ratings sorted desc, reviews with text)

**6.3 -- Year-in-Review Endpoints**

- [x] **6.3.1** Add `GET /v1/listening/year/:year` -- top artists/albums/tracks, monthly breakdown with scrobbles/unique artists/unique albums, total stats, images
- [x] **6.3.2** Add `GET /v1/watching/year/:year` -- total movies, genre/decade breakdown, monthly counts, top-rated movies with images
- [x] **6.3.3** Add `GET /v1/running/year/:year` -- year summary + monthly breakdown (runs/distance/duration/elevation) + top 5 runs by distance
- [x] **6.3.4** Write tests for year-in-review endpoints -- 5 tests in `browse-endpoints.test.ts` (listening year data, invalid year, watching year data, running year with monthly, running 404 for missing year)

## Phase 7: Database Integrity

Fix schema gaps: missing indexes, FK constraints, cascade behavior, and multi-user scoping.

**7.1 -- Missing Indexes**

- [x] **7.1.1** Add composite index `idx_watch_history_movie_watched` on `(movieId, watchedAt)` for dedup queries
- [x] **7.1.2** Add composite index `idx_strava_splits_user_activity` on `(userId, activityStravaId)` for bulk operations
- [x] **7.1.3** Add composite index `idx_plex_episodes_timeline` on `(userId, watchedAt)` for timeline queries
- [x] **7.1.4** Migration `0013_add_composite_indexes.sql` -- all three indexes created, Drizzle schema updated

**7.2 -- Foreign Key Constraints**

- [x] **7.2.1** Add ON DELETE CASCADE to `watchHistory.movieId` -> `movies.id`
- [x] **7.2.2** Add ON DELETE CASCADE to `movieGenres.movieId` -> `movies.id` and `movieGenres.genreId` -> `genres.id`
- [x] **7.2.3** Add ON DELETE CASCADE to `movieDirectors.movieId` -> `movies.id` and `movieDirectors.directorId` -> `directors.id`
- [x] **7.2.4** Add ON DELETE CASCADE to `lastfmScrobbles.trackId` -> `lastfmTracks.id`
- [x] **7.2.5** Add ON DELETE CASCADE to `lastfmTracks.artistId` -> `lastfmArtists.id` and SET NULL for `lastfmTracks.albumId`
- [x] **7.2.6** Migration `0014_add_foreign_key_cascades.sql` -- table recreation approach for D1/SQLite, all indexes rebuilt after recreation

**7.3 -- Multi-User Scoping**

- [x] **7.3.1** Change `lastfmArtists` unique constraint from `(name)` to `(userId, name)` -- schema updated, old `.unique()` on name removed
- [x] **7.3.2** Change `stravaActivities` unique constraint from `(stravaId)` to `(userId, stravaId)` -- `idx_strava_activities_user_strava` replaces `idx_strava_activities_strava_id`
- [x] **7.3.3** Migration `0015_multi_user_unique_constraints.sql` -- table recreation with new unique indexes
- [x] **7.3.4** Audit pass: core entity queries (lastfmArtists, stravaActivities) do not filter by userId -- this is acceptable for single-user and would require a larger refactor for true multi-user. Stats/aggregate tables already filter by userId=1.

## Phase 8: Image Pipeline Performance

Batch image processing and handle Worker CPU limits.

**8.1 -- Parallel Fetch, Sequential Process**

- [x] **8.1.1** Refactor `processItems` in `sync-images.ts` to process images in batches of 5 using `Promise.allSettled` -- full pipeline runs per batch in parallel (network-bound), batches run sequentially to limit concurrency
- [x] **8.1.2** Per-batch timing log: `[SYNC] Batch N/M completed in Xms (domain/entityType)` -- enables monitoring for CPU limit issues
- [x] **8.1.3** Existing tests cover batched processing -- all 7 sync-images tests pass with new batching logic, batch logs visible in test output

**8.2 -- Deduplicate Watching Image Runs**

- [x] **8.2.1** Added `shouldSkipWatchingImages(db)` -- checks sync_runs for a completed watching sync within the last 6 hours
- [x] **8.2.2** Letterboxd cron handler (`0 */6 * * *`) calls `shouldSkipWatchingImages` before `processWatchingImages`, logs skip message when Plex cron already handled it

## Phase 9: Cleanup and Documentation

Remove dead code, fix remaining inconsistencies, update docs.

**9.1 -- Remove Dead Rate Limit Code**

- [x] **9.1.1** If rate limiting is implemented in Phase 5, remove any placeholder code in `lib/rate-limit.ts` that's no longer needed -- rate limiting is fully implemented, cleaned up orphaned JSDoc comment
- ~~**9.1.2**~~ N/A -- rate limiting IS implemented in Phase 5

**9.2 -- Consistent Response Envelopes**

- [x] **9.2.1** Audit all stats endpoints and wrap in `{ data: {...} }` where they currently return flat objects -- wrapped 6 endpoints: running/stats, running/stats/years/:year, running/streaks, watching/stats, collecting/stats, collecting/media/stats
- [x] **9.2.2** Document the response envelope convention in docs/API.md -- all stats endpoints now use `{ data: {...} }` wrapper
- [x] **9.2.3** N/A -- no consumers exist yet

**9.3 -- Documentation Updates**

- [x] **9.3.1** Update docs/ARCHITECTURE.md with all changes from this project -- auth caching, rate limiting, staggered crons, sync retry, image batching, FK cascades, multi-user indexes
- [x] **9.3.2** Update docs/API.md with new endpoints and changed paths -- 7 new endpoints documented (53→60 total), rate limiting headers added
- [x] **9.3.3** Update docs/ROADMAP.md to reference this project -- added Reliability & Architecture Improvements section with all 9 phases
- [x] **9.3.4** Update CLAUDE.md if any conventions changed -- updated endpoint counts (listening 15, running 19, watching 18), added rate-limit.ts and sync-retry.ts to lib listing
