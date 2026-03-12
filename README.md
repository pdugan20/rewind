# Rewind

[![CI](https://github.com/pdugan20/rewind/actions/workflows/ci.yml/badge.svg)](https://github.com/pdugan20/rewind/actions/workflows/ci.yml)
[![docs](https://img.shields.io/badge/docs-docs.rewind.rest-blue)](https://docs.rewind.rest)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Node.js >= 22](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue?logo=opensourceinitiative&logoColor=white)](https://opensource.org/licenses/ISC)

Personal data aggregation service. Syncs data from Strava, Last.fm, Discogs, Plex, Letterboxd, and Trakt into Cloudflare D1, serves via REST API at `api.rewind.rest` with an image CDN at `cdn.rewind.rest`.

## Features

- **72 endpoints** across 10 route groups with full OpenAPI 3.1 spec
- **End-to-end type safety** via Hono RPC -- consuming apps get typed clients with zero codegen
- **Image pipeline** with R2 storage, Cloudflare Images transforms, ThumbHash placeholders, and dominant color extraction
- **Automated sync** via Cron Triggers -- scrobbles every 15 min, full syncs daily
- **Cross-domain feed** combining listening, running, watching, and collecting activity

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
| Testing           | Vitest                   | Unit and integration tests with Workers pool      |
| Linting           | ESLint + Prettier        | Code quality and formatting                       |

## Data Domains

| Domain     | Source                 | Data                                      | Endpoints |
| ---------- | ---------------------- | ----------------------------------------- | --------- |
| Listening  | Last.fm, Apple Music   | 123K+ scrobbles, top lists, stats         | 12        |
| Running    | Strava                 | 14+ years of activities, PRs, gear        | 18        |
| Watching   | Plex, Letterboxd, TMDB | Movie and TV show watch history, metadata | 15        |
| Collecting | Discogs, Trakt         | Vinyl/CD collection, wantlist             | 9         |

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
npm run lint:deps    # Check unused dependencies (knip)
```

## Deployment

| Service      | URL                | Platform           |
| ------------ | ------------------ | ------------------ |
| API          | `api.rewind.rest`  | Cloudflare Workers |
| Image CDN    | `cdn.rewind.rest`  | Cloudflare R2      |
| API Docs     | `docs.rewind.rest` | Cloudflare Pages   |
| Landing Page | `rewind.rest`      | Cloudflare Pages   |

CI runs lint, format, type check, tests, OpenAPI spec validation, and security scanning. Deploys trigger automatically on push to `main` after CI passes.

## Documentation

**[API Reference](https://docs.rewind.rest)** -- interactive OpenAPI docs powered by Scalar

See the [docs/](docs/) directory for additional documentation:

- [Architecture](docs/ARCHITECTURE.md) -- system overview, database schema, caching, sync
- [API Reference](docs/API.md) -- endpoint reference (canonical docs at [docs.rewind.rest](https://docs.rewind.rest))
- [Roadmap](docs/ROADMAP.md) -- task tracker with all phases and progress
