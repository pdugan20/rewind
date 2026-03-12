# API Reference

Base URL: `https://api.rewind.rest`

All endpoints return JSON. 96 endpoints across 12 sections.

## Authentication

All endpoints require an API key via the `Authorization: Bearer rw_...` header.

- **Read keys** (`rw_live_...`) can access GET endpoints
- **Admin keys** (`rw_admin_...`) can access all endpoints including POST and DELETE

Example:

```bash
curl -H "Authorization: Bearer rw_live_abc123..." https://api.rewind.rest/v1/listening/now-playing
```

## Common Patterns

### Pagination

Paginated endpoints accept `page` and `limit` query parameters and return:

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "total_pages": 8
  }
}
```

### Response Envelopes

- **Paginated endpoints** return `{ "data": [...], "pagination": {...} }`
- **Single-object endpoints** (stats, streaks) return `{ "data": {...} }`
- **Detail endpoints** (by ID) return the object directly
- **Error responses** return `{ "error": "message", "status": 404 }`

### Time Periods

Listening endpoints accept a `period` parameter:

| Value   | Description   |
| ------- | ------------- |
| 7day    | Last 7 days   |
| 1month  | Last 30 days  |
| 3month  | Last 90 days  |
| 6month  | Last 180 days |
| 12month | Last 365 days |
| overall | All time      |

### Error Responses

```json
{
  "error": "Activity not found",
  "status": 404
}
```

| Status | Meaning                                |
| ------ | -------------------------------------- |
| 400    | Bad request (invalid parameters)       |
| 401    | Unauthorized (missing/invalid API key) |
| 404    | Resource not found                     |
| 429    | Rate limited                           |
| 500    | Internal server error                  |

### Image Fields

All entities with images return a standardized `image` field:

```json
{
  "image": {
    "cdn_url": "https://cdn.rewind.rest/listening/albums/123/original.jpg?width=300&height=300&v=2",
    "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
    "dominant_color": "#1a1a2e",
    "accent_color": "#e94560"
  }
}
```

When no image exists, the field is `null`:

```json
{
  "image": null
}
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| cdn_url | string | Cloudflare Images transform URL with size preset |
| thumbhash | string or null | Base64 ThumbHash for blur placeholder |
| dominant_color | string or null | Hex color for background placeholder |
| accent_color | string or null | Hex color for UI accents |

### Rate Limiting

All endpoints return rate limiting headers:

| Header                | Description                                    |
| --------------------- | ---------------------------------------------- |
| X-RateLimit-Limit     | Requests allowed per minute                    |
| X-RateLimit-Remaining | Requests remaining in current window           |
| X-RateLimit-Reset     | Unix timestamp when the window resets          |
| Retry-After           | Seconds to wait (included in 429 responses only) |

When rate limited, the API returns a `429 Too Many Requests` response with the `Retry-After` header indicating how many seconds to wait before retrying.

## System

### GET /v1/health

Returns service status.

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/health
```

```json
{
  "status": "ok",
  "version": "1.0.0"
}
```

Cache: no-store

### GET /v1/health/sync

Returns sync status for all domains.

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/health/sync
```

```json
{
  "domains": {
    "listening": {
      "status": "healthy",
      "last_sync": "2026-03-09T12:00:00Z",
      "sync_type": "incremental",
      "items_synced": 42,
      "next_scheduled": "2026-03-09T12:15:00Z"
    },
    "running": {
      "status": "healthy",
      "last_sync": "2026-03-09T04:00:00Z",
      "sync_type": "incremental",
      "items_synced": 1
    },
    "watching": {
      "status": "healthy",
      "last_sync": "2026-03-09T05:00:00Z",
      "sync_type": "full",
      "items_synced": 0
    },
    "collecting": {
      "status": "healthy",
      "last_sync": "2026-03-02T06:00:00Z",
      "sync_type": "full",
      "items_synced": 0
    }
  }
}
```

Cache: no-store

### POST /v1/admin/sync/:domain

Triggers an incremental sync for a domain. Admin key required.

```bash
curl -X POST https://api.rewind.rest/v1/admin/sync/listening \
  -H "Authorization: Bearer rw_admin_..."
```

```json
{
  "sync_id": 1234,
  "domain": "listening",
  "sync_type": "incremental",
  "status": "started"
}
```

The listening sync accepts an optional JSON body to specify sync type:

| Body Field | Type   | Default    | Description                              |
| ---------- | ------ | ---------- | ---------------------------------------- |
| type       | string | scrobbles  | scrobbles, top_lists, stats, full, backfill |

```bash
curl -X POST https://api.rewind.rest/v1/admin/sync/listening \
  -H "Authorization: Bearer rw_admin_..." \
  -H "Content-Type: application/json" \
  -d '{"type": "full"}'
```

The watching sync accepts an optional `source` query parameter:

```bash
curl -X POST "https://api.rewind.rest/v1/admin/sync/watching?source=letterboxd" \
  -H "Authorization: Bearer rw_admin_..."
```

### DELETE /v1/admin/running/activities/:id

Soft-delete a running activity by Strava ID. Triggers incremental stats recomputation. Admin key required.

```bash
curl -X DELETE https://api.rewind.rest/v1/admin/running/activities/12345678 \
  -H "Authorization: Bearer rw_admin_..."
```

```json
{
  "status": "deleted",
  "strava_id": 12345678
}
```

### POST /v1/admin/running/recompute

Trigger a full stats recomputation (year summaries, lifetime stats, streaks, Eddington) without syncing from Strava. Admin key required.

```bash
curl -X POST https://api.rewind.rest/v1/admin/running/recompute \
  -H "Authorization: Bearer rw_admin_..."
```

```json
{
  "status": "completed",
  "timestamp": "2026-03-12T12:00:00Z"
}
```

## API Keys

### POST /v1/admin/keys

Create a new API key. Returns the full key exactly once. Admin key required.

```bash
curl -X POST https://api.rewind.rest/v1/admin/keys \
  -H "Authorization: Bearer rw_admin_..." \
  -H "Content-Type: application/json" \
  -d '{"name": "portfolio-prod", "scope": "read"}'
```

```json
{
  "key": "rw_live_a1b2c3d4e5f6789012345678abcdef00",
  "id": 3,
  "name": "portfolio-prod",
  "scope": "read",
  "key_hint": "...ef00",
  "created_at": "2026-03-09T12:00:00Z"
}
```

### GET /v1/admin/keys

List all API keys (never returns full key). Admin key required.

```json
{
  "data": [
    {
      "id": 1,
      "name": "portfolio-prod",
      "scope": "read",
      "key_prefix": "rw_live_",
      "key_hint": "...ef00",
      "last_used_at": "2026-03-09T14:00:00Z",
      "request_count": 4521,
      "is_active": true
    }
  ]
}
```

### DELETE /v1/admin/keys/:id

Revoke an API key. Admin key required.

## Feed

### GET /v1/feed

Unified activity feed across all domains.

| Parameter | Type   | Default | Description                                      |
| --------- | ------ | ------- | ------------------------------------------------ |
| limit     | number | 20      | Items per page (max 100)                         |
| page      | number | 1       | Page number                                      |
| domain    | string | all     | Filter: listening, running, watching, collecting |
| from      | string | -       | ISO 8601 start date                              |
| to        | string | -       | ISO 8601 end date                                |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/feed?limit=5&domain=listening,running"
```

```json
{
  "data": [
    {
      "id": 5001,
      "domain": "listening",
      "event_type": "scrobble",
      "occurred_at": "2026-03-09T14:32:00Z",
      "title": "Listened to Paranoid Android",
      "subtitle": "Radiohead -- OK Computer",
      "image": {
        "cdn_url": "https://cdn.rewind.rest/listening/albums/abc123/original.jpg?width=300&height=300&v=1",
        "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
        "dominant_color": "#1a2b3c",
        "accent_color": "#4d5e6f"
      }
    },
    {
      "id": 5000,
      "domain": "running",
      "event_type": "run_completed",
      "occurred_at": "2026-03-09T07:15:00Z",
      "title": "Morning Run",
      "subtitle": "5.2 mi in 42:30 (8:10/mi)",
      "image": null
    }
  ],
  "pagination": { "page": 1, "limit": 5, "total": 150234, "total_pages": 30047 }
}
```

Cache: max-age=300

### GET /v1/feed/domain/:domain

Single-domain activity feed. Same cursor-based pagination as /v1/feed.

Valid domains: listening, running, watching, collecting

| Parameter | Type   | Default | Description          |
| --------- | ------ | ------- | -------------------- |
| cursor    | string | -       | Cursor for next page |
| limit     | number | 50      | 1-100                |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/feed/domain/listening?limit=10"
```

Same response shape as GET /v1/feed, filtered to a single domain.

Cache: max-age=300

## Search

### GET /v1/search

Cross-domain full-text search using SQLite FTS5. Returns a flat list of results across all domains, each tagged with its domain and entity type.

| Parameter | Type   | Default  | Description                                             |
| --------- | ------ | -------- | ------------------------------------------------------- |
| q         | string | required | Search query string (prefix matching supported)         |
| domain    | string | all      | Filter to one domain: listening, running, watching, collecting |
| page      | number | 1        | Page number                                             |
| limit     | number | 20       | Results per page (1-100)                                |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/search?q=radiohead"
```

```json
{
  "data": [
    {
      "domain": "listening",
      "entity_type": "artist",
      "entity_id": "636",
      "title": "Radiohead",
      "subtitle": null,
      "image_key": null
    },
    {
      "domain": "listening",
      "entity_type": "album",
      "entity_id": "535",
      "title": "Kid A",
      "subtitle": "Radiohead",
      "image_key": null
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 12,
    "total_pages": 1
  }
}
```

Populated by `afterSync()` during each sync cycle. Entity types by domain:

- **listening**: artist, album
- **running**: activity
- **watching**: movie, show
- **collecting**: release

Cache: max-age=300

## Listening

### GET /v1/listening/now-playing

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/listening/now-playing
```

```json
{
  "is_playing": true,
  "track": {
    "name": "Everything In Its Right Place",
    "artist": { "id": 42, "name": "Radiohead" },
    "album": {
      "id": 88,
      "name": "Kid A",
      "image": {
        "cdn_url": "https://cdn.rewind.rest/listening/albums/kid-a-mbid/original.jpg?width=300&height=300&v=1",
        "thumbhash": "abc123==",
        "dominant_color": "#1a2b3c",
        "accent_color": "#4d5e6f"
      }
    },
    "url": "https://www.last.fm/music/Radiohead/_/Everything+In+Its+Right+Place"
  },
  "scrobbled_at": null
}
```

Cache: no-store

### GET /v1/listening/recent

| Parameter | Type   | Default |
| --------- | ------ | ------- |
| limit     | number | 10      |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/listening/recent?limit=5"
```

```json
{
  "data": [
    {
      "name": "Everything In Its Right Place",
      "artist": { "id": 42, "name": "Radiohead" },
      "album": {
        "id": 88,
        "name": "Kid A",
        "image": {
          "cdn_url": "https://cdn.rewind.rest/listening/albums/88/original.jpg?width=300&height=300&v=1",
          "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
          "dominant_color": "#1a2b3c",
          "accent_color": "#4d5e6f"
        }
      },
      "scrobbled_at": "2026-03-09T14:28:00Z"
    }
  ]
}
```

Cache: max-age=60

### GET /v1/listening/top/artists

| Parameter | Type   | Default |
| --------- | ------ | ------- |
| period    | string | overall |
| limit     | number | 10      |
| page      | number | 1       |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/listening/top/artists?period=3month&limit=5"
```

```json
{
  "period": "3month",
  "data": [
    {
      "rank": 1,
      "id": 42,
      "name": "Radiohead",
      "playcount": 312,
      "image": {
        "cdn_url": "https://cdn.rewind.rest/listening/artists/42/original.jpg?width=300&height=300&v=1",
        "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
        "dominant_color": "#1a2b3c",
        "accent_color": "#4d5e6f"
      },
      "url": "https://www.last.fm/music/Radiohead"
    }
  ],
  "pagination": { "page": 1, "limit": 5, "total": 1200, "total_pages": 240 }
}
```

Cache: max-age=3600

### GET /v1/listening/top/albums

Same parameters as top/artists. Response includes album art.

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/listening/top/albums?period=3month"
```

```json
{
  "period": "3month",
  "data": [
    {
      "rank": 1,
      "id": 88,
      "name": "OK Computer",
      "detail": "Radiohead",
      "playcount": 78,
      "image": {
        "cdn_url": "https://cdn.rewind.rest/listening/albums/88/original.jpg?width=300&height=300&v=1",
        "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
        "dominant_color": "#1a2b3c",
        "accent_color": "#4d5e6f"
      },
      "url": "https://www.last.fm/music/Radiohead/OK+Computer"
    }
  ],
  "pagination": { "page": 1, "limit": 10, "total": 800, "total_pages": 80 }
}
```

Cache: max-age=3600

### GET /v1/listening/top/tracks

Same parameters as top/artists.

Cache: max-age=3600

### GET /v1/listening/stats

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/listening/stats
```

```json
{
  "total_scrobbles": 123769,
  "unique_artists": 4521,
  "unique_albums": 8234,
  "unique_tracks": 22456,
  "registered_date": "2012-04-15",
  "years_tracking": 14,
  "scrobbles_per_day": 24.2
}
```

Cache: max-age=3600

### GET /v1/listening/streaks

Current and longest listening streaks (consecutive days with scrobbles).

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/listening/streaks
```

```json
{
  "current": {
    "days": 45,
    "start_date": "2026-01-24",
    "total_scrobbles": 1234
  },
  "longest": {
    "days": 312,
    "start_date": "2024-02-01",
    "end_date": "2024-12-09",
    "total_scrobbles": 8901
  }
}
```

Cache: max-age=3600

### GET /v1/listening/history

| Parameter | Type   | Default | Description      |
| --------- | ------ | ------- | ---------------- |
| limit     | number | 50      | Max 200          |
| page      | number | 1       | Page number      |
| from      | string | -       | ISO 8601 start   |
| to        | string | -       | ISO 8601 end     |
| artist    | string | -       | Filter by artist |
| album     | string | -       | Filter by album  |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/listening/history?from=2026-03-01&limit=20"
```

Cache: max-age=3600

### GET /v1/listening/artists/:id

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/listening/artists/42
```

```json
{
  "id": 42,
  "name": "Radiohead",
  "mbid": "a74b1b7f-71a5-4011-9441-d0b5e4122711",
  "playcount": 5432,
  "image": {
    "cdn_url": "https://cdn.rewind.rest/listening/artists/42/original.jpg?width=300&height=300&v=1",
    "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
    "dominant_color": "#1a2b3c",
    "accent_color": "#4d5e6f"
  },
  "url": "https://www.last.fm/music/Radiohead",
  "top_albums": [{ "id": 88, "name": "OK Computer", "playcount": 312 }],
  "top_tracks": [{ "id": 201, "name": "Paranoid Android", "playcount": 78 }]
}
```

Cache: max-age=3600

### GET /v1/listening/albums/:id

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/listening/albums/88
```

```json
{
  "id": 88,
  "name": "OK Computer",
  "artist": { "id": 42, "name": "Radiohead" },
  "mbid": "album-mbid",
  "playcount": 312,
  "image": {
    "cdn_url": "https://cdn.rewind.rest/listening/albums/88/original.jpg?width=300&height=300&v=1",
    "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
    "dominant_color": "#1a2b3c",
    "accent_color": "#4d5e6f"
  },
  "url": "https://www.last.fm/music/Radiohead/OK+Computer"
}
```

Cache: max-age=3600

### GET /v1/listening/calendar

| Parameter | Type   | Default      |
| --------- | ------ | ------------ |
| year      | number | current year |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/listening/calendar?year=2026"
```

```json
{
  "year": 2026,
  "days": [
    { "date": "2026-01-01", "count": 32 },
    { "date": "2026-01-02", "count": 45 }
  ],
  "total": 4521,
  "max_day": { "date": "2026-02-14", "count": 112 }
}
```

Cache: max-age=3600 (current year), max-age=86400 (past years)

### GET /v1/listening/trends

| Parameter | Type   | Default           |
| --------- | ------ | ----------------- |
| metric    | string | scrobbles_per_day |
| from      | string | -                 |
| to        | string | -                 |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/listening/trends?metric=scrobbles_per_day"
```

```json
{
  "metric": "scrobbles_per_day",
  "data": [
    { "date": "2026-03-01", "value": 28 },
    { "date": "2026-03-02", "value": 45 }
  ]
}
```

Cache: max-age=86400

### GET /v1/listening/artists

Browse all artists. Paginated with search and sort options.

| Parameter | Type   | Default   | Description                |
| --------- | ------ | --------- | -------------------------- |
| page      | number | 1         | Page number                |
| limit     | number | 20        | Items per page             |
| sort      | string | playcount | playcount, name            |
| order     | string | desc      | asc, desc                  |
| search    | string | -         | Filter by artist name      |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/listening/artists?sort=playcount&limit=10"
```

```json
{
  "data": [
    {
      "id": 42,
      "name": "Radiohead",
      "playcount": 5432,
      "url": "https://www.last.fm/music/Radiohead",
      "image": {
        "cdn_url": "https://cdn.rewind.rest/listening/artists/42/original.jpg?width=300&height=300&v=1",
        "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
        "dominant_color": "#1a2b3c",
        "accent_color": "#4d5e6f"
      }
    }
  ],
  "pagination": { "page": 1, "limit": 10, "total": 4521, "total_pages": 453 }
}
```

Cache: max-age=3600

### GET /v1/listening/albums

Browse all albums. Paginated with artist filter, search, and sort options.

| Parameter | Type   | Default   | Description                |
| --------- | ------ | --------- | -------------------------- |
| page      | number | 1         | Page number                |
| limit     | number | 20        | Items per page             |
| sort      | string | playcount | playcount, name, recent    |
| order     | string | desc      | asc, desc                  |
| artist    | string | -         | Filter by artist name      |
| search    | string | -         | Filter by album name       |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/listening/albums?artist=Radiohead&sort=playcount"
```

```json
{
  "data": [
    {
      "id": 88,
      "name": "OK Computer",
      "artist": { "id": 42, "name": "Radiohead" },
      "playcount": 312,
      "url": "https://www.last.fm/music/Radiohead/OK+Computer",
      "image": {
        "cdn_url": "https://cdn.rewind.rest/listening/albums/88/original.jpg?width=300&height=300&v=1",
        "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
        "dominant_color": "#1a2b3c",
        "accent_color": "#4d5e6f"
      }
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 8234, "total_pages": 412 }
}
```

Cache: max-age=3600

### GET /v1/listening/year/:year

Year-in-review for listening. Returns aggregate stats, top artists/albums/tracks, and monthly breakdown for the given year.

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/listening/year/2025
```

```json
{
  "year": 2025,
  "total_scrobbles": 8234,
  "unique_artists": 412,
  "unique_albums": 890,
  "unique_tracks": 2345,
  "top_artists": [
    {
      "id": 42,
      "name": "Radiohead",
      "scrobbles": 312,
      "image": {
        "cdn_url": "https://cdn.rewind.rest/listening/artists/42/original.jpg?width=300&height=300&v=1",
        "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
        "dominant_color": "#1a2b3c",
        "accent_color": "#4d5e6f"
      }
    }
  ],
  "top_albums": [
    {
      "id": 88,
      "name": "OK Computer",
      "artist": "Radiohead",
      "scrobbles": 78,
      "image": {
        "cdn_url": "https://cdn.rewind.rest/listening/albums/88/original.jpg?width=300&height=300&v=1",
        "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
        "dominant_color": "#1a2b3c",
        "accent_color": "#4d5e6f"
      }
    }
  ],
  "top_tracks": [
    {
      "id": 201,
      "name": "Paranoid Android",
      "artist": "Radiohead",
      "scrobbles": 45
    }
  ],
  "monthly": [
    {
      "month": 1,
      "scrobbles": 712,
      "unique_artists": 89,
      "unique_albums": 134
    }
  ]
}
```

Cache: max-age=86400

## Running

### GET /v1/running/stats

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/running/stats
```

```json
{
  "data": {
    "total_runs": 1847,
    "total_distance_mi": 8234.5,
    "total_elevation_ft": 423567,
    "total_duration": "1423:45:30",
    "avg_pace": "8:22/mi",
    "years_active": 14,
    "first_run": "2011-06-15",
    "eddington_number": 8
  }
}
```

Cache: max-age=3600

### GET /v1/running/stats/years

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/running/stats/years
```

```json
{
  "data": [
    {
      "year": 2026,
      "total_runs": 42,
      "total_distance_mi": 198.3,
      "total_elevation_ft": 12450,
      "avg_pace": "8:05/mi",
      "longest_run_mi": 13.1,
      "race_count": 1
    },
    {
      "year": 2025,
      "total_runs": 210,
      "total_distance_mi": 1105.2,
      "total_elevation_ft": 67800,
      "avg_pace": "8:18/mi",
      "longest_run_mi": 26.2,
      "race_count": 4
    }
  ]
}
```

Cache: max-age=3600

### GET /v1/running/stats/years/:year

Same shape as single item from /v1/running/stats/years, wrapped in `{ "data": {...} }`.

Cache: max-age=3600

### GET /v1/running/prs

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/running/prs
```

```json
{
  "data": [
    {
      "distance": "mile",
      "distance_label": "Mile",
      "time": "6:42",
      "time_s": 402,
      "pace": "6:42/mi",
      "date": "2019-09-14",
      "activity_id": 456,
      "activity_name": "Fall 5K Race"
    },
    {
      "distance": "5k",
      "distance_label": "5K",
      "time": "22:15",
      "time_s": 1335,
      "pace": "7:10/mi",
      "date": "2019-09-14",
      "activity_id": 456,
      "activity_name": "Fall 5K Race"
    },
    {
      "distance": "10k",
      "distance_label": "10K",
      "time": "47:30",
      "time_s": 2850,
      "pace": "7:39/mi",
      "date": "2018-10-20",
      "activity_id": 321,
      "activity_name": "Bridge Run 10K"
    },
    {
      "distance": "half_marathon",
      "distance_label": "Half Marathon",
      "time": "1:45:22",
      "time_s": 6322,
      "pace": "8:03/mi",
      "date": "2022-03-05",
      "activity_id": 789,
      "activity_name": "Spring Half Marathon"
    },
    {
      "distance": "marathon",
      "distance_label": "Marathon",
      "time": "3:52:10",
      "time_s": 13930,
      "pace": "8:52/mi",
      "date": "2023-11-12",
      "activity_id": 1001,
      "activity_name": "Philly Marathon"
    }
  ]
}
```

Cache: max-age=86400

### GET /v1/running/recent

| Parameter | Type   | Default |
| --------- | ------ | ------- |
| limit     | number | 5       |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/running/recent?limit=3"
```

```json
{
  "data": [
    {
      "id": 1234,
      "strava_id": 12345678,
      "name": "Morning Run",
      "date": "2026-03-09T07:15:00-05:00",
      "distance_mi": 5.2,
      "duration": "42:30",
      "pace": "8:10/mi",
      "elevation_ft": 234,
      "heartrate_avg": 152,
      "city": "Philadelphia",
      "polyline": "encodedString...",
      "is_race": false
    }
  ]
}
```

Cache: max-age=60

### GET /v1/running/activities

| Parameter    | Type   | Default | Description                     |
| ------------ | ------ | ------- | ------------------------------- |
| page         | number | 1       | Page number                     |
| limit        | number | 20      | Items per page                  |
| year         | number | -       | Filter by year                  |
| type         | string | -       | Run, Race, TrailRun, Treadmill  |
| city         | string | -       | Filter by city                  |
| min_distance | number | -       | Minimum distance (miles)        |
| max_distance | number | -       | Maximum distance (miles)        |
| sort         | string | date    | date, distance, pace, elevation |
| order        | string | desc    | asc, desc                       |

Cache: max-age=3600

### GET /v1/running/activities/:id

Full detail including splits.

Cache: max-age=86400

### GET /v1/running/activities/:id/splits

```json
{
  "activity_id": 1234,
  "data": [
    {
      "mile": 1,
      "time": "8:05",
      "time_s": 485,
      "elevation_ft": 45,
      "heartrate_avg": 148
    },
    {
      "mile": 2,
      "time": "8:12",
      "time_s": 492,
      "elevation_ft": -12,
      "heartrate_avg": 155
    }
  ]
}
```

Cache: max-age=86400

### GET /v1/running/gear

```json
{
  "data": [
    {
      "id": "g12345",
      "name": "Nike Pegasus 40",
      "brand": "Nike",
      "model": "Pegasus 40",
      "distance_mi": 342.5,
      "is_retired": false
    }
  ],
  "summary": { "active": 2, "retired": 5 }
}
```

Cache: max-age=86400

### GET /v1/running/calendar

| Parameter | Type   | Default |
| --------- | ------ | ------- |
| year      | number | current |

```json
{
  "year": 2026,
  "days": [
    { "date": "2026-01-02", "runs": 1, "total_mi": 5.2 },
    { "date": "2026-01-04", "runs": 1, "total_mi": 8.1 }
  ],
  "total_run_days": 42,
  "total_rest_days": 26
}
```

Cache: max-age=3600

### GET /v1/running/charts/cumulative

| Parameter | Type   | Default          |
| --------- | ------ | ---------------- | --------------- |
| years     | string | current,previous | Comma-separated |
| unit      | string | mi               | mi or km        |

```json
{
  "unit": "mi",
  "series": {
    "2026": [
      { "day": 1, "cumulative": 0 },
      { "day": 2, "cumulative": 5.2 }
    ],
    "2025": [
      { "day": 1, "cumulative": 0 },
      { "day": 3, "cumulative": 6.1 }
    ]
  }
}
```

Cache: max-age=3600

### GET /v1/running/charts/pace-trend

| Parameter | Type   | Default |
| --------- | ------ | ------- | ----------------------------- |
| window    | number | 30      | Rolling average window (days) |
| from      | string | -       | ISO start                     |
| to        | string | -       | ISO end                       |

```json
{
  "window": 30,
  "data": [{ "date": "2026-03-01", "avg_pace_s": 497, "avg_pace": "8:17/mi" }]
}
```

Cache: max-age=3600

### GET /v1/running/charts/time-of-day

| Parameter | Type   | Default |
| --------- | ------ | ------- |
| year      | number | all     |

```json
{
  "data": [
    { "hour": 5, "count": 12, "pct": 0.6 },
    { "hour": 6, "count": 245, "pct": 13.3 },
    { "hour": 7, "count": 534, "pct": 28.9 }
  ],
  "peak_hour": 7,
  "total": 1847
}
```

Cache: max-age=86400

### GET /v1/running/charts/elevation

| Parameter | Type   | Default |
| --------- | ------ | ------- |
| year      | number | all     |

Cache: max-age=86400

### GET /v1/running/cities

```json
{
  "data": [
    {
      "city": "Philadelphia",
      "state": "PA",
      "country": "US",
      "count": 1200,
      "total_mi": 5600.2
    },
    {
      "city": "New York",
      "state": "NY",
      "country": "US",
      "count": 45,
      "total_mi": 210.5
    }
  ]
}
```

Cache: max-age=86400

### GET /v1/running/streaks

```json
{
  "data": {
    "current": { "days": 12, "start_date": "2026-02-26", "total_mi": 58.3 },
    "longest": {
      "days": 45,
      "start_date": "2024-06-01",
      "end_date": "2024-07-15",
      "total_mi": 198.7
    }
  }
}
```

Cache: max-age=3600

### GET /v1/running/races

| Parameter | Type   | Default |
| --------- | ------ | ------- | -------------------------------------- |
| distance  | string | -       | mile, 5k, 10k, half_marathon, marathon |

```json
{
  "data": [
    {
      "activity_id": 1001,
      "name": "Philly Marathon",
      "date": "2023-11-12",
      "distance": "marathon",
      "distance_label": "Marathon",
      "time": "3:52:10",
      "pace": "8:52/mi",
      "city": "Philadelphia"
    }
  ],
  "summary": {
    "total": 23,
    "by_distance": {
      "mile": 2,
      "5k": 8,
      "10k": 6,
      "half_marathon": 5,
      "marathon": 2
    }
  }
}
```

Cache: max-age=86400

### GET /v1/running/eddington

```json
{
  "number": 8,
  "explanation": "You have run at least 8 miles on 8 different days",
  "progress": { "target": 9, "days_completed": 6, "runs_needed": 3 }
}
```

Cache: max-age=86400

### GET /v1/running/year/:year

Year-in-review for running. Expands on `/v1/running/stats/years/:year` with monthly breakdown and top runs.

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/running/year/2025
```

```json
{
  "year": 2025,
  "total_runs": 210,
  "total_distance_mi": 1105.2,
  "total_elevation_ft": 67800,
  "total_duration_s": 594000,
  "avg_pace": "8:18/mi",
  "longest_run_mi": 26.2,
  "race_count": 4,
  "monthly": [
    {
      "month": 1,
      "runs": 18,
      "distance_mi": 89.4,
      "duration_s": 48000,
      "elevation_ft": 5600
    }
  ],
  "top_runs": [
    {
      "id": 1001,
      "strava_id": 12345678,
      "name": "Philly Marathon",
      "date": "2025-11-12T07:00:00-05:00",
      "distance_mi": 26.2,
      "duration": "3:52:10",
      "pace": "8:52/mi",
      "elevation_ft": 890,
      "is_race": true
    }
  ]
}
```

Cache: max-age=86400

## Watching

### GET /v1/watching/recent

| Parameter | Type   | Default |
| --------- | ------ | ------- |
| limit     | number | 5       |

```json
{
  "data": [
    {
      "id": 1,
      "title": "The Grand Budapest Hotel",
      "year": 2014,
      "director": "Wes Anderson",
      "genres": ["Comedy", "Drama"],
      "duration_min": 99,
      "rating": "R",
      "image": {
        "cdn_url": "https://cdn.rewind.rest/watching/movies/1/original.jpg?width=300&height=300&v=1",
        "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
        "dominant_color": "#1a2b3c",
        "accent_color": "#4d5e6f"
      },
      "watched_at": "2026-03-08T21:00:00Z",
      "imdb_id": "tt2278388"
    }
  ]
}
```

Cache: max-age=60

### GET /v1/watching/movies

| Parameter | Type   | Default |
| --------- | ------ | ------- |
| page      | number | 1       |
| limit     | number | 20      |
| genre     | string | -       |
| decade    | number | -       |
| director  | string | -       |
| year      | number | -       |
| sort      | string | watched |
| order     | string | desc    |

Cache: max-age=3600

### GET /v1/watching/movies/:id

Full movie detail with all metadata, watch history, and images.

Cache: max-age=86400

### GET /v1/watching/shows

| Parameter | Type   | Default |
| --------- | ------ | ------- |
| page      | number | 1       |
| limit     | number | 20      |
| sort      | string | watched |

Cache: max-age=3600

### GET /v1/watching/shows/:id

Show detail with seasons and episode watch progress.

Cache: max-age=86400

### GET /v1/watching/shows/:id/seasons/:season

Episodes in a season with watch status.

Cache: max-age=3600

### POST /v1/admin/watching/movies

Manually log a movie watch event. Provide either `tmdb_id` (preferred) or `title` + `year` (searches TMDB). Admin key required.

```bash
curl -X POST -H "Authorization: Bearer rw_admin_..." \
  -H "Content-Type: application/json" \
  -d '{"tmdb_id": 27205, "watched_at": "2026-03-08T21:00:00Z", "rating": 4.5}' \
  https://api.rewind.rest/v1/admin/watching/movies
```

```json
{
  "id": 45,
  "movie": { "id": 12, "title": "Inception", "year": 2010, "tmdb_id": 27205 },
  "watched_at": "2026-03-08T21:00:00Z",
  "source": "manual",
  "user_rating": 4.5,
  "rewatch": false
}
```

Cache: no-store

### PUT /v1/admin/watching/movies/:id

Edit a watch event (date, rating). Admin key required. The `:id` is the watch_history row ID.

```bash
curl -X PUT -H "Authorization: Bearer rw_admin_..." \
  -H "Content-Type: application/json" \
  -d '{"watched_at": "2026-03-07T20:00:00Z", "rating": 5.0}' \
  https://api.rewind.rest/v1/admin/watching/movies/45
```

```json
{
  "id": 45,
  "watched_at": "2026-03-07T20:00:00Z",
  "user_rating": 5.0
}
```

Cache: no-store

### DELETE /v1/admin/watching/movies/:id

Remove a watch event. Admin key required.

```bash
curl -X DELETE -H "Authorization: Bearer rw_admin_..." \
  https://api.rewind.rest/v1/admin/watching/movies/45
```

Returns: 204 No Content

Cache: no-store

### GET /v1/watching/stats

```json
{
  "data": {
    "total_movies": 342,
    "total_watch_time_hours": 567,
    "movies_this_year": 28,
    "avg_per_month": 2.3,
    "top_genre": "Drama",
    "top_decade": 2010,
    "top_director": "Wes Anderson"
  }
}
```

Cache: max-age=3600

### GET /v1/watching/stats/genres

```json
{
  "data": [
    { "name": "Drama", "count": 145, "percentage": 42.4 },
    { "name": "Comedy", "count": 89, "percentage": 26.0 }
  ]
}
```

Cache: max-age=3600

### GET /v1/watching/stats/decades

```json
{
  "data": [
    { "decade": 2010, "count": 98, "percentage": 28.7 },
    { "decade": 2000, "count": 76, "percentage": 22.2 }
  ]
}
```

Cache: max-age=3600

### GET /v1/watching/stats/directors

```json
{
  "data": [
    {
      "name": "Wes Anderson",
      "count": 9,
      "movies": [
        "The Grand Budapest Hotel",
        "Moonrise Kingdom",
        "The Royal Tenenbaums"
      ]
    },
    {
      "name": "Denis Villeneuve",
      "count": 7,
      "movies": ["Dune", "Arrival", "Blade Runner 2049"]
    }
  ]
}
```

Cache: max-age=3600

### GET /v1/watching/calendar

Same shape as listening/calendar but with movie watch counts.

Cache: max-age=3600

### GET /v1/watching/trends

| Parameter | Type   | Default |
| --------- | ------ | ------- |
| period    | string | monthly |

Cache: max-age=86400

### GET /v1/watching/ratings

Movies with user ratings. Paginated with sort options.

| Parameter | Type   | Default | Description        |
| --------- | ------ | ------- | ------------------ |
| page      | number | 1       | Page number        |
| limit     | number | 20      | Items per page     |
| sort      | string | rating  | rating, date       |
| order     | string | desc    | asc, desc          |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/watching/ratings?sort=rating&order=desc"
```

```json
{
  "data": [
    {
      "movie": {
        "id": 12,
        "title": "Inception",
        "year": 2010,
        "tmdb_id": 27205,
        "tmdb_rating": 8.4,
        "image": {
          "cdn_url": "https://cdn.rewind.rest/watching/movies/12/original.jpg?width=300&height=300&v=1",
          "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
          "dominant_color": "#1a2b3c",
          "accent_color": "#4d5e6f"
        }
      },
      "user_rating": 5.0,
      "watched_at": "2026-01-15T21:00:00Z",
      "source": "letterboxd"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 180, "total_pages": 9 }
}
```

Cache: max-age=3600

### GET /v1/watching/reviews

Movies with review text. Paginated.

| Parameter | Type   | Default |
| --------- | ------ | ------- |
| page      | number | 1       |
| limit     | number | 20      |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/watching/reviews?limit=5"
```

```json
{
  "data": [
    {
      "movie": {
        "id": 12,
        "title": "Inception",
        "year": 2010,
        "tmdb_id": 27205,
        "image": {
          "cdn_url": "https://cdn.rewind.rest/watching/movies/12/original.jpg?width=300&height=300&v=1",
          "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
          "dominant_color": "#1a2b3c",
          "accent_color": "#4d5e6f"
        }
      },
      "user_rating": 5.0,
      "review": "A masterclass in layered storytelling. Nolan at his most ambitious.",
      "watched_at": "2026-01-15T21:00:00Z",
      "source": "letterboxd"
    }
  ],
  "pagination": { "page": 1, "limit": 5, "total": 42, "total_pages": 9 }
}
```

Cache: max-age=3600

### GET /v1/watching/year/:year

Year-in-review for watching. Returns aggregate stats, genre/decade breakdowns, monthly counts, and top-rated movies for the given year.

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/watching/year/2025
```

```json
{
  "year": 2025,
  "total_movies": 52,
  "genres": [
    { "name": "Drama", "count": 24 },
    { "name": "Comedy", "count": 12 }
  ],
  "decades": [
    { "decade": 2020, "count": 18 },
    { "decade": 2010, "count": 15 }
  ],
  "monthly": [
    { "month": 1, "count": 5 },
    { "month": 2, "count": 3 }
  ],
  "top_rated": [
    {
      "movie": {
        "id": 12,
        "title": "Inception",
        "year": 2010,
        "tmdb_id": 27205,
        "image": {
          "cdn_url": "https://cdn.rewind.rest/watching/movies/12/original.jpg?width=300&height=300&v=1",
          "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
          "dominant_color": "#1a2b3c",
          "accent_color": "#4d5e6f"
        }
      },
      "user_rating": 5.0,
      "watched_at": "2025-01-15T21:00:00Z"
    }
  ]
}
```

Cache: max-age=86400

## Collection

### GET /v1/collecting/collection

| Parameter | Type   | Default |
| --------- | ------ | ------- | -------------------------- |
| page      | number | 1       |
| limit     | number | 20      |
| format    | string | -       | Vinyl, CD, Cassette        |
| genre     | string | -       |
| artist    | string | -       |
| sort      | string | added   | added, artist, title, year |
| order     | string | desc    |
| q         | string | -       | Search artist + title      |

```json
{
  "data": [
    {
      "id": 1,
      "discogs_id": 12345678,
      "title": "OK Computer",
      "artists": ["Radiohead"],
      "year": 1997,
      "format": "Vinyl",
      "format_detail": "2xLP, Album, Reissue, 180g",
      "label": "XL Recordings",
      "genres": ["Electronic", "Rock"],
      "styles": ["Alternative Rock"],
      "image": {
        "cdn_url": "https://cdn.rewind.rest/collecting/releases/1/original.jpg?width=300&height=300&v=1",
        "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
        "dominant_color": "#1a2b3c",
        "accent_color": "#4d5e6f"
      },
      "date_added": "2024-05-10T14:00:00Z",
      "rating": 5,
      "discogs_url": "https://www.discogs.com/release/12345678"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 145, "total_pages": 8 }
}
```

Cache: max-age=86400

### GET /v1/collecting/stats

```json
{
  "data": {
    "total_items": 145,
    "by_format": { "vinyl": 98, "cd": 42, "cassette": 5, "other": 0 },
    "wantlist_count": 23,
    "unique_artists": 87,
    "estimated_value": 3450.0,
    "top_genre": "Rock",
    "oldest_release_year": 1967,
    "newest_release_year": 2026,
    "most_collected_artist": { "name": "Radiohead", "count": 8 },
    "added_this_year": 12
  }
}
```

Cache: max-age=86400

### GET /v1/collecting/recent

| Parameter | Type   | Default |
| --------- | ------ | ------- |
| limit     | number | 5       |

Cache: max-age=3600

### GET /v1/collecting/collection/:id

Full release detail with tracklist, credits, and cross-reference data.

Cache: max-age=86400

### GET /v1/collecting/wantlist

Same params and shape as /v1/collecting/collection.

Cache: max-age=86400

### GET /v1/collecting/formats

```json
{
  "data": [
    { "format": "Vinyl", "count": 98, "percentage": 67.6 },
    { "format": "CD", "count": 42, "percentage": 29.0 },
    { "format": "Cassette", "count": 5, "percentage": 3.4 }
  ]
}
```

Cache: max-age=86400

### GET /v1/collecting/genres

```json
{
  "data": [
    { "genre": "Rock", "count": 67, "percentage": 46.2 },
    { "genre": "Electronic", "count": 34, "percentage": 23.4 }
  ]
}
```

Cache: max-age=86400

### GET /v1/collecting/artists

| Parameter | Type   | Default |
| --------- | ------ | ------- |
| limit     | number | 20      |

```json
{
  "data": [
    {
      "name": "Radiohead",
      "count": 8,
      "releases": ["OK Computer", "Kid A", "In Rainbows"]
    }
  ]
}
```

Cache: max-age=86400

### GET /v1/collecting/cross-reference

| Parameter | Type   | Default |
| --------- | ------ | ------- | ------------------------- |
| sort      | string | plays   | plays, added              |
| filter    | string | all     | listened, unlistened, all |
| page      | number | 1       |
| limit     | number | 20      |

```json
{
  "data": [
    {
      "collection": {
        "id": 1,
        "title": "OK Computer",
        "artists": ["Radiohead"],
        "format": "Vinyl",
        "image": {
          "cdn_url": "https://cdn.rewind.rest/collecting/releases/1/original.jpg?width=300&height=300&v=1",
          "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
          "dominant_color": "#1a2b3c",
          "accent_color": "#4d5e6f"
        }
      },
      "listening": {
        "album_id": 88,
        "play_count": 312,
        "last_played": "2026-03-08T22:00:00Z",
        "match_type": "exact",
        "match_confidence": 1.0
      }
    }
  ],
  "summary": {
    "total_matches": 67,
    "listen_rate": 0.46,
    "unlistened_count": 78
  },
  "pagination": { "page": 1, "limit": 20, "total": 67, "total_pages": 4 }
}
```

Cache: max-age=86400

## Physical Media (Trakt)

### GET /v1/collecting/media

Paginated list of physical media items from Trakt collection.

| Parameter | Type   | Default | Description                          |
| --------- | ------ | ------- | ------------------------------------ |
| page      | number | 1       | Page number                          |
| limit     | number | 20      | Items per page                       |
| format    | string | -       | Filter: bluray, 4k_uhd, hddvd       |
| genre     | string | -       | Filter by genre                      |
| q         | string | -       | Search title                         |
| sort      | string | added   | added, title, year                   |
| order     | string | desc    | asc, desc                            |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/collecting/media?format=4k_uhd&limit=10"
```

```json
{
  "data": [
    {
      "id": 1,
      "trakt_id": 12345,
      "tmdb_id": 27205,
      "imdb_id": "tt1375666",
      "title": "Inception",
      "year": 2010,
      "media_type": "movie",
      "format": "4k_uhd",
      "resolution": "uhd_4k",
      "hdr": "dolby_vision",
      "audio": "dolby_atmos",
      "audio_channels": "7.1",
      "collected_at": "2025-12-25T10:00:00Z",
      "image": {
        "cdn_url": "https://cdn.rewind.rest/collecting/media/1/original.jpg?width=300&height=300&v=1",
        "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
        "dominant_color": "#1a2b3c",
        "accent_color": "#4d5e6f"
      }
    }
  ],
  "pagination": { "page": 1, "limit": 10, "total": 85, "total_pages": 9 }
}
```

Cache: max-age=86400

### GET /v1/collecting/media/:id

Full detail for a single physical media item, including watch history cross-reference.

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/collecting/media/1
```

```json
{
  "id": 1,
  "trakt_id": 12345,
  "tmdb_id": 27205,
  "imdb_id": "tt1375666",
  "title": "Inception",
  "year": 2010,
  "media_type": "movie",
  "format": "4k_uhd",
  "resolution": "uhd_4k",
  "hdr": "dolby_vision",
  "audio": "dolby_atmos",
  "audio_channels": "7.1",
  "collected_at": "2025-12-25T10:00:00Z",
  "image": {
    "cdn_url": "https://cdn.rewind.rest/collecting/media/1/original.jpg?width=300&height=300&v=1",
    "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
    "dominant_color": "#1a2b3c",
    "accent_color": "#4d5e6f"
  },
  "watch_history": [
    {
      "watched_at": "2026-01-15T21:00:00Z",
      "source": "plex"
    }
  ]
}
```

Cache: max-age=86400

### GET /v1/collecting/media/stats

Breakdown statistics for the physical media collection.

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/collecting/media/stats
```

```json
{
  "data": {
    "total_items": 85,
    "by_format": { "bluray": 50, "4k_uhd": 30, "hddvd": 5 },
    "by_resolution": { "hd_1080p": 50, "uhd_4k": 30, "hd_720p": 5 },
    "by_hdr": { "dolby_vision": 20, "hdr10": 8, "none": 57 },
    "by_genre": { "Action": 25, "Drama": 20, "Sci-Fi": 15 },
    "by_decade": { "2020": 15, "2010": 35, "2000": 20, "1990": 15 }
  }
}
```

Cache: max-age=86400

### GET /v1/collecting/media/recent

Latest additions to the physical media collection.

| Parameter | Type   | Default |
| --------- | ------ | ------- |
| limit     | number | 5       |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/collecting/media/recent?limit=3"
```

Cache: max-age=3600

### GET /v1/collecting/media/formats

Format counts for the physical media collection.

```bash
curl -H "Authorization: Bearer rw_live_..." https://api.rewind.rest/v1/collecting/media/formats
```

```json
{
  "data": [
    { "format": "bluray", "count": 50, "percentage": 58.8 },
    { "format": "4k_uhd", "count": 30, "percentage": 35.3 },
    { "format": "hddvd", "count": 5, "percentage": 5.9 }
  ]
}
```

Cache: max-age=86400

### GET /v1/collecting/media/cross-reference

Cross-reference owned physical media with watching domain watch history.

| Parameter | Type   | Default | Description                   |
| --------- | ------ | ------- | ----------------------------- |
| filter    | string | all     | all, watched, unwatched       |
| page      | number | 1       | Page number                   |
| limit     | number | 20      | Items per page                |

```bash
curl -H "Authorization: Bearer rw_live_..." "https://api.rewind.rest/v1/collecting/media/cross-reference?filter=unwatched"
```

```json
{
  "data": [
    {
      "media": {
        "id": 1,
        "title": "Inception",
        "format": "4k_uhd",
        "image": null
      },
      "watching": {
        "movie_id": 12,
        "watch_count": 2,
        "last_watched": "2026-01-15T21:00:00Z"
      }
    }
  ],
  "summary": {
    "total": 85,
    "watched": 60,
    "unwatched": 25,
    "watch_rate": 0.71
  },
  "pagination": { "page": 1, "limit": 20, "total": 85, "total_pages": 5 }
}
```

Cache: max-age=86400

### POST /v1/admin/collecting/media

Add an item to the physical media collection. Admin key required. Write-through to Trakt.

```bash
curl -X POST -H "Authorization: Bearer rw_admin_..." \
  -H "Content-Type: application/json" \
  -d '{"tmdb_id": 27205, "media_type": "movie", "resolution": "uhd_4k", "hdr": "dolby_vision", "audio": "dolby_atmos", "audio_channels": "7.1"}' \
  https://api.rewind.rest/v1/admin/collecting/media
```

```json
{
  "id": 86,
  "trakt_id": 12345,
  "tmdb_id": 27205,
  "title": "Inception",
  "media_type": "movie",
  "format": "4k_uhd",
  "resolution": "uhd_4k",
  "collected_at": "2026-03-11T12:00:00Z"
}
```

Cache: no-store

### POST /v1/admin/collecting/media/:id/remove

Remove an item from the physical media collection. Admin key required. Write-through to Trakt.

```bash
curl -X POST -H "Authorization: Bearer rw_admin_..." \
  https://api.rewind.rest/v1/admin/collecting/media/86/remove
```

```json
{
  "removed": true,
  "id": 86,
  "title": "Inception"
}
```

Cache: no-store

### POST /v1/admin/sync/trakt

Trigger a manual Trakt collection sync. Admin key required.

```bash
curl -X POST -H "Authorization: Bearer rw_admin_..." \
  https://api.rewind.rest/v1/admin/sync/trakt
```

```json
{
  "sync_id": 1236,
  "domain": "collecting",
  "source": "trakt",
  "sync_type": "full",
  "status": "started"
}
```

Cache: no-store

### POST /v1/admin/collecting/media/backfill-images

Backfill poster images for physical media items missing artwork. Admin key required.

```bash
curl -X POST -H "Authorization: Bearer rw_admin_..." \
  https://api.rewind.rest/v1/admin/collecting/media/backfill-images
```

```json
{
  "queued": 12,
  "already_have_images": 73,
  "total": 85
}
```

Cache: no-store

## Images

### GET /v1/images/:domain/:entity_type/:entity_id/:size

Returns a redirect to the CDN URL for the requested image. If the image is not yet cached in R2, triggers the image pipeline to fetch, store, and generate ThumbHash.

Sizes: thumbnail (64px), small (150px), medium (300px), large (600px), poster (342x513), poster-lg (500x750), backdrop (780x439), original

```bash
curl -H "Authorization: Bearer rw_live_..." -L "https://api.rewind.rest/v1/images/listening/albums/abc123-mbid/medium"
```

Response: 302 redirect to cdn.rewind.rest with X-ThumbHash header.

Cache: max-age=31536000, immutable

### GET /v1/admin/images/:domain/:entity_type/:entity_id/alternatives

Browse available images from all sources in the waterfall. Does not store anything. Admin key required.

```bash
curl -H "Authorization: Bearer rw_admin_..." https://api.rewind.rest/v1/admin/images/listening/albums/abc123-mbid/alternatives
```

```json
{
  "entity": {
    "domain": "listening",
    "entity_type": "albums",
    "entity_id": "abc123-mbid"
  },
  "current_source": "cover-art-archive",
  "is_override": false,
  "alternatives": [
    {
      "source": "cover-art-archive",
      "url": "https://coverartarchive.org/release/abc123/front",
      "width": 1200,
      "height": 1200
    },
    {
      "source": "itunes",
      "url": "https://is1-ssl.mzstatic.com/image/thumb/Music/.../600x600bb.jpg",
      "width": 600,
      "height": 600
    },
    {
      "source": "apple-music",
      "url": "https://is1-ssl.mzstatic.com/image/thumb/Music/.../3000x3000bb.jpg",
      "width": 3000,
      "height": 3000
    }
  ]
}
```

Cache: no-store

### PUT /v1/admin/images/:domain/:entity_type/:entity_id

Manually override an image. Accepts JSON body with `source_url` or multipart/form-data image upload. Uploads to R2, regenerates ThumbHash and colors, sets `is_override = 1`, increments `image_version`. Admin key required.

```bash
curl -X PUT -H "Authorization: Bearer rw_admin_..." \
  -H "Content-Type: application/json" \
  -d '{"source_url": "https://is1-ssl.mzstatic.com/image/thumb/Music/.../3000x3000bb.jpg"}' \
  https://api.rewind.rest/v1/admin/images/listening/albums/abc123-mbid
```

```json
{
  "domain": "listening",
  "entity_type": "albums",
  "entity_id": "abc123-mbid",
  "image_url": "https://cdn.rewind.rest/listening/albums/abc123-mbid/original.jpg?v=2",
  "source": "manual",
  "is_override": true,
  "image_version": 2,
  "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
  "dominant_color": "#2a3b4c",
  "accent_color": "#5e6f80"
}
```

Cache: no-store

### DELETE /v1/admin/images/:domain/:entity_type/:entity_id/override

Revert a manual override. Clears the override flag, re-runs the automatic pipeline, and restores the highest-priority source image. Admin key required.

```bash
curl -X DELETE -H "Authorization: Bearer rw_admin_..." \
  https://api.rewind.rest/v1/admin/images/listening/albums/abc123-mbid/override
```

```json
{
  "domain": "listening",
  "entity_type": "albums",
  "entity_id": "abc123-mbid",
  "image_url": "https://cdn.rewind.rest/listening/albums/abc123-mbid/original.jpg?v=3",
  "source": "cover-art-archive",
  "is_override": false,
  "image_version": 3,
  "thumbhash": "XJpGOQw8rElslahEafRE+Q6nJ2h1iA==",
  "dominant_color": "#1a2b3c",
  "accent_color": "#4d5e6f"
}
```

Cache: no-store

### GET /v1/listening/admin/filters

List all Last.fm scrobble filters. Admin key required.

```bash
curl -H "Authorization: Bearer rw_admin_..." https://api.rewind.rest/v1/listening/admin/filters
```

```json
{
  "data": [
    {
      "id": 1,
      "filter_type": "holiday",
      "pattern": "Christmas",
      "scope": "album",
      "reason": "Holiday music filter",
      "created_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

### POST /v1/listening/admin/filters

Create a new scrobble filter. Admin key required.

| Body Field  | Type   | Required | Description                                          |
| ----------- | ------ | -------- | ---------------------------------------------------- |
| filter_type | string | yes      | holiday, audiobook, custom                           |
| pattern     | string | yes      | Text pattern to match                                |
| scope       | string | yes      | album, track, artist, artist_track, track_regex      |
| reason      | string | no       | Human-readable reason for the filter                 |

```bash
curl -X POST https://api.rewind.rest/v1/listening/admin/filters \
  -H "Authorization: Bearer rw_admin_..." \
  -H "Content-Type: application/json" \
  -d '{"filter_type": "holiday", "pattern": "Christmas Hits", "scope": "album", "reason": "Holiday compilation"}'
```

Returns 201 with the created filter object.

### DELETE /v1/listening/admin/filters/:id

Delete a scrobble filter. Admin key required.

```bash
curl -X DELETE https://api.rewind.rest/v1/listening/admin/filters/1 \
  -H "Authorization: Bearer rw_admin_..."
```

```json
{
  "success": true,
  "deleted_id": 1
}
```

### POST /v1/listening/admin/listening/backfill-images

Backfill images for listening entities missing them. Admin key required.

| Body Field | Type   | Default | Description              |
| ---------- | ------ | ------- | ------------------------ |
| type       | string | albums  | albums, artists, all     |
| limit      | number | 50      | Max items to process (max 200) |

```bash
curl -X POST https://api.rewind.rest/v1/listening/admin/listening/backfill-images \
  -H "Authorization: Bearer rw_admin_..." \
  -H "Content-Type: application/json" \
  -d '{"type": "all", "limit": 100}'
```

### POST /v1/watching/admin/watching/backfill-images

Backfill images for watching entities missing them. Admin key required.

| Body Field | Type   | Default | Description              |
| ---------- | ------ | ------- | ------------------------ |
| type       | string | movies  | movies, shows, all       |
| limit      | number | 50      | Max items to process (max 200) |

```bash
curl -X POST https://api.rewind.rest/v1/watching/admin/watching/backfill-images \
  -H "Authorization: Bearer rw_admin_..." \
  -H "Content-Type: application/json" \
  -d '{"type": "all", "limit": 100}'
```

### POST /v1/admin/images/reprocess

Re-generate thumbhash and colors for images that have R2 keys but missing metadata. Reads from R2, no external API calls needed. Admin key required.

| Body Field | Type   | Default | Description              |
| ---------- | ------ | ------- | ------------------------ |
| limit      | number | 50      | Max items to process (max 100) |

```bash
curl -X POST https://api.rewind.rest/v1/admin/images/reprocess \
  -H "Authorization: Bearer rw_admin_..." \
  -H "Content-Type: application/json" \
  -d '{"limit": 50}'
```

```json
{
  "success": true,
  "processed": 12,
  "failed": 0
}
```

## Webhooks

### GET /v1/webhooks/strava

Strava webhook validation endpoint. Responds to subscription verification.

```text
GET /v1/webhooks/strava?hub.mode=subscribe&hub.challenge=abc123&hub.verify_token=mytoken
```

```json
{ "hub.challenge": "abc123" }
```

### POST /v1/webhooks/strava

Receives Strava activity events.

```json
{
  "aspect_type": "create",
  "event_time": 1709251200,
  "object_id": 12345678,
  "object_type": "activity",
  "owner_id": 98765,
  "subscription_id": 54321
}
```

Returns: 200 OK (must respond within 2 seconds)

### POST /v1/webhooks/plex

Receives Plex media events (Plex Pass required). Payload is multipart/form-data with a "payload" JSON field.

Primary event: media.scrobble (item marked as watched)

Returns: 200 OK

## Export

### GET /v1/admin/export/:domain

Full data export for a domain. Admin key required.

| Parameter | Type   | Default |
| --------- | ------ | ------- |
| format    | string | json    |

```bash
curl -H "Authorization: Bearer rw_admin_..." https://api.rewind.rest/v1/export/listening > listening-backup.json
```

Returns complete domain data as a JSON array. Streamed for large datasets.

Cache: no-store
