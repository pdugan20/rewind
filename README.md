# Rewind

[![CI](https://github.com/pdugan20/rewind/actions/workflows/ci.yml/badge.svg)](https://github.com/pdugan20/rewind/actions/workflows/ci.yml)
[![docs](https://img.shields.io/badge/docs-docs.rewind.rest-blue)](https://docs.rewind.rest)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue?logo=opensourceinitiative&logoColor=white)](https://opensource.org/licenses/ISC)

Rewind is a personal API that pulls together data from the services that track my life -- what I'm listening to, where I'm running, what I'm watching, and what I'm collecting -- into a single queryable backend.

## What it does

Rewind syncs data from six services on a schedule, normalizes everything into a unified schema, and serves it through a REST API with 72 endpoints:

- **Listening** -- Last.fm scrobbles (123K+ plays), top artists/albums/tracks, listening streaks, and stats. Apple Music catalog data for metadata enrichment.
- **Running** -- 14+ years of Strava activities with splits, personal records, gear tracking, and year-over-year summaries.
- **Watching** -- Plex watch history, Letterboxd diary/ratings/reviews, and TMDB metadata. Covers both movies and TV shows.
- **Collecting** -- Discogs vinyl/CD collection with cross-referenced MusicBrainz data. Trakt physical media catalog.

A unified activity feed combines all domains into a single chronological stream.

## How it works

```mermaid
graph TD
    subgraph Sources
        LF[Last.fm]
        ST[Strava]
        PX[Plex]
        LB[Letterboxd]
        DC[Discogs]
        TR[Trakt]
    end

    LF & ST & PX & LB & DC & TR -->|Cron Triggers| SW[Sync Workers]
    SW --> D1[(D1 / SQLite)]
    SW --> R2[(R2 Images)]
    R2 -->|ThumbHash + color extraction| CDN[cdn.rewind.rest]
    D1 --> API[Hono REST API]
    API -->|72 endpoints| DOCS[docs.rewind.rest]
    API -->|Hono RPC| SITE[Consuming Apps]
```

The image pipeline fetches artwork from Cover Art Archive, Apple Music, Fanart.tv, and TMDB, stores originals in R2, and serves resized variants through Cloudflare Images with pre-computed ThumbHash placeholders and dominant color extraction.

## Live endpoints

| Service   | URL                                                  |
| --------- | ---------------------------------------------------- |
| API       | [api.rewind.rest](https://api.rewind.rest/v1/health) |
| API Docs  | [docs.rewind.rest](https://docs.rewind.rest)         |
| Image CDN | [cdn.rewind.rest](https://cdn.rewind.rest)           |
| Landing   | [rewind.rest](https://rewind.rest)                   |

## Built with

Hono on Cloudflare Workers. D1 (SQLite) for storage, R2 for images, Drizzle ORM for type-safe queries. End-to-end type inference via Hono RPC -- consuming apps get a fully typed client with zero codegen. Full OpenAPI 3.1 spec with interactive docs via Scalar.

## Development

```bash
npm run dev          # Start local dev server
npm run deploy       # Deploy to Cloudflare Workers
npm test             # Vitest (445 tests)
npm run type-check   # TypeScript strict mode
npm run lint         # ESLint
npm run db:generate  # Generate Drizzle migrations
npm run db:migrate   # Apply migrations locally
```

## Documentation

- **[Interactive API docs](https://docs.rewind.rest)** -- OpenAPI spec rendered by Scalar
- [Architecture](docs/ARCHITECTURE.md) -- system diagram, sync flow, caching, image pipeline
- [API reference](docs/API.md) -- endpoint catalog
