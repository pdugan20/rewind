# Project: Reading Domain

Add a Reading domain to Rewind that syncs bookmarks, reading progress, and highlights from Instapaper. Designed to support books (Goodreads/Literal) as a future second source.

## Motivation

Instapaper tracks articles saved, reading progress, starred items, and highlighted passages. This data fits naturally as a fifth Rewind domain alongside Listening, Running, Watching, and Collecting. The portfolio can display recently read articles with thumbnails, author, read time, highlights, and starred status.

## Architecture

```text
Instapaper API (OAuth 1.0a / xAuth)
        |
        v
  Sync worker (cron, every 6 hours)
    - Fetch unread, starred, archive folders
    - Detect status changes (unread -> archive = finished)
    - Fetch OG metadata from article URLs (thumbnail, author, site_name)
    - Fetch word count via get_text (new articles only)
    - Fetch highlights per article
        |
        v
  D1 tables (reading_items, reading_highlights)
        |
        v
  REST API: /v1/reading/*
        |
        v
  Image pipeline: reading/articles entity type
        |
        v
  Cross-domain: feed, search integration
```

## Data Sources

| Source                           | What it provides                                                     | Auth               |
| -------------------------------- | -------------------------------------------------------------------- | ------------------ |
| **Instapaper** (v1)              | Bookmarks, reading progress, folders, tags, highlights, article text | OAuth 1.0a (xAuth) |
| **Goodreads / Literal** (future) | Books, ratings, reviews, shelves, reading progress                   | TBD                |

## Technology Choices

| Component     | Choice                                        | Rationale                                                                                               |
| ------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Auth          | OAuth 1.0a xAuth                              | Instapaper's only option. One-time token exchange, permanent access token stored in Cloudflare secrets. |
| OG metadata   | Fetch article URL headers during sync         | Gets thumbnail (`og:image`), author (`article:author`), site name (`og:site_name`)                      |
| Word count    | `get_text` endpoint, one call per new article | Accurate count from processed HTML, discards body after counting                                        |
| Thumbnails    | Image pipeline (R2 + CDN)                     | Same as albums/movies/vinyl. Client-side fallback for missing OG images.                                |
| Sync schedule | Every 6 hours                                 | Articles don't need real-time sync like scrobbles                                                       |

## Schema Design

Unified `reading_items` table with `item_type` column ('article' now, 'book' future) so books can be added without schema migration.

See [SCHEMA.md](SCHEMA.md) for full table definitions.

## Documents

| File                           | Purpose                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| [TRACKER.md](TRACKER.md)       | Master task tracker with phases and discrete tasks           |
| [SCHEMA.md](SCHEMA.md)         | Database schema and migration plan                           |
| [INSTAPAPER.md](INSTAPAPER.md) | Instapaper API integration details, auth flow, sync strategy |

## Phase Summary

| Phase | Focus       | Scope                                                          |
| ----- | ----------- | -------------------------------------------------------------- |
| 1     | Foundation  | Schema, Instapaper OAuth client, token setup script            |
| 2     | Sync        | Sync worker for bookmarks, highlights, OG metadata, word count |
| 3     | API         | REST endpoints for articles, highlights, stats                 |
| 4     | Integration | Feed, search, image pipeline, docs                             |
| 5     | Backfill    | Historical import of existing Instapaper data                  |

## Endpoint Plan

### Core

```
GET /reading/recent               — recently saved or recently finished
GET /reading/currently-reading    — articles with status 'reading' (progress > 0, < 1)
GET /reading/articles             — browse articles (filter: status, tag, domain, starred)
GET /reading/articles/{id}        — article detail with embedded highlights
GET /reading/archive              — finished articles
```

### Highlights

```
GET /reading/highlights           — all highlights, newest first
GET /reading/highlights/random    — random highlight
```

### Stats & Discovery

```
GET /reading/stats                — total read, reading pace, streak
GET /reading/calendar             — daily reading activity heatmap
GET /reading/streaks              — consecutive days with reading activity
GET /reading/tags                 — tag breakdown with counts
GET /reading/domains              — top source domains with counts
GET /reading/year/{year}          — year in review
```

### Future (books)

```
GET /reading/books                — browse books
GET /reading/books/{id}           — book detail with highlights
GET /reading/authors              — top authors
```

### Admin

```
POST /admin/sync/reading          — trigger Instapaper sync
POST /admin/reading/backfill-images — backfill missing article thumbnails
```
