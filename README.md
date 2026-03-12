# Rewind

[![CI](https://github.com/pdugan20/rewind/actions/workflows/ci.yml/badge.svg)](https://github.com/pdugan20/rewind/actions/workflows/ci.yml)

Personal data aggregation service. Syncs data from Strava, Last.fm, Discogs, Plex, and Letterboxd into Cloudflare D1, serves via REST API at `api.rewind.rest` with an image CDN at `cdn.rewind.rest`.

## Tech Stack

| Layer             | Technology               | Purpose                                           |
| ----------------- | ------------------------ | ------------------------------------------------- |
| Runtime           | Cloudflare Workers       | V8 isolate serverless compute                     |
| Framework         | Hono                     | Lightweight web framework with RPC type inference |
| Database          | Cloudflare D1 (SQLite)   | Structured data storage                           |
| ORM               | Drizzle ORM              | Type-safe database access, migration generation   |
| Image Storage     | Cloudflare R2            | Zero-egress object storage                        |
| Image Transforms  | Cloudflare Images        | On-the-fly resize, format conversion, blur        |
| Blur Placeholders | ThumbHash                | Compact image placeholder encoding                |
| Scheduling        | Cloudflare Cron Triggers | Periodic data sync                                |
| Type Safety       | Hono RPC                 | End-to-end typed client for consuming apps        |
| Testing           | Vitest                   | Unit and integration tests with Workers pool      |
| Linting           | ESLint + Prettier        | Code quality and formatting                       |

## Data Domains

| Domain     | Source                 | Data                                      | Endpoints |
| ---------- | ---------------------- | ----------------------------------------- | --------- |
| Listening  | Last.fm, Apple Music   | 123K+ scrobbles, top lists, stats         | 12        |
| Running    | Strava                 | 14+ years of activities, PRs, gear        | 18        |
| Watching   | Plex, Letterboxd, TMDB | Movie and TV show watch history, metadata | 15        |
| Collecting | Discogs                | Vinyl/CD collection, wantlist             | 9         |

**72 endpoints** across 10 route groups (including system, feed, images, webhooks, search, export).

## Development

```bash
npm run dev          # Start local dev server
npm run deploy       # Deploy to Cloudflare Workers
npm run lint         # ESLint
npm run format       # Prettier
npm run type-check   # TypeScript
npm test             # Vitest
npm run db:generate  # Generate Drizzle migrations
npm run db:migrate   # Apply migrations locally
npm run db:remote    # Apply migrations to remote D1
```

## Documentation

**[API Reference](https://docs.rewind.rest)** -- interactive OpenAPI docs powered by Scalar

See the [docs/](docs/) directory for additional documentation:

- [Architecture](docs/ARCHITECTURE.md) -- system overview, database schema, caching, sync
- [API Reference](docs/API.md) -- endpoint reference (canonical docs at [docs.rewind.rest](https://docs.rewind.rest))
- [Roadmap](docs/ROADMAP.md) -- task tracker with all phases and progress
