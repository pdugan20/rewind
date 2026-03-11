# Rewind -- Roadmap

## Phase 0: Project Setup

**0.1 -- Documentation**

- [x] **0.1.1** Create project directory structure
- [x] **0.1.2** Write CLAUDE.md with project conventions
- [x] **0.1.3** Write docs/README.md with task tracker
- [x] **0.1.4** Write docs/ARCHITECTURE.md (schema, caching, sync, deployment)
- [x] **0.1.5** Write docs/API.md (complete endpoint reference)
- [x] **0.1.6** Write docs/domains/listening.md
- [x] **0.1.7** Write docs/domains/running.md
- [x] **0.1.8** Write docs/domains/watching.md
- [x] **0.1.9** Write docs/domains/collecting.md
- [x] **0.1.10** Write docs/domains/images.md

**0.2 -- Repository**

- [x] **0.2.1** Initialize git repository
- [x] **0.2.2** Create .gitignore (node_modules, .wrangler, .dev.vars, dist)
- [x] **0.2.3** Create GitHub repository (pdugan20/rewind)
- [x] **0.2.4** Push initial commit
- [x] **0.2.5** Configure GitHub ruleset with required status checks
- [x] **0.2.6** Add Dependabot configuration
- [x] **0.2.7** Add dependabot-auto-merge workflow

**0.3 -- Project Initialization**

- [x] **0.3.1** Initialize npm project (package.json)
- [x] **0.3.2** Install runtime dependencies (hono, drizzle-orm, zod, @hono/zod-validator)
- [x] **0.3.3** Install dev dependencies (typescript, wrangler, vitest, @cloudflare/vitest-pool-workers, drizzle-kit)
- [x] **0.3.4** Install linting/formatting dependencies (eslint, @typescript-eslint/\*, prettier, eslint-config-prettier, eslint-plugin-drizzle)
- [x] **0.3.5** Install pre-commit tooling (husky, lint-staged)
- [x] **0.3.6** Install claude-code-lint as dev dependency
- [x] **0.3.7** Configure TypeScript (tsconfig.json)
- [x] **0.3.8** Configure ESLint (eslint.config.ts with TypeScript, Prettier, Drizzle plugins)
- [x] **0.3.9** Configure Prettier (.prettierrc + .prettierignore)
- [x] **0.3.10** Configure Vitest with @cloudflare/vitest-pool-workers
- ~~**0.3.11** Create .editorconfig~~ (skipped -- not used in other projects)
- [x] **0.3.12** Create .nvmrc (pin Node.js 22)
- [x] **0.3.13** Set up Husky pre-commit hook with lint-staged + pre-push hook with type-check
- [x] **0.3.14** Set up claudelint to validate Claude Code files
- [x] **0.3.15** Add npm scripts (dev, deploy, build, lint, lint:fix, format, format:check, type-check, test, db:\*, lint:claude)

**0.4 -- Cloudflare Setup**

- [x] **0.4.1** Create wrangler.toml with Worker configuration
- [x] **0.4.2** Create D1 database (rewind-db)
- [x] **0.4.3** Create R2 bucket (rewind-images)
- [x] **0.4.4** Configure D1 and R2 bindings in wrangler.toml
- [x] **0.4.5** Configure cron triggers in wrangler.toml
- [x] **0.4.6** Set up .dev.vars for local environment variables
- [x] **0.4.7** Configure custom domain api.rewind.rest
- [x] **0.4.8** Configure custom domain cdn.rewind.rest for R2

**0.5 -- Application Skeleton**

- [x] **0.5.1** Create src/types/env.ts (Env interface with all bindings and vars)
- [x] **0.5.2** Create src/db/client.ts (Drizzle D1 client setup)
- [x] **0.5.3** Create src/lib/auth.ts (API key middleware with SHA-256 hash validation)
- [x] **0.5.4** Create src/lib/cors.ts (CORS middleware with configurable origins)
- [x] **0.5.5** Create src/lib/rate-limit.ts (per-key rate limit checking)
- [x] **0.5.6** Create src/lib/errors.ts (error response helpers)
- [x] **0.5.7** Create src/lib/cache.ts (Cache-Control header helpers)
- [x] **0.5.8** Create src/index.ts (Hono app entry, route registration, cron handler)
- [x] **0.5.9** Create src/routes/system.ts (GET /v1/health, GET /v1/health/sync)
- [x] **0.5.10** Verify local dev server starts (npm run dev)
- [x] **0.5.11** Deploy skeleton to Cloudflare Workers
- [x] **0.5.12** Verify /v1/health endpoint responds in production

**0.6 -- Database Foundation**

- [x] **0.6.1** Create src/db/schema/system.ts (sync_runs, activity_feed, images, api_keys, webhook_events, revalidation_hooks tables)
- [x] **0.6.2** Configure drizzle.config.ts
- [x] **0.6.3** Generate initial migration (npm run db:generate)
- [x] **0.6.4** Apply migration locally (npm run db:migrate)
- [x] **0.6.5** Apply migration to remote D1 (npm run db:remote)
- [x] **0.6.6** Verify tables via Drizzle Studio (npm run db:studio)
- [x] **0.6.7** Create initial API keys (rw*admin* for sync, rw*live* for development)

**0.7 -- CI/CD**

- [x] **0.7.1** Create .github/workflows/ci.yml (lint, format:check, type-check, test, claude-code-lint)
- [x] **0.7.2** Create .github/workflows/deploy.yml (migrate + deploy on push to main)
- [x] **0.7.3** Add Cloudflare API token to GitHub secrets
- [x] **0.7.4** Verify CI passes on first push
- [x] **0.7.5** Add CI badge to project README

## Phase 1: Listening (Last.fm)

**1.1 -- Schema**

- [ ] **1.1.1** Create src/db/schema/lastfm.ts (artists, albums, tracks, scrobbles, top\_\*, filters, user_stats)
- [ ] **1.1.2** Generate migration for Last.fm tables
- [ ] **1.1.3** Apply migration locally and verify schema
- [ ] **1.1.4** Apply migration to remote D1

**1.2 -- Last.fm API Client**

- [ ] **1.2.1** Create src/services/lastfm/client.ts (Last.fm API wrapper)
- [ ] **1.2.2** Implement user.getRecentTracks fetcher with pagination
- [ ] **1.2.3** Implement user.getTopArtists/Albums/Tracks fetchers
- [ ] **1.2.4** Implement user.getInfo fetcher
- [ ] **1.2.5** Add rate limit handling (5 req/sec)
- [ ] **1.2.6** Write tests for API client

**1.3 -- Transforms and Filters**

- [ ] **1.3.1** Create src/services/lastfm/transforms.ts (normalize artist/album/track data)
- [ ] **1.3.2** Create src/services/lastfm/filters.ts (holiday music, audiobook detection)
- [ ] **1.3.3** Seed lastfm_filters table with initial filter patterns
- [ ] **1.3.4** Implement over-fetch + filter + re-rank strategy for top lists
- [ ] **1.3.5** Write tests for transforms and filters

**1.4 -- Sync**

- [ ] **1.4.1** Create src/services/lastfm/sync.ts (sync orchestrator)
- [ ] **1.4.2** Implement incremental scrobble sync (from last timestamp)
- [ ] **1.4.3** Implement top lists sync (all 6 periods x 3 entity types)
- [ ] **1.4.4** Implement user stats sync
- [ ] **1.4.5** Implement full historical backfill (one-time, ~124K scrobbles)
- [ ] **1.4.6** Add sync_runs recording (start, complete, item count, errors)
- [ ] **1.4.7** Wire cron handler: 15-min scrobble sync, daily 3 AM top lists + stats
- [ ] **1.4.8** Add POST /v1/admin/sync/listening endpoint
- [ ] **1.4.9** Write tests for sync logic
- [ ] **1.4.10** Implement revalidation hook callback after sync completes

**1.5 -- Route Handlers**

- [ ] **1.5.1** Create src/routes/listening.ts
- [ ] **1.5.2** GET /v1/listening/now-playing
- [ ] **1.5.3** GET /v1/listening/recent
- [ ] **1.5.4** GET /v1/listening/top/artists
- [ ] **1.5.5** GET /v1/listening/top/albums
- [ ] **1.5.6** GET /v1/listening/top/tracks
- [ ] **1.5.7** GET /v1/listening/stats
- [ ] **1.5.8** GET /v1/listening/history
- [ ] **1.5.9** GET /v1/listening/artists/:id
- [ ] **1.5.10** GET /v1/listening/albums/:id
- [ ] **1.5.11** GET /v1/listening/calendar
- [ ] **1.5.12** GET /v1/listening/trends
- [ ] **1.5.13** GET /v1/listening/streaks
- [ ] **1.5.14** Apply Cache-Control headers per endpoint
- [ ] **1.5.15** Write tests for route handlers

**1.6 -- Integration Testing**

- [ ] **1.6.1** End-to-end test: cron trigger syncs data, endpoints return correct responses
- [ ] **1.6.2** Deploy and verify in production
- [ ] **1.6.3** Run initial historical backfill against production D1

## Phase 2: Image Pipeline

**2.1 -- R2 and CDN Setup**

- [ ] **2.1.1** Configure R2 bucket custom domain (cdn.rewind.rest)
- [x] **2.1.2** Set up CORS headers for cdn.rewind.rest
- [x] **2.1.3** Configure Cloudflare Images transforms
- [x] **2.1.4** Create size presets (thumbnail, small, medium, large, poster, backdrop)

**2.2 -- Source Clients**

- [x] **2.2.1** Create src/services/images/sources/cover-art-archive.ts
- [x] **2.2.2** Create src/services/images/sources/itunes.ts
- [x] **2.2.3** Create src/services/images/sources/apple-music.ts
- [x] **2.2.4** Create src/services/images/sources/fanart-tv.ts
- [x] **2.2.5** Create src/services/images/sources/tmdb.ts
- [x] **2.2.6** Create src/services/images/sources/plex.ts
- [x] **2.2.7** Write tests for each source client

**2.3 -- Pipeline**

- [x] **2.3.1** Create src/services/images/pipeline.ts (waterfall resolver)
- [x] **2.3.2** Implement domain-specific source priority waterfalls
- [x] **2.3.3** Implement R2 upload with metadata
- [x] **2.3.4** Implement ThumbHash generation (WASM-based image decoder)
- [x] **2.3.5** Implement dominant and accent color extraction (k-means clustering on pixel data)
- [x] **2.3.6** Implement images table metadata storage
- [x] **2.3.7** Write tests for pipeline

**2.4 -- Route Handler**

- [x] **2.4.1** Create src/routes/images.ts
- [x] **2.4.2** GET /v1/images/:domain/:entity_type/:entity_id/:size
- [x] **2.4.3** Implement cache-hit redirect to CDN
- [x] **2.4.4** Implement cache-miss pipeline trigger with CDN redirect
- [x] **2.4.5** Add X-ThumbHash, X-Dominant-Color, X-Accent-Color response headers
- [x] **2.4.6** Append `?v={image_version}` to all CDN redirect URLs for cache busting
- [x] **2.4.7** Write tests for image route handler

**2.5 -- Image Overrides**

- [x] **2.5.1** Implement is_override sync protection (skip overridden images in pipeline)
- [x] **2.5.2** GET /v1/admin/images/:domain/:entity_type/:entity_id/alternatives (browse sources)
- [x] **2.5.3** PUT /v1/admin/images/:domain/:entity_type/:entity_id (set override via URL or upload)
- [x] **2.5.4** DELETE /v1/admin/images/:domain/:entity_type/:entity_id/override (revert to automatic)
- [x] **2.5.5** Implement ThumbHash + color regeneration on override
- [x] **2.5.6** Implement image_version increment and CDN cache busting
- [x] **2.5.7** Write tests for override endpoints

**2.6 -- Integration**

- [x] **2.6.1** Backfill images for existing Last.fm albums (from Phase 1)
- [x] **2.6.2** Backfill images for existing Last.fm artists
- [ ] **2.6.3** Verify CDN delivery and transforms in production
- [x] **2.6.4** Create default placeholder image in R2

## Phase 3: Running (Strava)

**3.1 -- Schema**

- [ ] **3.1.1** Create src/db/schema/strava.ts (activities, gear, PRs, year_summaries, lifetime_stats, splits, tokens)
- [ ] **3.1.2** Generate migration for Strava tables
- [ ] **3.1.3** Apply migration locally and verify schema
- [ ] **3.1.4** Apply migration to remote D1

**3.2 -- OAuth**

- [ ] **3.2.1** Create src/services/strava/auth.ts (token refresh with rotation persistence)
- [ ] **3.2.2** Add strava_tokens table to schema for runtime token storage
- [ ] **3.2.3** Implement getAccessToken with 5-minute expiry buffer
- [ ] **3.2.4** Implement token refresh with new refresh_token persistence
- [ ] **3.2.5** Write tests for OAuth flow

**3.3 -- Strava API Client**

- [ ] **3.3.1** Create src/services/strava/client.ts (Strava API wrapper)
- [ ] **3.3.2** Implement /athlete/activities fetcher with pagination
- [ ] **3.3.3** Implement /activities/{id} detail fetcher
- [ ] **3.3.4** Implement /activities/{id}/laps fetcher
- [ ] **3.3.5** Implement /athlete/stats fetcher
- [ ] **3.3.6** Implement /gear/{id} fetcher
- [ ] **3.3.7** Add rate limit handling (200/15min, 2000/day) with header parsing
- [ ] **3.3.8** Write tests for API client

**3.4 -- Transforms**

- [ ] **3.4.1** Create src/services/strava/transforms.ts
- [ ] **3.4.2** Implement unit conversions (meters to miles/feet, m/s to min/mile)
- [ ] **3.4.3** Implement pace formatting (MM:SS/mi)
- [ ] **3.4.4** Implement duration formatting
- [ ] **3.4.5** Implement personal records extraction from best_efforts
- [ ] **3.4.6** Implement year summary computation
- [ ] **3.4.7** Implement lifetime stats computation
- [ ] **3.4.8** Implement streak calculation (current + longest)
- [ ] **3.4.9** Implement Eddington number calculation
- [ ] **3.4.10** Write tests for all transforms

**3.5 -- Sync**

- [ ] **3.5.1** Create src/services/strava/sync.ts (sync orchestrator)
- [ ] **3.5.2** Implement incremental activity sync (since last synced activity)
- [ ] **3.5.3** Implement gear sync
- [ ] **3.5.4** Implement stats recomputation after sync (PRs, years, lifetime, streaks)
- [ ] **3.5.5** Add sync_runs recording
- [ ] **3.5.6** Wire cron handler: daily 4 AM sync
- [ ] **3.5.7** Add POST /v1/admin/sync/running endpoint
- [ ] **3.5.8** Write tests for sync logic

**3.6 -- Bulk Import**

- [ ] **3.6.1** Create scripts/import-strava.ts (local Node.js script)
- [ ] **3.6.2** Implement paginated activity list fetch
- [ ] **3.6.3** Implement per-activity detail + laps fetch
- [ ] **3.6.4** Implement rate limit monitoring with header parsing
- [ ] **3.6.5** Implement checkpoint/resume (save last processed activity ID)
- [ ] **3.6.6** Implement D1 batch insert (via Wrangler HTTP API or Drizzle HTTP driver)
- [ ] **3.6.7** Test with small batch, then run full import (~1800 activities)

**3.7 -- Webhooks**

- [ ] **3.7.1** Create src/services/strava/webhook.ts (webhook handler)
- [ ] **3.7.2** Create src/routes/webhooks.ts
- [ ] **3.7.3** Implement GET /v1/webhooks/strava (subscription validation)
- [ ] **3.7.4** Implement POST /v1/webhooks/strava (event handler)
- [ ] **3.7.5** Handle create event: fetch + insert activity
- [ ] **3.7.6** Handle update event: re-fetch + update activity
- [ ] **3.7.7** Handle delete event: soft delete activity
- [ ] **3.7.8** Register webhook subscription with Strava
- [ ] **3.7.9** Write tests for webhook handler
- [ ] **3.7.10** Implement webhook idempotency (check webhook_events before processing)

**3.8 -- Route Handlers**

- [ ] **3.8.1** Create src/routes/running.ts
- [ ] **3.8.2** GET /v1/running/stats
- [ ] **3.8.3** GET /v1/running/stats/years
- [ ] **3.8.4** GET /v1/running/stats/years/:year
- [ ] **3.8.5** GET /v1/running/prs
- [ ] **3.8.6** GET /v1/running/recent
- [ ] **3.8.7** GET /v1/running/activities (paginated, filterable)
- [ ] **3.8.8** GET /v1/running/activities/:id
- [ ] **3.8.9** GET /v1/running/activities/:id/splits
- [ ] **3.8.10** GET /v1/running/gear
- [ ] **3.8.11** GET /v1/running/calendar
- [ ] **3.8.12** GET /v1/running/charts/cumulative
- [ ] **3.8.13** GET /v1/running/charts/pace-trend
- [ ] **3.8.14** GET /v1/running/charts/time-of-day
- [ ] **3.8.15** GET /v1/running/charts/elevation
- [ ] **3.8.16** GET /v1/running/cities
- [ ] **3.8.17** GET /v1/running/streaks
- [ ] **3.8.18** GET /v1/running/races
- [ ] **3.8.19** GET /v1/running/eddington
- [ ] **3.8.20** Apply Cache-Control headers per endpoint
- [ ] **3.8.21** Write tests for route handlers

**3.9 -- Integration Testing**

- [ ] **3.9.1** End-to-end test: cron + webhook sync, endpoints return correct responses
- [ ] **3.9.2** Deploy and verify in production
- [ ] **3.9.3** Verify webhook receives events from Strava

## Phase 4: Watching (Plex)

**4.1 -- Schema**

- [ ] **4.1.1** Create src/db/schema/watching.ts (movies, genres, directors, join tables, watch_history, stats, shows, episodes)
- [ ] **4.1.2** Generate migration for Plex tables
- [ ] **4.1.3** Apply migration locally and verify schema
- [ ] **4.1.4** Apply migration to remote D1

**4.2 -- Plex Webhook Handler**

- [ ] **4.2.1** Create src/services/plex/webhook.ts (multipart parser, event handler)
- [ ] **4.2.2** Implement multipart/form-data parsing (Workers-compatible)
- [ ] **4.2.3** Implement webhook source verification (account ID or shared secret)
- [ ] **4.2.4** Implement media.scrobble event handler (record watch event)
- [ ] **4.2.5** Add POST /v1/webhooks/plex to webhooks route
- [ ] **4.2.6** Write tests for webhook handler
- [ ] **4.2.7** Implement webhook idempotency (check webhook_events before processing)

**4.3 -- TMDB Client**

- [ ] **4.3.1** Create src/services/watching/tmdb.ts (TMDB API wrapper, shared across all watching sources)
- [ ] **4.3.2** Implement movie detail fetcher with credits
- [ ] **4.3.3** Implement movie search by title + year
- [ ] **4.3.4** Implement TMDB ID extraction from Plex Guid array
- [ ] **4.3.5** Implement IMDB ID fallback lookup
- [ ] **4.3.6** Write tests for TMDB client

**4.4 -- Sync**

- [ ] **4.4.1** Create src/services/plex/sync.ts (sync orchestrator)
- [ ] **4.4.2** Implement Plex library scan (all watched movies)
- [ ] **4.4.3** Implement TMDB enrichment (genres, directors, ratings on first encounter)
- [ ] **4.4.4** Implement genre and director upsert with join tables
- [ ] **4.4.5** Implement watch stats computation
- [ ] **4.4.6** Add sync_runs recording
- [ ] **4.4.7** Wire cron handler: daily 5 AM library scan catch-up
- [ ] **4.4.8** Add POST /v1/admin/sync/watching endpoint
- [ ] **4.4.9** Write tests for sync logic
- [ ] **4.4.10** Run initial library import against production

**4.5 -- Route Handlers**

- [ ] **4.5.1** Create src/routes/watching.ts
- [ ] **4.5.2** GET /v1/watching/recent
- [ ] **4.5.3** GET /v1/watching/movies (paginated, filterable)
- [ ] **4.5.4** GET /v1/watching/movies/:id
- [ ] **4.5.5** GET /v1/watching/stats
- [ ] **4.5.6** GET /v1/watching/stats/genres
- [ ] **4.5.7** GET /v1/watching/stats/decades
- [ ] **4.5.8** GET /v1/watching/stats/directors
- [ ] **4.5.9** GET /v1/watching/calendar
- [ ] **4.5.10** GET /v1/watching/trends
- [ ] **4.5.11** Apply Cache-Control headers per endpoint
- [ ] **4.5.12** Write tests for route handlers

**4.6 -- Integration Testing**

- [ ] **4.6.1** End-to-end test: webhook + cron sync, endpoints return correct responses
- [ ] **4.6.2** Deploy and verify in production
- [ ] **4.6.3** Configure Plex webhook URL in Plex settings
- [ ] **4.6.4** Verify webhook receives scrobble events from Plex

**4.7 -- TV Shows**

- [ ] **4.7.1** Implement TV show data extraction from Plex library scan
- [ ] **4.7.2** Implement TMDB TV show enrichment
- [ ] **4.7.3** GET /v1/watching/shows
- [ ] **4.7.4** GET /v1/watching/shows/:id
- [ ] **4.7.5** GET /v1/watching/shows/:id/seasons/:season
- [ ] **4.7.6** Wire show webhook events (media.scrobble for episodes)
- [ ] **4.7.7** Write tests for TV show endpoints

**4.8 -- Letterboxd Sync**

- [ ] **4.8.1** Create src/services/letterboxd/client.ts (RSS feed fetcher and parser)
- [ ] **4.8.2** Parse Letterboxd RSS extensions (filmTitle, filmYear, watchedDate, memberRating, rewatch, tmdb:movieId)
- [ ] **4.8.3** Create src/services/letterboxd/sync.ts (sync orchestrator)
- [ ] **4.8.4** Implement dedup check (same movie_id + same calendar date skips insert)
- [ ] **4.8.5** Implement TMDB enrichment for new movies from Letterboxd (reuse watching/tmdb.ts)
- [ ] **4.8.6** Map Letterboxd rating (0.5-5.0) to user_rating field
- [ ] **4.8.7** Wire cron handler: every 6 hours Letterboxd RSS sync
- [ ] **4.8.8** Create scripts/import-letterboxd.ts (one-time CSV import for full diary history)
- [ ] **4.8.9** Write tests for Letterboxd sync

**4.9 -- Manual Movie Entry**

- [ ] **4.9.1** POST /v1/admin/watching/movies (log watch event by tmdb_id or title+year)
- [ ] **4.9.2** PUT /v1/admin/watching/movies/:id (edit watch event)
- [ ] **4.9.3** DELETE /v1/admin/watching/movies/:id (remove watch event)
- [ ] **4.9.4** Implement TMDB search fallback when title+year provided instead of tmdb_id
- [ ] **4.9.5** Implement dedup check for manual entries
- [ ] **4.9.6** Write tests for manual entry endpoints

## Phase 5: Collecting (Discogs)

**5.1 -- Schema**

- [ ] **5.1.1** Create src/db/schema/discogs.ts (releases, artists, collection, wantlist, stats, xref)
- [ ] **5.1.2** Generate migration for Discogs tables
- [ ] **5.1.3** Apply migration locally and verify schema
- [ ] **5.1.4** Apply migration to remote D1

**5.2 -- Discogs API Client**

- [ ] **5.2.1** Create src/services/discogs/client.ts (Discogs API wrapper)
- [ ] **5.2.2** Implement collection fetcher with pagination
- [ ] **5.2.3** Implement wantlist fetcher with pagination
- [ ] **5.2.4** Implement release detail fetcher
- [ ] **5.2.5** Add rate limit handling (60 req/min)
- [ ] **5.2.6** Add User-Agent header (RewindAPI/1.0)
- [ ] **5.2.7** Write tests for API client

**5.3 -- Cross-Reference**

- [ ] **5.3.1** Create src/services/discogs/cross-reference.ts
- [ ] **5.3.2** Implement name normalization (lowercase, trim, remove "The ", remove parenthetical suffixes)
- [ ] **5.3.3** Implement exact match search against lastfm_albums
- [ ] **5.3.4** Implement fuzzy match with Levenshtein distance
- [ ] **5.3.5** Implement artist-only fallback match
- [ ] **5.3.6** Populate collection_listening_xref with play counts
- [ ] **5.3.7** Write tests for cross-reference matching

**5.4 -- Sync**

- [ ] **5.4.1** Create src/services/discogs/sync.ts (sync orchestrator)
- [ ] **5.4.2** Implement full collection sync (compare + insert/update/delete)
- [ ] **5.4.3** Implement wantlist sync
- [ ] **5.4.4** Implement release detail fetch for new releases
- [ ] **5.4.5** Implement collection stats computation (format/genre/decade breakdowns)
- [ ] **5.4.6** Trigger cross-reference after collection sync
- [ ] **5.4.7** Add sync_runs recording
- [ ] **5.4.8** Wire cron handler: weekly Sunday 6 AM
- [ ] **5.4.9** Add POST /v1/admin/sync/collecting endpoint
- [ ] **5.4.10** Write tests for sync logic
- [ ] **5.4.11** Run initial collection import against production

**5.5 -- Route Handlers**

- [ ] **5.5.1** Create src/routes/collecting.ts
- [ ] **5.5.2** GET /v1/collecting/collection (paginated, filterable, searchable)
- [ ] **5.5.3** GET /v1/collecting/stats
- [ ] **5.5.4** GET /v1/collecting/recent
- [ ] **5.5.5** GET /v1/collecting/collection/:id
- [ ] **5.5.6** GET /v1/collecting/wantlist
- [ ] **5.5.7** GET /v1/collecting/formats
- [ ] **5.5.8** GET /v1/collecting/genres
- [ ] **5.5.9** GET /v1/collecting/artists
- [ ] **5.5.10** GET /v1/collecting/cross-reference
- [ ] **5.5.11** Apply Cache-Control headers per endpoint
- [ ] **5.5.12** Write tests for route handlers

**5.6 -- Integration Testing**

- [ ] **5.6.1** End-to-end test: cron sync populates data, endpoints return correct responses
- [ ] **5.6.2** Deploy and verify in production
- [ ] **5.6.3** Verify cross-reference matches against live data

## Phase 6: Cross-Domain Features

**6.1 -- Activity Feed**

- [ ] **6.1.1** Create src/routes/feed.ts
- [ ] **6.1.2** Implement activity_feed population during each domain's sync
- [ ] **6.1.3** GET /v1/feed (cross-domain activity feed, all domains)
- [ ] **6.1.4** GET /v1/feed/domain/:domain (single-domain feed)
- [ ] **6.1.5** Implement feed pagination with cursor-based approach
- [ ] **6.1.6** Apply Cache-Control headers (5-minute cache)
- [ ] **6.1.7** Write tests for feed endpoints

**6.2 -- Health Dashboard**

- [ ] **6.2.1** Implement GET /v1/health/sync (last sync status per domain)
- [ ] **6.2.2** Add sync duration tracking
- [ ] **6.2.3** Add error rate tracking per domain
- [ ] **6.2.4** Write tests for health endpoints

**6.3 -- Hono RPC Export**

- [ ] **6.3.1** Export AppType from src/index.ts
- [ ] **6.3.2** Configure package.json exports for type inference
- [ ] **6.3.3** Verify RPC types compile correctly with sample client
- [ ] **6.3.4** Publish types as npm package or use direct git reference

**6.4 -- Global Search**

- [ ] **6.4.1** Create FTS5 virtual tables for cross-domain search
- [ ] **6.4.2** Implement search indexing during sync for each domain
- [ ] **6.4.3** GET /v1/search (cross-domain full-text search)
- [ ] **6.4.4** Write tests for search endpoint

**6.5 -- Data Export**

- [ ] **6.5.1** GET /v1/export/:domain (full domain data as JSON, admin key required)
- [ ] **6.5.2** Implement streaming JSON response for large datasets
- [ ] **6.5.3** Write tests for export endpoint

**6.6 -- API Key Management**

- [ ] **6.6.1** POST /v1/admin/keys (create new API key)
- [ ] **6.6.2** GET /v1/admin/keys (list all keys, prefix + hint only)
- [ ] **6.6.3** DELETE /v1/admin/keys/:id (revoke a key)
- [ ] **6.6.4** Write tests for key management endpoints

## Phase 7: Portfolio Integration

**7.1 -- pat-portfolio Migration**

- [ ] **7.1.1** Install Hono client in pat-portfolio
- [ ] **7.1.2** Create rewind client module with hc<AppType>("https://api.rewind.rest")
- [ ] **7.1.3** Replace Last.fm direct API calls with rewind client calls
- [ ] **7.1.4** Remove lib/listening/lastfm.ts from pat-portfolio
- [ ] **7.1.5** Remove lib/listening/filters.ts from pat-portfolio
- [ ] **7.1.6** Remove app/api/listening/\* routes from pat-portfolio
- [ ] **7.1.7** Update listening UI components to use rewind response types
- [ ] **7.1.8** Add ThumbHash blur placeholder rendering
- [ ] **7.1.9** Register revalidation hook URL for on-demand ISR revalidation
- [ ] **7.1.10** Implement server-side-only API consumption (key in Vercel env var, never in browser)

**7.2 -- New Portfolio Features**

- [ ] **7.2.1** Add running data display to pat-portfolio (using rewind API)
- [ ] **7.2.2** Add movie watch history display to pat-portfolio
- [ ] **7.2.3** Add vinyl collection display to pat-portfolio
- [ ] **7.2.4** Add cross-domain activity feed to pat-portfolio
- [ ] **7.2.5** Add image CDN integration with responsive srcset
- [ ] **7.2.6** Verify all features work in production

**7.3 -- Cleanup**

- [ ] **7.3.1** Remove all unused listening infrastructure from pat-portfolio
- [ ] **7.3.2** Update pat-portfolio documentation
- [ ] **7.3.3** Final production verification of all domains
