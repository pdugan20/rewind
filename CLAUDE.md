# Rewind

Personal data aggregation service. Syncs data from Strava, Last.fm, Discogs, Plex, and Letterboxd into Cloudflare D1, serves via REST API at `api.rewind.rest` with an image CDN at `cdn.rewind.rest`.

## Development Commands

```bash
npm run dev          # Start local dev server (wrangler dev)
npm run deploy       # Deploy to Cloudflare Workers
npm run db:generate  # Generate Drizzle migrations from schema changes
npm run db:migrate   # Apply migrations to local D1
npm run db:remote    # Apply migrations to remote D1
npm run db:studio    # Open Drizzle Studio (local D1)
npm run lint         # ESLint
npm run format       # Prettier
npm run lint:claude  # claudelint (validate Claude Code files)
npm test             # Vitest
```

## Architecture Overview

Hono on Cloudflare Workers with D1 (SQLite) for structured data, R2 for image storage, and Cloudflare Images for on-the-fly transforms. Drizzle ORM for type-safe database access. Hono RPC for end-to-end type inference with consuming clients. All routes prefixed with `/v1/`. API key authentication on all endpoints (Bearer token). Multi-user ready (`user_id` on all tables).

Four data domains: listening (Last.fm), running (Strava), watching (Plex + Letterboxd + manual), collecting (Discogs). Each domain has its own sync worker (cron-triggered), database tables, and route handlers.

## Project Structure

```text
src/
  index.ts                 -- Hono app entry, route registration, cron handler
  routes/
    system.ts              -- GET /v1/health, GET /v1/health/sync, POST /v1/admin/sync, key management
    listening.ts           -- 12 listening endpoints (includes streaks)
    running.ts             -- 18 running endpoints
    watching.ts            -- 15 watching endpoints (movies + TV shows + manual entry)
    collecting.ts          -- 9 collection endpoints
    feed.ts                -- 2 cross-domain feed endpoints
    images.ts              -- 4 image endpoints (proxy + admin overrides)
    webhooks.ts            -- Strava + Plex webhook receivers
    search.ts              -- 1 cross-domain search endpoint
  db/
    client.ts              -- Drizzle D1 client setup
    schema/
      system.ts            -- sync_runs, activity_feed, images, api_keys, webhook_events, revalidation_hooks
      lastfm.ts            -- Last.fm domain tables
      strava.ts            -- Strava domain tables + strava_tokens
      watching.ts           -- Watching domain tables (movies, watch_history, shows, episodes)
      discogs.ts           -- Discogs domain tables
  services/
    lastfm/                -- Last.fm API client, transforms, filters, sync
    strava/                -- Strava OAuth, API client, transforms, sync
    plex/                  -- Plex webhook handler, library scanner, sync
    letterboxd/            -- Letterboxd RSS feed parser, sync
    watching/              -- Shared TMDB client for all watching sources
    discogs/               -- Discogs API client, transforms, cross-ref, sync
    images/                -- Image pipeline (sources, storage, thumbhash, color extraction)
  lib/
    auth.ts                -- API key authentication middleware (Bearer token)
    cors.ts                -- CORS middleware (configurable origins)
    errors.ts              -- Error response helpers
    cache.ts               -- Cache-Control header helpers
  types/
    env.ts                 -- Cloudflare bindings (Env interface)
migrations/                -- D1 SQL migration files
docs/                      -- Project documentation
```

## Key Conventions

- All route handlers return JSON with consistent shapes
- All endpoints require `Authorization: Bearer rw_...` header. Read keys access GET endpoints. Admin keys access all endpoints.
- All domain tables include `user_id` (default 1) for multi-user readiness
- Error responses: `{ "error": "message", "status": 404 }`
- Cache-Control headers set per endpoint group (see docs/ARCHITECTURE.md)
- Image responses include `dominant_color` and `accent_color` hex values alongside `thumbhash`
- No emojis in logging -- use `[INFO]`, `[ERROR]`, `[SYNC]` prefixes
- All dates stored and returned as ISO 8601 strings
- Pagination: `{ data: [...], pagination: { page, limit, total, total_pages } }`

## Environment Variables

| Variable                      | Domain     | Description                                                                 |
| ----------------------------- | ---------- | --------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS`             | System     | CORS allowed origins (comma-separated, default: patdugan.me,localhost:3000) |
| `LASTFM_API_KEY`              | Listening  | Last.fm API key                                                             |
| `LASTFM_USERNAME`             | Listening  | Last.fm username (pdugan20)                                                 |
| `STRAVA_CLIENT_ID`            | Running    | Strava OAuth app client ID                                                  |
| `STRAVA_CLIENT_SECRET`        | Running    | Strava OAuth app client secret                                              |
| `STRAVA_WEBHOOK_VERIFY_TOKEN` | Running    | Strava webhook validation token                                             |
| `PLEX_URL`                    | Watching   | Plex server URL                                                             |
| `PLEX_TOKEN`                  | Watching   | Plex authentication token                                                   |
| `PLEX_WEBHOOK_SECRET`         | Watching   | Webhook source verification                                                 |
| `TMDB_API_KEY`                | Watching   | TMDB API read access token                                                  |
| `LETTERBOXD_USERNAME`         | Watching   | Letterboxd username for RSS feed sync                                       |
| `DISCOGS_PERSONAL_TOKEN`      | Collecting | Discogs personal access token                                               |
| `DISCOGS_USERNAME`            | Collecting | Discogs username (patdugan)                                                 |
| `APPLE_MUSIC_DEVELOPER_TOKEN` | Images     | Apple Music JWT                                                             |
| `FANART_TV_API_KEY`           | Images     | Fanart.tv project API key                                                   |

Cloudflare bindings (D1, R2) are configured in `wrangler.toml`, not as env vars.

## Database

- D1 binding: `DB`
- R2 binding: `IMAGES`
- Drizzle config: `drizzle.config.ts`
- Schema files: `src/db/schema/*.ts`
- Migrations generated by `drizzle-kit generate` into `migrations/`

## Testing

- Vitest with `@cloudflare/vitest-pool-workers` for Workers environment
- Test files: `*.test.ts` alongside source or in `__tests__/` directories
- Run: `npm test`
