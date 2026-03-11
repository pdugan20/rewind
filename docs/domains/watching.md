# Watching Domain

Movie and TV show watch history from three sources: Plex webhooks (real-time), Letterboxd RSS feed (periodic sync), and manual entry (admin endpoint). All movies are enriched with TMDB metadata for genres, directors, posters, and ratings.

## Data Sources

- Plex -- movie and TV show library and watch history. Plex Pass subscription for webhooks.
- Letterboxd -- movie diary via public RSS feed. Captures movies watched outside Plex (theater, streaming, etc.).
- Manual entry -- admin endpoint for logging movies not tracked by either source.
- TMDB -- movie and TV metadata enrichment: genres, directors, cast, posters, ratings.

## Plex API

### Base Configuration

- Base URL: `{PLEX_URL}` (user's Plex server)
- Auth: `X-Plex-Token` header or query parameter
- Required headers: `X-Plex-Client-Identifier`, `X-Plex-Product`, `Accept: application/json`
- Rate limit: None (your own server)

### Key Endpoints

| Method | Endpoint                                                      | Description            |
| ------ | ------------------------------------------------------------- | ---------------------- |
| GET    | /library/sections                                             | List all libraries     |
| GET    | /library/sections/{id}/all                                    | All items in a library |
| GET    | /library/sections/{id}/all?sort=lastViewedAt:desc&unwatched=0 | Watched items          |
| GET    | /library/metadata/{id}                                        | Single item detail     |
| GET    | /status/sessions                                              | Currently playing      |
| GET    | /photo/:/transcode?url=...&width=...&height=...               | Image resize/transcode |

### Metadata Fields

- `ratingKey` (Plex internal ID)
- `title`, `year`, `tagline`, `summary`
- `contentRating` (PG-13, R, etc.)
- `rating`, `audienceRating`
- `duration` (milliseconds)
- `studio`
- `viewCount`, `lastViewedAt` (epoch)
- `thumb`, `art` (relative paths for images)
- Guid array: `[{ id: "imdb://tt1375666" }, { id: "tmdb://27205" }]`
- Genre array: `[{ tag: "Science Fiction" }]`
- Director array: `[{ tag: "Christopher Nolan" }]`
- Role array: `[{ tag: "Leonardo DiCaprio", role: "Cobb" }]`

## Plex Webhooks

### Configuration

- Requires: Plex Pass subscription
- Setup: Plex Settings > Webhooks > Add `https://api.rewind.rest/webhooks/plex`

### Events

| Event          | Description                         | Use                           |
| -------------- | ----------------------------------- | ----------------------------- |
| media.play     | Playback started                    | Log (optional)                |
| media.pause    | Playback paused                     | Ignore                        |
| media.resume   | Playback resumed                    | Ignore                        |
| media.stop     | Playback stopped                    | Log (optional)                |
| media.scrobble | Item marked watched (~90% complete) | Primary -- record watch event |
| media.rate     | Item rated by user                  | Update rating (optional)      |

### Payload Format

Plex sends webhooks as `multipart/form-data` POST with a "payload" JSON field:

```json
{
  "event": "media.scrobble",
  "user": true,
  "owner": true,
  "Account": {
    "id": 12345678,
    "title": "Username"
  },
  "Server": {
    "title": "ServerName",
    "uuid": "server-uuid"
  },
  "Player": {
    "local": true,
    "publicAddress": "1.2.3.4",
    "title": "Apple TV",
    "uuid": "player-uuid"
  },
  "Metadata": {
    "librarySectionType": "movie",
    "ratingKey": "12345",
    "type": "movie",
    "title": "Inception",
    "year": 2010,
    "summary": "...",
    "rating": 8.8,
    "audienceRating": 9.1,
    "contentRating": "PG-13",
    "duration": 8880000,
    "studio": "Warner Bros.",
    "thumb": "/library/metadata/12345/thumb/1680000000",
    "art": "/library/metadata/12345/art/1680000000",
    "Guid": [{ "id": "imdb://tt1375666" }, { "id": "tmdb://27205" }],
    "Genre": [{ "tag": "Science Fiction" }, { "tag": "Action" }],
    "Director": [{ "tag": "Christopher Nolan" }]
  }
}
```

May also include a "thumb" file part (JPEG poster).

### Webhook Verification

Verify webhook source by checking `Account.id` or `Server.uuid` matches expected values. Optionally use a shared secret via `PLEX_WEBHOOK_SECRET`.

### Parsing in Workers

Plex sends `multipart/form-data`, not JSON. Use a multipart parser to extract the "payload" field. The `busboy` library does not work in Workers -- use a Workers-compatible multipart parser or manually parse the boundary.

## TMDB API

### Base Configuration

- Base URL: `https://api.themoviedb.org/3`
- Auth: `Authorization: Bearer {TMDB_API_KEY}` (v4 read access token)
- Rate limit: ~50 requests/second
- Image base: `https://image.tmdb.org/t/p/{size}/{path}`

### Key Endpoints

| Method | Endpoint            | Description           | Key Params                 |
| ------ | ------------------- | --------------------- | -------------------------- |
| GET    | /movie/{id}         | Movie details         | append_to_response=credits |
| GET    | /search/movie       | Search by title       | query, year, page          |
| GET    | /movie/{id}/credits | Cast and crew         | none                       |
| GET    | /movie/{id}/images  | Posters and backdrops | none                       |

### Matching Strategy

**From Plex:**

1. Extract `tmdb_id` from Plex Guid array (preferred -- exact match)
2. Extract `imdb_id` from Plex Guid array, search TMDB by external ID
3. Fallback: search by title + year

**From Letterboxd:** Use `<tmdb:movieId>` directly from RSS feed (exact match).

**From manual entry:** Accept `tmdb_id` directly, or search by title + year.

### Image Sizes

| Size     | Dimensions      | Use             |
| -------- | --------------- | --------------- |
| w92      | 92px wide       | Tiny thumbnails |
| w185     | 185px wide      | Small cards     |
| w342     | 342px wide      | Medium cards    |
| w500     | 500px wide      | Large cards     |
| w780     | 780px wide      | Detail view     |
| original | Full resolution | Source for R2   |

## Letterboxd RSS Feed

### Configuration

- Feed URL: `https://letterboxd.com/{LETTERBOXD_USERNAME}/rss/`
- Auth: None (public feed)
- Format: RSS 2.0 with Letterboxd custom namespace
- Limit: Returns last 50 diary entries

### RSS Item Fields

Standard RSS fields plus Letterboxd extensions:

- `<letterboxd:filmTitle>` -- film title
- `<letterboxd:filmYear>` -- release year
- `<letterboxd:watchedDate>` -- date watched (YYYY-MM-DD)
- `<letterboxd:memberRating>` -- user rating (0.5-5.0 scale)
- `<letterboxd:rewatch>` -- "Yes" or "No"
- `<tmdb:movieId>` -- TMDB ID (used for enrichment and deduplication)
- `<guid>` -- unique entry ID (e.g., `letterboxd-watch-117795457`)

### Example RSS Item

```xml
<item>
  <title>Inception, 2010 - ★★★★★</title>
  <link>https://letterboxd.com/username/film/inception/</link>
  <guid isPermaLink="false">letterboxd-watch-117795457</guid>
  <pubDate>Mon, 9 Mar 2026 08:00:00 +1200</pubDate>
  <letterboxd:watchedDate>2026-03-08</letterboxd:watchedDate>
  <letterboxd:rewatch>No</letterboxd:rewatch>
  <letterboxd:filmTitle>Inception</letterboxd:filmTitle>
  <letterboxd:filmYear>2010</letterboxd:filmYear>
  <letterboxd:memberRating>5.0</letterboxd:memberRating>
  <tmdb:movieId>27205</tmdb:movieId>
</item>
```

## Manual Movie Entry

Movies can be logged manually via admin endpoints when they are not tracked by Plex or Letterboxd (e.g., watched at a friend's house, at a theater without logging to Letterboxd, etc.).

### Admin Endpoints

```text
POST   /v1/admin/watching/movies          -- log a new watch event
PUT    /v1/admin/watching/movies/:id       -- edit a watch event
DELETE /v1/admin/watching/movies/:id       -- remove a watch event
```

POST accepts either a `tmdb_id` (preferred, triggers TMDB enrichment) or `title` + `year` (searches TMDB to find match). Watched date defaults to now if not provided.

## Deduplication

Same movie + same calendar date (UTC) = same watch event, regardless of source. This prevents double-counting when the same movie is logged on both Plex and Letterboxd.

### Source Priority

When a duplicate is detected during sync, the higher-priority source wins:

1. **Plex** -- richest data (actual playback, percent complete, duration)
2. **Letterboxd** -- has user rating, rewatch flag
3. **Manual** -- least metadata

### Rewatch Handling

Watching the same movie on different dates always creates separate watch events. The dedup check is only same movie + same day. This means "most rewatched movies" stats come naturally from the data.

## Sync Strategy

- **Plex webhooks**: `media.scrobble` events (real-time)
- **Plex catch-up cron** (daily 5 AM): scan Plex library for watched items not in DB
- **Letterboxd cron** (every 6 hours): fetch RSS feed, insert new entries not already in DB
- **Letterboxd initial import**: one-time CSV import from `https://letterboxd.com/user/exportdata/` for full diary history
- **Manual entry**: on-demand via admin endpoint
- **TMDB enrichment**: on first encounter of a movie from any source, fetch TMDB details + credits + images. Store in `movies` table with genres/directors in join tables.
- **Dedup check**: before inserting any watch event, check for existing entry with same movie_id + same calendar date

## Endpoints

All endpoints require `Authorization: Bearer rw_...` header.

| Method | Path                                   | Description                       | Cache  | Query Params                                            |
| ------ | -------------------------------------- | --------------------------------- | ------ | ------------------------------------------------------- |
| GET    | /v1/watching/recent                    | Recently watched movies           | 60s    | limit (default 5, max 20)                               |
| GET    | /v1/watching/movies                    | All watched movies                | 3600s  | page, limit, genre, decade, director, year, sort, order |
| GET    | /v1/watching/movies/:id                | Single movie detail               | 86400s | none                                                    |
| GET    | /v1/watching/stats                     | Overall watch statistics          | 3600s  | none                                                    |
| GET    | /v1/watching/stats/genres              | Genre breakdown                   | 3600s  | none                                                    |
| GET    | /v1/watching/stats/decades             | Movies by decade                  | 3600s  | none                                                    |
| GET    | /v1/watching/stats/directors           | Top directors                     | 3600s  | none                                                    |
| GET    | /v1/watching/calendar                  | Watch activity heatmap            | 3600s  | year                                                    |
| GET    | /v1/watching/trends                    | Watching trends over time         | 86400s | period                                                  |
| GET    | /v1/watching/shows                     | All watched shows                 | 3600s  | page, limit, sort, order                                |
| GET    | /v1/watching/shows/:id                 | Show detail with seasons          | 86400s | none                                                    |
| GET    | /v1/watching/shows/:id/seasons/:season | Season episodes with watch status | 3600s  | none                                                    |
| POST   | /v1/admin/watching/movies              | Log a movie watch event (admin)   | --     | tmdb_id or title+year, watched_at, rating               |
| PUT    | /v1/admin/watching/movies/:id          | Edit a watch event (admin)        | --     | watched_at, rating                                      |
| DELETE | /v1/admin/watching/movies/:id          | Remove a watch event (admin)      | --     | none                                                    |
| POST   | /v1/admin/watching/backfill-images     | Backfill R2 images for entities   | --     | type (movies/shows/all), limit                          |

All tables include `user_id` for multi-user support (default 1).

## Response Types

```typescript
interface Movie {
  id: number;
  title: string;
  year: number;
  director: string;
  directors: string[];
  genres: string[];
  duration_min: number;
  rating: string;
  poster_url: string | null;
  backdrop_url: string | null;
  thumbhash: string | null;
  dominant_color: string | null;
  accent_color: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tmdb_rating: number | null;
  tagline: string | null;
  summary: string | null;
}

interface WatchEvent {
  movie: Movie;
  watched_at: string;
  source: 'plex' | 'letterboxd' | 'manual';
  user_rating: number | null;
  percent_complete: number | null;
  rewatch: boolean;
}

interface WatchingStats {
  total_movies: number;
  total_watch_time_hours: number;
  movies_this_year: number;
  avg_per_month: number;
  top_genre: string;
  top_decade: number;
  top_director: string;
  total_shows: number;
  total_episodes_watched: number;
  episodes_this_year: number;
}

interface GenreBreakdown {
  name: string;
  count: number;
  percentage: number;
}

interface Show {
  id: number;
  title: string;
  year: number;
  tmdb_id: number | null;
  tmdb_rating: number | null;
  content_rating: string | null;
  summary: string | null;
  poster_url: string | null;
  backdrop_url: string | null;
  thumbhash: string | null;
  dominant_color: string | null;
  accent_color: string | null;
  total_seasons: number;
  total_episodes: number;
  episodes_watched: number;
}

interface EpisodeWatched {
  season: number;
  episode: number;
  title: string | null;
  watched_at: string;
}
```

## TMDB Attribution

Required attribution for any project using the TMDB API:

- "This product uses the TMDB API but is not endorsed or certified by TMDB"
- Display TMDB logo in About/Credits section
- Can cache data and images for up to 6 months

## Environment Variables

| Variable            | Description                                      |
| ------------------- | ------------------------------------------------ |
| PLEX_URL            | Plex server URL (e.g., https://plex.example.com) |
| PLEX_TOKEN          | Plex authentication token                        |
| PLEX_WEBHOOK_SECRET | Shared secret for webhook verification           |
| TMDB_API_KEY        | TMDB v4 read access token                        |
| LETTERBOXD_USERNAME | Letterboxd username for RSS feed URL             |

## Image Pipeline Integration

Movie and TV show posters are served via the R2 image pipeline at `cdn.rewind.rest`. The pipeline is lazy -- images are fetched and processed on first request to `/v1/images/watching/movies/:id/:size` or `/v1/images/watching/shows/:id/:size`.

Source priority for movies: TMDB -> FanartTV -> Plex.
Source priority for shows: TMDB -> FanartTV -> Plex.

Image overrides are supported via admin endpoints for manually selecting alternative artwork.

All watching routes return `thumbhash`, `dominant_color`, and `accent_color` from the images table (joined via domain + entity_type + entity_id).

## Known Issues

- Plex webhooks require Plex Pass (paid)
- Plex webhook payloads are multipart/form-data, not JSON -- needs special parsing
- Duration in Plex is milliseconds, in TMDB is minutes
- TMDB search may return wrong movie for ambiguous titles
- Plex server must be accessible from cloud for library scan -- use plex.direct HTTPS URL with public IP (e.g., `https://1-2-3-4.{cert_hash}.plex.direct:port`)
- Plex webhook URL must be publicly accessible (Plex cloud relay sends the webhook)
- Letterboxd RSS feed only returns last 50 entries -- use CSV import for full history
- Letterboxd official API is invite-only and does not approve personal projects
- Letterboxd ratings are 0.5-5.0 scale (half stars) vs TMDB 0-10 scale
- Dedup relies on TMDB ID matching -- movies without TMDB IDs may create duplicates
- Worker subrequest limit (1000 on paid plan) requires batching during Plex library sync -- capped at 150 new items per domain per run
