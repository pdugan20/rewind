# Collecting Domain

Physical vinyl, CD, and movie collection. Music from Discogs with wantlist tracking and cross-reference to Last.fm listening data. Movies from Trakt with cross-reference to Plex watch history. Admin endpoints allow adding items to both collections directly.

## Data Source

- Discogs -- physical record collection and wantlist. Username: patdugan

## Discogs API

### Base Configuration

- Base URL: `https://api.discogs.com`
- Auth: `Authorization: Discogs token={DISCOGS_PERSONAL_TOKEN}`
- Rate limit: 60 requests/minute (authenticated)
- Required: `User-Agent` header (e.g., "RewindAPI/1.0")
- Pagination: `page` + `per_page` (max 100)
- Note: Image downloads limited to 1,000 per 24-hour period per application

### Key Endpoints

| Method | Endpoint                                                        | Description               | Key Params                       |
| ------ | --------------------------------------------------------------- | ------------------------- | -------------------------------- |
| GET    | /users/{username}/collection/folders/0/releases                 | All collection items      | page, per_page, sort, sort_order |
| GET    | /users/{username}/collection/folders                            | Collection folders        | none                             |
| GET    | /users/{username}/wants                                         | Wantlist items            | page, per_page                   |
| GET    | /releases/{id}                                                  | Release detail            | none                             |
| GET    | /artists/{id}                                                   | Artist detail             | none                             |
| GET    | /users/{username}/collection/value                              | Collection value estimate | none                             |
| GET    | /database/search                                                | Search releases           | q, type, artist, year, per_page  |
| POST   | /users/{username}/collection/folders/{id}/releases/{release_id} | Add to collection         | none                             |

### Release Fields

- `id`, `title`, `year`
- `artists`: `[{ name, id }]`
- `labels`: `[{ name, catno }]`
- `formats`: `[{ name: "Vinyl", qty: "2", descriptions: ["LP", "Album", "Reissue", "180g"] }]`
- `genres`: `["Electronic", "Rock"]`
- `styles`: `["Alternative Rock", "Art Rock"]`
- `images`: `[{ type: "primary", uri: "...", width, height }]`
- `community`: `{ have, want }`
- `lowest_price` (marketplace)
- `num_for_sale`

### Collection Item Fields

- `instance_id` (unique per copy owned)
- `folder_id` (0 = "All")
- `rating` (0-5)
- `notes` (user notes array)
- `date_added` (ISO 8601)

## Sync Strategy

- **Weekly full sync** (Sunday 6 AM): paginate entire collection via `GET /users/{username}/collection/folders/0/releases`. Compare with local data -- insert new, update changed, remove deleted.
- **Wantlist sync**: alongside collection, fetch `GET /users/{username}/wants`
- **Release detail**: on first encounter, fetch `GET /releases/{id}` for full metadata (tracklist, credits, images)
- **Collection stats**: recompute after each sync (format breakdown, genre breakdown, decade breakdown, estimated value)
- **Cross-reference**: after each sync, run matching against Last.fm data

## Cross-Reference with Last.fm

### Matching Algorithm

1. Normalize names: lowercase, trim, remove leading "The ", remove parenthetical suffixes like "(Reissue)", "(Deluxe Edition)"
2. For each Discogs release, search `lastfm_albums` by normalized artist + album name
3. Match types:
   - **exact**: artist and album name match exactly after normalization (confidence: 1.0)
   - **fuzzy**: Levenshtein distance < 3 between album names, artist matches (confidence: 0.7-0.9)
   - **artist_only**: same artist, no matching album found (confidence: 0.5)
4. Store matches in `collection_listening_xref` with play_count from Last.fm
5. Records with no match get null `lastfm_album_id`

### Use Cases

- "Records you own and listen to most" -- collection items sorted by play_count
- "Records you own but never listen to" -- collection items with play_count = 0 or no match
- "Records you listen to but don't own" -- top Last.fm albums not in collection
- Collection listen rate: percentage of collection that has been played

## Endpoints

All endpoints require `Authorization: Bearer rw_...` header.

| Method | Path                                  | Description                          | Cache  | Query Params                                                       |
| ------ | ------------------------------------- | ------------------------------------ | ------ | ------------------------------------------------------------------ |
| GET    | /v1/collection                        | Full collection                      | 86400s | page, limit, format, genre, artist, sort, order, q, date, from, to |
| GET    | /v1/collection/stats                  | Collection statistics                | 86400s | date, from, to                                                     |
| GET    | /v1/collection/recent                 | Recently added items                 | 3600s  | limit, date, from, to                                              |
| GET    | /v1/collection/:id                    | Single release detail                | 86400s | none                                                               |
| GET    | /v1/collection/wantlist               | Wantlist items                       | 86400s | page, limit, sort, order                                           |
| GET    | /v1/collection/formats                | Format breakdown                     | 86400s | none                                                               |
| GET    | /v1/collection/genres                 | Genre breakdown                      | 86400s | none                                                               |
| GET    | /v1/collection/artists                | Top artists in collection            | 86400s | limit (default 20)                                                 |
| GET    | /v1/collection/cross-reference        | Collection matched to listening data | 86400s | sort (plays/added), filter (listened/unlistened/all)               |
| GET    | /v1/collecting/calendar               | Daily addition counts (vinyl+media)  | 3600s  | year (default current)                                             |
| GET    | /v1/collecting/media                  | Physical media collection            | 86400s | page, limit, format, genre, sort, order, q, date, from, to         |
| GET    | /v1/collecting/media/recent           | Recently added media                 | 3600s  | limit, date, from, to                                              |
| POST   | /v1/admin/collecting/vinyl            | Add music release to collection      | --     | discogs_id or title/artist/year                                    |
| POST   | /v1/admin/collecting/media            | Add movie to physical media          | --     | tmdb_id/imdb_id/title, media_type                                  |
| POST   | /v1/admin/collecting/media/:id/remove | Remove movie from physical media     | --     | none                                                               |

All tables include `user_id` for multi-user support (default 1).

## Response Types

```typescript
interface CollectionItem {
  id: number;
  discogs_id: number;
  title: string;
  artists: string[];
  year: number;
  format: string;
  format_detail: string;
  label: string;
  genres: string[];
  styles: string[];
  cover_url: string | null;
  thumbhash: string | null;
  dominant_color: string | null;
  accent_color: string | null;
  date_added: string;
  rating: number | null;
  discogs_url: string;
}

interface CollectionStats {
  total_items: number;
  by_format: { vinyl: number; cd: number; cassette: number; other: number };
  wantlist_count: number;
  unique_artists: number;
  estimated_value: number | null;
  top_genre: string;
  oldest_release_year: number;
  newest_release_year: number;
  most_collected_artist: { name: string; count: number };
  added_this_year: number;
}

interface CrossReferenceItem {
  collection: CollectionItem;
  listening: {
    album_id: number | null;
    play_count: number;
    last_played: string | null;
    match_type: string;
    match_confidence: number;
  };
}

interface CrossReferenceResponse {
  data: CrossReferenceItem[];
  summary: {
    total_matches: number;
    listen_rate: number;
    unlistened_count: number;
  };
  pagination: Pagination;
}
```

## Environment Variables

| Variable               | Description                   |
| ---------------------- | ----------------------------- |
| DISCOGS_PERSONAL_TOKEN | Discogs personal access token |
| DISCOGS_USERNAME       | Discogs username (patdugan)   |

## Physical Media (Trakt)

### Data Source

Trakt API provides physical movie media collection tracking (Blu-ray, 4K UHD, HD-DVD). Trakt tracks what media a user owns with metadata about format, resolution, HDR type, and audio configuration.

### Trakt API

#### Base Configuration

- Base URL: `https://api.trakt.tv`
- Auth: OAuth2 with device code flow for initial setup, then access/refresh token pairs
- Required headers: `Content-Type: application/json`, `trakt-api-version: 2`, `trakt-api-key: {TRAKT_CLIENT_ID}`
- Rate limit: 1000 requests per 5-minute window
- Pagination: `page` + `limit` headers on list endpoints

#### Key Endpoints

| Method | Endpoint                            | Description                  | Key Params                     |
| ------ | ----------------------------------- | ---------------------------- | ------------------------------ |
| GET    | /users/{username}/collection/movies | All collected movies         | none                           |
| POST   | /sync/collection                    | Add items to collection      | movies array                   |
| POST   | /sync/collection/remove             | Remove items from collection | movies array                   |
| GET    | /users/{username}/watchlist         | Watchlist items              | none                           |
| POST   | /oauth/device/code                  | Start device code flow       | client_id                      |
| POST   | /oauth/device/token                 | Poll for device auth token   | code, client_id, client_secret |

### Sync Strategy

- **Weekly full sync** (Sunday 3 AM UTC): fetch entire collection via `GET /users/{username}/collection/movies`. Compare with local `trakt_collection` table -- insert new, update changed, soft-delete removed items.
- **Write-through**: movie items added or removed via admin endpoints (`POST /v1/admin/collecting/media`, `POST /v1/admin/collecting/media/:id/remove`) are pushed to Trakt in real-time. Music items added via `POST /v1/admin/collecting/vinyl` are pushed to Discogs in real-time.
- **Collection stats**: recompute after each sync (format, resolution, HDR, genre, decade breakdowns).
- **Image backfill**: after sync, queue items missing poster images for processing through the image pipeline using `tmdb_id`.

### Cross-Reference with Watching Domain

Physical media items are cross-referenced with the watching domain using `tmdb_id` as the join key. This enables:

- "Movies you own and have watched" -- physical media with matching watch history entries
- "Movies you own but have not watched" -- physical media with no watch history
- Watch rate: percentage of owned physical media that has been watched at least once

### Supported Media Metadata

| Field          | Values                                          | Description                 |
| -------------- | ----------------------------------------------- | --------------------------- |
| format         | bluray, 4k_uhd, hddvd                           | Physical disc format        |
| resolution     | hd_720p, hd_1080p, uhd_4k                       | Video resolution            |
| hdr            | dolby_vision, hdr10, hdr10_plus, hlg, none      | HDR format                  |
| audio          | dolby_atmos, dolby_digital, dts_x, dts_hd, lpcm | Audio codec                 |
| audio_channels | 2.0, 5.1, 7.1                                   | Audio channel configuration |
| media_type     | movie                                           | Currently movies only       |

### Environment Variables

| Variable            | Description                            |
| ------------------- | -------------------------------------- |
| TRAKT_CLIENT_ID     | Trakt OAuth2 application client ID     |
| TRAKT_CLIENT_SECRET | Trakt OAuth2 application client secret |

### Setup

Initial Trakt authentication uses the OAuth2 device code flow via `scripts/tools/setup-trakt.ts`. The script:

1. Requests a device code from `POST /oauth/device/code`
2. Displays the user code and verification URL (`https://trakt.tv/activate`)
3. Polls `POST /oauth/device/token` until the user authorizes the app
4. Stores the access and refresh tokens in the `trakt_tokens` table

Run: `npx tsx scripts/tools/setup-trakt.ts`

Tokens are automatically refreshed during sync when the access token expires.

## Known Issues

- Discogs rate limit (60/min) means large collections take multiple minutes to sync
- Image downloads capped at 1,000/day per application -- use Cover Art Archive for album art instead
- Discogs TOS restricts caching content > 6 hours -- use CCA/iTunes for images, Discogs for metadata only
- Release images from Discogs require authentication to access
- Some releases have multiple artists (compilations, splits)
- Collection value is an estimate based on marketplace median
- Cross-reference matching is imperfect for name variations ("The Beatles" vs "Beatles, The")
- Discogs does not support webhooks -- must poll on schedule
