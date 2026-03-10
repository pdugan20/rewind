# Collecting Domain

Physical vinyl and CD collection from Discogs with wantlist tracking and cross-reference to Last.fm listening data to show which records you own and listen to most.

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

| Method | Endpoint                                        | Description               | Key Params                       |
| ------ | ----------------------------------------------- | ------------------------- | -------------------------------- |
| GET    | /users/{username}/collection/folders/0/releases | All collection items      | page, per_page, sort, sort_order |
| GET    | /users/{username}/collection/folders            | Collection folders        | none                             |
| GET    | /users/{username}/wants                         | Wantlist items            | page, per_page                   |
| GET    | /releases/{id}                                  | Release detail            | none                             |
| GET    | /artists/{id}                                   | Artist detail             | none                             |
| GET    | /users/{username}/collection/value              | Collection value estimate | none                             |

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

| Method | Path                           | Description                          | Cache  | Query Params                                         |
| ------ | ------------------------------ | ------------------------------------ | ------ | ---------------------------------------------------- |
| GET    | /v1/collection                 | Full collection                      | 86400s | page, limit, format, genre, artist, sort, order, q   |
| GET    | /v1/collection/stats           | Collection statistics                | 86400s | none                                                 |
| GET    | /v1/collection/recent          | Recently added items                 | 3600s  | limit (default 5, max 20)                            |
| GET    | /v1/collection/:id             | Single release detail                | 86400s | none                                                 |
| GET    | /v1/collection/wantlist        | Wantlist items                       | 86400s | page, limit, sort, order                             |
| GET    | /v1/collection/formats         | Format breakdown                     | 86400s | none                                                 |
| GET    | /v1/collection/genres          | Genre breakdown                      | 86400s | none                                                 |
| GET    | /v1/collection/artists         | Top artists in collection            | 86400s | limit (default 20)                                   |
| GET    | /v1/collection/cross-reference | Collection matched to listening data | 86400s | sort (plays/added), filter (listened/unlistened/all) |

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

## Known Issues

- Discogs rate limit (60/min) means large collections take multiple minutes to sync
- Image downloads capped at 1,000/day per application -- use Cover Art Archive for album art instead
- Discogs TOS restricts caching content > 6 hours -- use CCA/iTunes for images, Discogs for metadata only
- Release images from Discogs require authentication to access
- Some releases have multiple artists (compilations, splits)
- Collection value is an estimate based on marketplace median
- Cross-reference matching is imperfect for name variations ("The Beatles" vs "Beatles, The")
- Discogs does not support webhooks -- must poll on schedule
