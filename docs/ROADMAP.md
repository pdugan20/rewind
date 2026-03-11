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

- [x] **1.1.1** Create src/db/schema/lastfm.ts (artists, albums, tracks, scrobbles, top\_\*, filters, user_stats)
- [x] **1.1.2** Generate migration for Last.fm tables
- [x] **1.1.3** Apply migration locally and verify schema
- ~~**1.1.4** Apply migration to remote D1~~ (moved to Phase 6.5)

**1.2 -- Last.fm API Client**

- [x] **1.2.1** Create src/services/lastfm/client.ts (Last.fm API wrapper)
- [x] **1.2.2** Implement user.getRecentTracks fetcher with pagination
- [x] **1.2.3** Implement user.getTopArtists/Albums/Tracks fetchers
- [x] **1.2.4** Implement user.getInfo fetcher
- [x] **1.2.5** Add rate limit handling (5 req/sec)
- [x] **1.2.6** Write tests for API client

**1.3 -- Transforms and Filters**

- [x] **1.3.1** Create src/services/lastfm/transforms.ts (normalize artist/album/track data)
- [x] **1.3.2** Create src/services/lastfm/filters.ts (holiday music, audiobook detection)
- ~~**1.3.3** Seed lastfm_filters table with initial filter patterns~~ (moved to Phase 6.5)
- [x] **1.3.4** Implement over-fetch + filter + re-rank strategy for top lists
- [x] **1.3.5** Write tests for transforms and filters

**1.4 -- Sync**

- [x] **1.4.1** Create src/services/lastfm/sync.ts (sync orchestrator)
- [x] **1.4.2** Implement incremental scrobble sync (from last timestamp)
- [x] **1.4.3** Implement top lists sync (all 6 periods x 3 entity types)
- [x] **1.4.4** Implement user stats sync
- [x] **1.4.5** Implement full historical backfill (one-time, ~124K scrobbles)
- [x] **1.4.6** Add sync_runs recording (start, complete, item count, errors)
- [x] **1.4.7** Wire cron handler: 15-min scrobble sync, daily 3 AM top lists + stats
- [x] **1.4.8** Add POST /v1/admin/sync/listening endpoint
- [x] **1.4.9** Write tests for sync logic
- [x] **1.4.10** Implement revalidation hook callback after sync completes

**1.5 -- Route Handlers**

- [x] **1.5.1** Create src/routes/listening.ts
- [x] **1.5.2** GET /v1/listening/now-playing
- [x] **1.5.3** GET /v1/listening/recent
- [x] **1.5.4** GET /v1/listening/top/artists
- [x] **1.5.5** GET /v1/listening/top/albums
- [x] **1.5.6** GET /v1/listening/top/tracks
- [x] **1.5.7** GET /v1/listening/stats
- [x] **1.5.8** GET /v1/listening/history
- [x] **1.5.9** GET /v1/listening/artists/:id
- [x] **1.5.10** GET /v1/listening/albums/:id
- [x] **1.5.11** GET /v1/listening/calendar
- [x] **1.5.12** GET /v1/listening/trends
- [x] **1.5.13** GET /v1/listening/streaks
- [x] **1.5.14** Apply Cache-Control headers per endpoint
- [x] **1.5.15** Write tests for route handlers

**1.6 -- Integration Testing**

- [x] **1.6.1** End-to-end test: cron trigger syncs data, endpoints return correct responses
- ~~**1.6.2** Deploy and verify in production~~ (moved to Phase 6.5)
- ~~**1.6.3** Run initial historical backfill against production D1~~ (moved to Phase 6.5)

## Phase 2: Image Pipeline

**2.1 -- R2 and CDN Setup**

- ~~**2.1.1** Configure R2 bucket custom domain (cdn.rewind.rest)~~ (moved to Phase 6.5)
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

**2.6 -- Integration (Listening)**

- [x] **2.6.1** Backfill images for existing Last.fm albums (from Phase 1)
- [x] **2.6.2** Backfill images for existing Last.fm artists
- ~~**2.6.3** Verify CDN delivery and transforms in production~~ (moved to Phase 6.5)
- [x] **2.6.4** Create default placeholder image in R2

**2.7 -- Integration (Watching)**

- [x] **2.7.1** Update watching routes to join against images table and return thumbhash, dominant_color, accent_color for movies
- [x] **2.7.2** Update watching routes to join against images table and return thumbhash, dominant_color, accent_color for TV shows
- [x] **2.7.3** Backfill images for existing movies (run pipeline for all movies with poster_path)
- [x] **2.7.4** Backfill images for existing TV shows (run pipeline for all shows with poster_path)
- [x] **2.7.5** Verify movie and show images served correctly via cdn.rewind.rest

**2.8 -- Integration (Collecting)**

- [x] **2.8.1** Update collecting routes to join against images table and return thumbhash, dominant_color, accent_color for releases
- [ ] **2.8.2** Backfill images for existing Discogs releases -- endpoint built, blocked on Discogs import (6.5.3.5)
- [ ] **2.8.3** Verify release images served correctly via cdn.rewind.rest

## Phase 3: Running (Strava)

**3.1 -- Schema**

- [x] **3.1.1** Create src/db/schema/strava.ts (activities, gear, PRs, year_summaries, lifetime_stats, splits, tokens)
- [x] **3.1.2** Generate migration for Strava tables
- [x] **3.1.3** Apply migration locally and verify schema
- ~~**3.1.4** Apply migration to remote D1~~ (moved to Phase 6.5)

**3.2 -- OAuth**

- [x] **3.2.1** Create src/services/strava/auth.ts (token refresh with rotation persistence)
- [x] **3.2.2** Add strava_tokens table to schema for runtime token storage
- [x] **3.2.3** Implement getAccessToken with 5-minute expiry buffer
- [x] **3.2.4** Implement token refresh with new refresh_token persistence
- [x] **3.2.5** Write tests for OAuth flow

**3.3 -- Strava API Client**

- [x] **3.3.1** Create src/services/strava/client.ts (Strava API wrapper)
- [x] **3.3.2** Implement /athlete/activities fetcher with pagination
- [x] **3.3.3** Implement /activities/{id} detail fetcher
- [x] **3.3.4** Implement /activities/{id}/laps fetcher
- [x] **3.3.5** Implement /athlete/stats fetcher
- [x] **3.3.6** Implement /gear/{id} fetcher
- [x] **3.3.7** Add rate limit handling (200/15min, 2000/day) with header parsing
- [x] **3.3.8** Write tests for API client

**3.4 -- Transforms**

- [x] **3.4.1** Create src/services/strava/transforms.ts
- [x] **3.4.2** Implement unit conversions (meters to miles/feet, m/s to min/mile)
- [x] **3.4.3** Implement pace formatting (MM:SS/mi)
- [x] **3.4.4** Implement duration formatting
- [x] **3.4.5** Implement personal records extraction from best_efforts
- [x] **3.4.6** Implement year summary computation
- [x] **3.4.7** Implement lifetime stats computation
- [x] **3.4.8** Implement streak calculation (current + longest)
- [x] **3.4.9** Implement Eddington number calculation
- [x] **3.4.10** Write tests for all transforms

**3.5 -- Sync**

- [x] **3.5.1** Create src/services/strava/sync.ts (sync orchestrator)
- [x] **3.5.2** Implement incremental activity sync (since last synced activity)
- [x] **3.5.3** Implement gear sync
- [x] **3.5.4** Implement stats recomputation after sync (PRs, years, lifetime, streaks)
- [x] **3.5.5** Add sync_runs recording
- [x] **3.5.6** Wire cron handler: daily 4 AM sync
- [x] **3.5.7** Add POST /v1/admin/sync/running endpoint
- [x] **3.5.8** Write tests for sync logic

~~**3.6 -- Bulk Import**~~ (moved to Phase 6.5)

**3.7 -- Webhooks**

- [x] **3.7.1** Create src/services/strava/webhook.ts (webhook handler)
- [x] **3.7.2** Create src/routes/webhooks.ts
- [x] **3.7.3** Implement GET /v1/webhooks/strava (subscription validation)
- [x] **3.7.4** Implement POST /v1/webhooks/strava (event handler)
- [x] **3.7.5** Handle create event: fetch + insert activity
- [x] **3.7.6** Handle update event: re-fetch + update activity
- [x] **3.7.7** Handle delete event: soft delete activity
- ~~**3.7.8** Register webhook subscription with Strava~~ (moved to Phase 6.5)
- [x] **3.7.9** Write tests for webhook handler
- [x] **3.7.10** Implement webhook idempotency (check webhook_events before processing)

**3.8 -- Route Handlers**

- [x] **3.8.1** Create src/routes/running.ts
- [x] **3.8.2** GET /v1/running/stats
- [x] **3.8.3** GET /v1/running/stats/years
- [x] **3.8.4** GET /v1/running/stats/years/:year
- [x] **3.8.5** GET /v1/running/prs
- [x] **3.8.6** GET /v1/running/recent
- [x] **3.8.7** GET /v1/running/activities (paginated, filterable)
- [x] **3.8.8** GET /v1/running/activities/:id
- [x] **3.8.9** GET /v1/running/activities/:id/splits
- [x] **3.8.10** GET /v1/running/gear
- [x] **3.8.11** GET /v1/running/calendar
- [x] **3.8.12** GET /v1/running/charts/cumulative
- [x] **3.8.13** GET /v1/running/charts/pace-trend
- [x] **3.8.14** GET /v1/running/charts/time-of-day
- [x] **3.8.15** GET /v1/running/charts/elevation
- [x] **3.8.16** GET /v1/running/cities
- [x] **3.8.17** GET /v1/running/streaks
- [x] **3.8.18** GET /v1/running/races
- [x] **3.8.19** GET /v1/running/eddington
- [x] **3.8.20** Apply Cache-Control headers per endpoint
- [x] **3.8.21** Write tests for route handlers

**3.9 -- Integration Testing**

- [x] **3.9.1** End-to-end test: cron + webhook sync, endpoints return correct responses
- ~~**3.9.2** Deploy and verify in production~~ (moved to Phase 6.5)
- ~~**3.9.3** Verify webhook receives events from Strava~~ (moved to Phase 6.5)

## Phase 4: Watching (Plex)

**4.1 -- Schema**

- [x] **4.1.1** Create src/db/schema/watching.ts (movies, genres, directors, join tables, watch_history, stats, shows, episodes)
- [x] **4.1.2** Generate migration for Plex tables
- [x] **4.1.3** Apply migration locally and verify schema
- ~~**4.1.4** Apply migration to remote D1~~ (moved to Phase 6.5)

**4.2 -- Plex Webhook Handler**

- [x] **4.2.1** Create src/services/plex/webhook.ts (multipart parser, event handler)
- [x] **4.2.2** Implement multipart/form-data parsing (Workers-compatible)
- [x] **4.2.3** Implement webhook source verification (account ID or shared secret)
- [x] **4.2.4** Implement media.scrobble event handler (record watch event)
- [x] **4.2.5** Add POST /v1/webhooks/plex to webhooks route
- [x] **4.2.6** Write tests for webhook handler
- [x] **4.2.7** Implement webhook idempotency (check webhook_events before processing)

**4.3 -- TMDB Client**

- [x] **4.3.1** Create src/services/watching/tmdb.ts (TMDB API wrapper, shared across all watching sources)
- [x] **4.3.2** Implement movie detail fetcher with credits
- [x] **4.3.3** Implement movie search by title + year
- [x] **4.3.4** Implement TMDB ID extraction from Plex Guid array
- [x] **4.3.5** Implement IMDB ID fallback lookup
- [x] **4.3.6** Write tests for TMDB client

**4.4 -- Sync**

- [x] **4.4.1** Create src/services/plex/sync.ts (sync orchestrator)
- [x] **4.4.2** Implement Plex library scan (all watched movies)
- [x] **4.4.3** Implement TMDB enrichment (genres, directors, ratings on first encounter)
- [x] **4.4.4** Implement genre and director upsert with join tables
- [x] **4.4.5** Implement watch stats computation
- [x] **4.4.6** Add sync_runs recording
- [x] **4.4.7** Wire cron handler: daily 5 AM library scan catch-up
- [x] **4.4.8** Add POST /v1/admin/sync/watching endpoint
- [x] **4.4.9** Write tests for sync logic
- ~~**4.4.10** Run initial library import against production~~ (moved to Phase 6.5)

**4.5 -- Route Handlers**

- [x] **4.5.1** Create src/routes/watching.ts
- [x] **4.5.2** GET /v1/watching/recent
- [x] **4.5.3** GET /v1/watching/movies (paginated, filterable)
- [x] **4.5.4** GET /v1/watching/movies/:id
- [x] **4.5.5** GET /v1/watching/stats
- [x] **4.5.6** GET /v1/watching/stats/genres
- [x] **4.5.7** GET /v1/watching/stats/decades
- [x] **4.5.8** GET /v1/watching/stats/directors
- [x] **4.5.9** GET /v1/watching/calendar
- [x] **4.5.10** GET /v1/watching/trends
- [x] **4.5.11** Apply Cache-Control headers per endpoint
- [x] **4.5.12** Write tests for route handlers

**4.6 -- Integration Testing**

- [x] **4.6.1** End-to-end test: webhook + cron sync, endpoints return correct responses
- ~~**4.6.2** Deploy and verify in production~~ (moved to Phase 6.5)
- ~~**4.6.3** Configure Plex webhook URL in Plex settings~~ (moved to Phase 6.5)
- ~~**4.6.4** Verify webhook receives scrobble events from Plex~~ (moved to Phase 6.5)

**4.7 -- TV Shows**

- [x] **4.7.1** Implement TV show data extraction from Plex library scan
- [x] **4.7.2** Implement TMDB TV show enrichment
- [x] **4.7.3** GET /v1/watching/shows
- [x] **4.7.4** GET /v1/watching/shows/:id
- [x] **4.7.5** GET /v1/watching/shows/:id/seasons/:season
- [x] **4.7.6** Wire show webhook events (media.scrobble for episodes)
- [x] **4.7.7** Write tests for TV show endpoints
- [x] **4.7.8** Add poster_path, backdrop_path, content_rating, tmdb_rating columns to plex_shows schema
- [x] **4.7.9** Generate and apply migration for new plex_shows columns
- [x] **4.7.10** Store poster_path, year, backdrop_path, content_rating, tmdb_rating from TMDB during library sync (plex/sync.ts)
- [x] **4.7.11** Store same fields during webhook upsert (plex/webhook.ts upsertShowFromPlex)
- [x] **4.7.12** Update watching routes to return actual poster_url from stored poster_path instead of null
- [x] **4.7.13** Add TV episode counts and watch time to computeWatchStats
- [x] **4.7.14** Update tests for TV show schema and sync changes

**4.8 -- Letterboxd Sync**

- [x] **4.8.1** Create src/services/letterboxd/client.ts (RSS feed fetcher and parser)
- [x] **4.8.2** Parse Letterboxd RSS extensions (filmTitle, filmYear, watchedDate, memberRating, rewatch, tmdb:movieId)
- [x] **4.8.3** Create src/services/letterboxd/sync.ts (sync orchestrator)
- [x] **4.8.4** Implement dedup check (same movie_id + same calendar date skips insert)
- [x] **4.8.5** Implement TMDB enrichment for new movies from Letterboxd (reuse watching/tmdb.ts)
- [x] **4.8.6** Map Letterboxd rating (0.5-5.0) to user_rating field
- [x] **4.8.7** Wire cron handler: every 6 hours Letterboxd RSS sync
- ~~**4.8.8** Create scripts/import-letterboxd.ts~~ (moved to Phase 6.5)
- [x] **4.8.9** Write tests for Letterboxd sync

**4.9 -- Manual Movie Entry**

- [x] **4.9.1** POST /v1/admin/watching/movies (log watch event by tmdb_id or title+year)
- [x] **4.9.2** PUT /v1/admin/watching/movies/:id (edit watch event)
- [x] **4.9.3** DELETE /v1/admin/watching/movies/:id (remove watch event)
- [x] **4.9.4** Implement TMDB search fallback when title+year provided instead of tmdb_id
- [x] **4.9.5** Implement dedup check for manual entries
- [x] **4.9.6** Write tests for manual entry endpoints

## Phase 5: Collecting (Discogs)

**5.1 -- Schema**

- [x] **5.1.1** Create src/db/schema/discogs.ts (releases, artists, collection, wantlist, stats, xref)
- [x] **5.1.2** Generate migration for Discogs tables
- [x] **5.1.3** Apply migration locally and verify schema
- ~~**5.1.4** Apply migration to remote D1~~ (moved to Phase 6.5)

**5.2 -- Discogs API Client**

- [x] **5.2.1** Create src/services/discogs/client.ts (Discogs API wrapper)
- [x] **5.2.2** Implement collection fetcher with pagination
- [x] **5.2.3** Implement wantlist fetcher with pagination
- [x] **5.2.4** Implement release detail fetcher
- [x] **5.2.5** Add rate limit handling (60 req/min)
- [x] **5.2.6** Add User-Agent header (RewindAPI/1.0)
- [x] **5.2.7** Write tests for API client

**5.3 -- Cross-Reference**

- [x] **5.3.1** Create src/services/discogs/cross-reference.ts
- [x] **5.3.2** Implement name normalization (lowercase, trim, remove "The ", remove parenthetical suffixes)
- [x] **5.3.3** Implement exact match search against lastfm_albums
- [x] **5.3.4** Implement fuzzy match with Levenshtein distance
- [x] **5.3.5** Implement artist-only fallback match
- [x] **5.3.6** Populate collection_listening_xref with play counts
- [x] **5.3.7** Write tests for cross-reference matching

**5.4 -- Sync**

- [x] **5.4.1** Create src/services/discogs/sync.ts (sync orchestrator)
- [x] **5.4.2** Implement full collection sync (compare + insert/update/delete)
- [x] **5.4.3** Implement wantlist sync
- [x] **5.4.4** Implement release detail fetch for new releases
- [x] **5.4.5** Implement collection stats computation (format/genre/decade breakdowns)
- [x] **5.4.6** Trigger cross-reference after collection sync
- [x] **5.4.7** Add sync_runs recording
- [x] **5.4.8** Wire cron handler: weekly Sunday 6 AM
- [x] **5.4.9** Add POST /v1/admin/sync/collecting endpoint
- [x] **5.4.10** Write tests for sync logic
- ~~**5.4.11** Run initial collection import against production~~ (moved to Phase 6.5)

**5.5 -- Route Handlers**

- [x] **5.5.1** Create src/routes/collecting.ts
- [x] **5.5.2** GET /v1/collecting/collection (paginated, filterable, searchable)
- [x] **5.5.3** GET /v1/collecting/stats
- [x] **5.5.4** GET /v1/collecting/recent
- [x] **5.5.5** GET /v1/collecting/collection/:id
- [x] **5.5.6** GET /v1/collecting/wantlist
- [x] **5.5.7** GET /v1/collecting/formats
- [x] **5.5.8** GET /v1/collecting/genres
- [x] **5.5.9** GET /v1/collecting/artists
- [x] **5.5.10** GET /v1/collecting/cross-reference
- [x] **5.5.11** Apply Cache-Control headers per endpoint
- [x] **5.5.12** Write tests for route handlers

**5.6 -- Integration Testing**

- [x] **5.6.1** End-to-end test: cron sync populates data, endpoints return correct responses
- ~~**5.6.2** Deploy and verify in production~~ (moved to Phase 6.5)
- ~~**5.6.3** Verify cross-reference matches against live data~~ (moved to Phase 6.5)

## Phase 6: Cross-Domain Features

**6.1 -- Activity Feed**

- [x] **6.1.1** Create src/routes/feed.ts
- [x] **6.1.2** Implement activity_feed population during each domain's sync
- [x] **6.1.3** GET /v1/feed (cross-domain activity feed, all domains)
- [x] **6.1.4** GET /v1/feed/domain/:domain (single-domain feed)
- [x] **6.1.5** Implement feed pagination with cursor-based approach
- [x] **6.1.6** Apply Cache-Control headers (5-minute cache)
- [x] **6.1.7** Write tests for feed endpoints

**6.2 -- Health Dashboard**

- [x] **6.2.1** Implement GET /v1/health/sync (last sync status per domain)
- [x] **6.2.2** Add sync duration tracking
- [x] **6.2.3** Add error rate tracking per domain
- [x] **6.2.4** Write tests for health endpoints

**6.3 -- Hono RPC Export**

- [x] **6.3.1** Export AppType from src/index.ts
- [x] **6.3.2** Configure package.json exports for type inference
- [x] **6.3.3** Verify RPC types compile correctly with sample client
- [x] **6.3.4** Publish types as npm package or use direct git reference

**6.4 -- Global Search**

- [x] **6.4.1** Create FTS5 virtual tables for cross-domain search
- [x] **6.4.2** Implement search indexing during sync for each domain
- [x] **6.4.3** GET /v1/search (cross-domain full-text search)
- [x] **6.4.4** Write tests for search endpoint

**6.5 -- Data Export**

- [x] **6.5.1** GET /v1/export/:domain (full domain data as JSON, admin key required)
- [x] **6.5.2** Implement streaming JSON response for large datasets
- [x] **6.5.3** Write tests for export endpoint

**6.6 -- API Key Management**

- [x] **6.6.1** POST /v1/admin/keys (create new API key)
- [x] **6.6.2** GET /v1/admin/keys (list all keys, prefix + hint only)
- [x] **6.6.3** DELETE /v1/admin/keys/:id (revoke a key)
- [x] **6.6.4** Write tests for key management endpoints

## Phase 6.5: Production Deployment

**6.5.1 -- Deploy**

- [x] **6.5.1.1** Apply all domain migrations to remote D1 (listening, running, watching, collecting)
- [x] **6.5.1.2** Deploy worker to Cloudflare Workers
- [x] **6.5.1.3** Configure R2 bucket custom domain (cdn.rewind.rest)
- [x] **6.5.1.4** Verify /v1/health endpoint responds in production
- [x] **6.5.1.5** Wire up DB-driven filters: make sync read from lastfm_filters table instead of hardcoded values in filters.ts, then seed table with existing patterns

**6.5.2 -- Import Scripts**

- [x] **6.5.2.1** Create scripts/import-strava.ts (paginated fetch, detail + laps per activity, rate limit monitoring, checkpoint/resume, D1 batch insert)
- [x] **6.5.2.2** Create scripts/import-letterboxd.ts (one-time CSV import for full diary history)
- [x] **6.5.2.3** Create scripts/import-lastfm.ts (batched SQL, checkpoint/resume, filter application)

**6.5.3 -- Initial Data Imports**

- [x] **6.5.3.1** Run Last.fm historical backfill (~124K scrobbles) -- 123,793 imported
- [ ] **6.5.3.2** Run Strava bulk import (~1347 activities) -- in progress, 821/1347 (restarted after rate-limit stall)
- [x] **6.5.3.3** Run Plex library import (368 movies, 1582 TV episodes) -- 400 movies, 98 shows, 1569 episodes imported. All images backfilled to R2.
- [ ] **6.5.3.4** Run Letterboxd CSV import -- requires user's diary.csv export
- [x] **6.5.3.5a** Update Discogs collection -- bulk added 139 items (33 CDs + 106 vinyl) via scripts/add-discogs-collection.ts, collection now ~284 items
- [ ] **6.5.3.5b** Run Discogs collection import (last -- cross-refs against Last.fm data)

**6.5.4 -- Webhooks**

- [x] **6.5.4.1** Register Strava webhook subscription (ID: 334423)
- [ ] **6.5.4.2** Configure Plex webhook URL in Plex settings

**6.5.5 -- Production Verification**

- [ ] **6.5.5.1** Verify all listening endpoints return correct data
- [ ] **6.5.5.2** Verify all running endpoints return correct data
- [ ] **6.5.5.3** Verify all watching endpoints return correct data
- [ ] **6.5.5.4** Verify all collecting endpoints return correct data
- [ ] **6.5.5.5** Verify cross-domain feed and search endpoints
- [ ] **6.5.5.6** Verify CDN delivery and image transforms
- [ ] **6.5.5.7** Verify Strava webhook receives events
- [ ] **6.5.5.8** Verify Plex webhook receives scrobble events
- [ ] **6.5.5.9** Verify cron syncs are running on schedule
- [ ] **6.5.5.10** Verify Discogs cross-reference matches against live data

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

## Phase 8: Physical Media Collecting (Trakt)

**8.1 -- Schema and Environment**

- [x] **8.1.1** Create src/db/schema/trakt.ts (trakt_tokens, trakt_collection, trakt_collection_stats tables)
- [x] **8.1.2** Add TRAKT_CLIENT_ID, TRAKT_CLIENT_SECRET to src/types/env.ts
- [x] **8.1.3** Generate migration for Trakt tables (npm run db:generate)
- [x] **8.1.4** Apply migration locally and verify schema (npm run db:migrate)

**8.2 -- OAuth and Auth**

- [x] **8.2.1** Create src/services/trakt/auth.ts (token management, mirroring Strava pattern)
- [x] **8.2.2** Implement getAccessToken with expiry buffer and refresh
- [x] **8.2.3** Implement refreshAccessToken with token persistence to trakt_tokens
- [x] **8.2.4** Create scripts/setup-trakt.ts (device code OAuth flow for initial token seeding)
- [x] **8.2.5** Run setup script to authenticate and seed trakt_tokens

**8.3 -- Trakt API Client**

- [x] **8.3.1** Create src/services/trakt/client.ts (Trakt API wrapper)
- [x] **8.3.2** Implement getCollection (GET /sync/collection/movies?extended=metadata)
- [x] **8.3.3** Implement addToCollection (POST /sync/collection)
- [x] **8.3.4** Implement removeFromCollection (POST /sync/collection/remove)
- [x] **8.3.5** Implement searchMovie (GET /search/movie)
- [x] **8.3.6** Add rate limit handling and required Trakt headers (trakt-api-version, trakt-api-key)
- [x] **8.3.7** Write tests for API client

**8.4 -- Sync Service**

- [x] **8.4.1** Create src/services/trakt/sync.ts (sync orchestrator)
- [x] **8.4.2** Implement full collection sync (fetch from Trakt, look up/create movies via TMDb, upsert trakt_collection rows)
- [x] **8.4.3** Implement deletion of local items removed from Trakt
- [x] **8.4.4** Implement collection stats computation (by_format, by_resolution, by_hdr, by_genre, by_decade)
- [x] **8.4.5** Add sync_runs recording (domain: 'collecting', syncType: 'trakt')
- [x] **8.4.6** Write tests for sync logic

**8.5 -- Route Handlers**

- [x] **8.5.1** GET /v1/collecting/media (paginated, filterable by format/genre/search/sort)
- [x] **8.5.2** GET /v1/collecting/media/:id (detail with media specs + watch history cross-ref)
- [x] **8.5.3** GET /v1/collecting/media/stats (format/resolution/HDR/genre/decade breakdowns)
- [x] **8.5.4** GET /v1/collecting/media/recent (latest additions)
- [x] **8.5.5** GET /v1/collecting/media/formats (format counts)
- [x] **8.5.6** GET /v1/collecting/media/cross-reference (owned vs watched cross-ref with watching domain)
- [x] **8.5.7** POST /v1/admin/collecting/media (add item: resolve via TMDb, push to Trakt, store locally)
- [x] **8.5.8** POST /v1/admin/collecting/media/:id/remove (remove from Trakt + local)
- [x] **8.5.9** POST /v1/admin/sync/trakt (manual sync trigger)
- [x] **8.5.10** POST /v1/admin/collecting/media/backfill-images (image pipeline for posters)
- [x] **8.5.11** Apply Cache-Control headers per endpoint
- [x] **8.5.12** Write tests for route handlers

**8.6 -- Cron Integration**

- [x] **8.6.1** Wire Trakt sync into 0 3 * * * cron handler (Sunday only, alongside Discogs)
- [x] **8.6.2** Import syncTraktCollection in src/index.ts

**8.7 -- Cataloging**

- [x] **8.7.1** Set Trakt secrets via wrangler secret put (TRAKT_CLIENT_ID, TRAKT_CLIENT_SECRET)
- [x] **8.7.2** Apply migration to remote D1 (npm run db:remote)
- [x] **8.7.3** Deploy worker with Trakt integration
- [x] **8.7.4** Add User-Agent header to Trakt client and auth to fix Cloudflare-to-Cloudflare WAF blocking
- [x] **8.7.5** Wire image pipeline (runPipeline) into POST /admin/collecting/media so images process inline on add
- [x] **8.7.6** Deploy and verify Trakt sync works from production Worker
- [x] **8.7.7** Catalog physical media collection via POST /v1/admin/collecting/media -- 88 items (49 Blu-ray, 28 UHD, 11 HD-DVD)
- [x] **8.7.8** Verify collection syncs from Trakt and appears in GET /collecting/media -- sync round-trips correctly, UHD detection via resolution=uhd_4k
- [x] **8.7.9** Verify cross-reference with watching domain (owned vs watched) -- join works, shows watch_count and last_watched
- [x] **8.7.10** Verify poster images processed for collection items -- thumbhash, dominant_color, accent_color all populated inline on add

**8.8 -- Documentation**

- [x] **8.8.1** Update CLAUDE.md with Trakt environment variables and service structure
- [x] **8.8.2** Update docs/ARCHITECTURE.md with Trakt sync flow and schema
- [x] **8.8.3** Update docs/API.md with new /collecting/media endpoints
- [x] **8.8.4** Update docs/domains/collecting.md with physical media domain details
- ~~**8.8.5** Update docs/domains/images.md if image pipeline changes are needed~~ (no changes needed -- existing pipeline handles collecting/media via TMDb poster source)
