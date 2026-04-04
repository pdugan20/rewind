# Rewind

[![CI](https://github.com/pdugan20/rewind/actions/workflows/ci.yml/badge.svg)](https://github.com/pdugan20/rewind/actions/workflows/ci.yml)
[![docs](https://img.shields.io/badge/docs-docs.rewind.rest-blue)](https://docs.rewind.rest)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?logo=opensourceinitiative&logoColor=white)](https://opensource.org/licenses/MIT)
[![npm: rewind-mcp-server](https://img.shields.io/npm/v/rewind-mcp-server?logo=npm&label=mcp-server)](https://www.npmjs.com/package/rewind-mcp-server)

Personal data aggregation API. Syncs data from multiple services on a schedule, normalizes everything into a unified schema, and serves it through a REST API with a cross-domain activity feed.

## Domains

| Domain         | Sources              | Description                                                          |
| -------------- | -------------------- | -------------------------------------------------------------------- |
| **Listening**  | Last.fm, Apple Music | Scrobble history, top artists/albums/tracks, streaks, stats          |
| **Running**    | Strava               | Activities with splits, personal records, gear, yearly summaries     |
| **Watching**   | Plex, Letterboxd     | Watch history, ratings, reviews, movies and TV shows via TMDB        |
| **Collecting** | Discogs, Trakt       | Vinyl/CD collection, physical media (Blu-ray/4K UHD/HD DVD)          |
| **Reading**    | Instapaper           | Articles, reading progress, highlights, word count, article metadata |

## Live endpoints

| Service    | URL                                                                |
| ---------- | ------------------------------------------------------------------ |
| API        | [api.rewind.rest](https://api.rewind.rest/v1/health)               |
| API Docs   | [docs.rewind.rest](https://docs.rewind.rest)                       |
| MCP Server | [docs.rewind.rest/mcp-server](https://docs.rewind.rest/mcp-server) |
| Image CDN  | [cdn.rewind.rest](https://cdn.rewind.rest)                         |

## Built with

Hono on Cloudflare Workers. D1 (SQLite) for storage, R2 for images, Drizzle ORM for type-safe queries. End-to-end type inference via Hono RPC -- consuming apps get a fully typed client with zero codegen. Full OpenAPI 3.1 spec with interactive docs via Scalar.

## Development

```bash
npm run dev          # Start local dev server
npm run deploy       # Deploy to Cloudflare Workers
npm test             # Vitest
npm run type-check   # TypeScript strict mode
npm run lint         # ESLint
npm run db:generate  # Generate Drizzle migrations
npm run db:migrate   # Apply migrations locally
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design, sync flow, caching strategy, and image pipeline details.
