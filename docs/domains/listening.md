# Listening Domain

Last.fm scrobble data (123,769+ scrobbles since 2012), top artists/albums/tracks by period, content filtering for audiobooks and holiday music. Apple Music API used for high-res artist images.

## Data Sources

- Last.fm (primary) -- scrobbles, top lists, user stats. Username: pdugan20
- Apple Music -- artist images, high-res album art (user has Apple Developer account)
- Cover Art Archive -- primary album art source (via MusicBrainz MBID)
- iTunes Search API -- fallback album art

## Last.fm API

- Base URL: `https://ws.audioscrobbler.com/2.0/`
- Auth: api_key query parameter (read-only, no OAuth)
- Rate limit: 5 requests/second
- Format: JSON (`format=json`)
- Pagination: `limit` (max 200) + `page`
- Time periods: `7day`, `1month`, `3month`, `6month`, `12month`, `overall`

### Key Methods

| Method | Description | Key Params |
| ------ | ----------- | ---------- |
| user.getRecentTracks | Recent scrobbles, includes nowplaying flag | user, limit, page, from, to |
| user.getTopArtists | Top artists by period | user, period, limit, page |
| user.getTopAlbums | Top albums by period | user, period, limit, page |
| user.getTopTracks | Top tracks by period | user, period, limit, page |
| user.getInfo | Total scrobbles, registration date | user |
| artist.getInfo | Artist details, tags, bio | artist, mbid |
| album.getInfo | Album details, tracks | artist, album, mbid |

Note: Artist images deprecated since ~2020. All artist image URLs return placeholder stars.

## Apple Music API

- Base URL: `https://api.music.apple.com/v1/`
- Auth: `Authorization: Bearer {developer_token}` (JWT signed with MusicKit private key)
- Rate limit: Generous, undocumented
- Used for: Artist images, high-res album art (up to 3000x3000)
- Artwork URL template: replace `{w}x{h}` with desired dimensions

### Key Endpoints

- `GET /v1/catalog/{storefront}/search?types=artists&term=...`
- `GET /v1/catalog/{storefront}/artists/{id}`

## iTunes Search API

- Base URL: `https://itunes.apple.com/search`
- Auth: None
- Rate limit: ~20/minute
- Used for: Album art fallback when Cover Art Archive has no match
- Key endpoint: `GET /search?term={artist}+{album}&media=music&entity=album&limit=1`
- Image URL: `artworkUrl100` field, replace `100x100` with desired size (e.g., `600x600`, `3000x3000`)

## Sync Strategy

- **Recent scrobbles**: every 15 minutes via cron. Fetch `user.getRecentTracks` with `from={last_scrobble_timestamp}`. Insert new scrobbles, upsert artists/albums/tracks.
- **Top lists**: daily at 3 AM. Fetch all 6 periods for artists, albums, tracks. Delete old rankings, insert new.
- **User stats**: daily at 3 AM alongside top lists. Call `user.getInfo` for total scrobbles. Compute unique counts from local DB.
- **Full historical backfill**: one-time. Paginate through all `user.getRecentTracks` from oldest to newest. ~124K scrobbles / 200 per page / 5 per second = ~2 minutes.
- **Incremental marker**: store last scrobble timestamp in `sync_runs` metadata.

## Content Filtering

Migrated from pat-portfolio's `lib/listening/filters.ts`. Stored in `lastfm_filters` table for dynamic management.

### Holiday Music Patterns

Album patterns (substring match):

- "charlie brown christmas"
- "merry christmas"
- "white christmas"
- "christmas album"
- "holiday"
- "christmas songs"

Track patterns (substring match):

- "jingle bell"
- "silent night"
- "santa claus"
- "deck the hall"
- "rudolph"
- "frosty the snowman"
- "winter wonderland"
- "o holy night"
- "little drummer boy"
- "away in a manger"
- "hark the herald"
- "o come all ye faithful"
- "we wish you a merry"
- "sleigh ride"
- "silver bells"
- "blue christmas"
- "last christmas"
- "christmas time"
- "holly jolly"
- "joy to the world"

Artist-scoped exact matches:

- "skating" (Vince Guaraldi)
- "greensleeves" (Vince Guaraldi)
- "linus and lucy" (Vince Guaraldi)

### Audiobook Detection

- Artist list: Stephen King, Thomas Pynchon, Hunter S. Thompson, Andy Weir, etc.
- Track patterns: `libby--open-` (Libby app tracks)
- Regex patterns: `- Part \d+`, `- Track \d+`, `- \d{2,3}$`, trailing ` (\d+)`

### Filtering Strategy

Over-fetch 30 items from top lists, filter out matches, re-rank remaining, return top 10.

## Endpoints

All endpoints require `Authorization: Bearer rw_...` header.

| Method | Path | Description | Cache | Query Params |
| ------ | ---- | ----------- | ----- | ------------ |
| GET | /v1/listening/now-playing | Current or last played track | no-store | none |
| GET | /v1/listening/recent | Recent scrobbles | 60s | limit (default 10, max 50) |
| GET | /v1/listening/top/artists | Top artists by period | 3600s | period, limit (default 10), page |
| GET | /v1/listening/top/albums | Top albums by period with art | 3600s | period, limit (default 10), page |
| GET | /v1/listening/top/tracks | Top tracks by period | 3600s | period, limit (default 10), page |
| GET | /v1/listening/stats | Overall listening statistics | 3600s | none |
| GET | /v1/listening/history | Full scrobble history | 3600s | from, to, artist, album, limit, page |
| GET | /v1/listening/artists/:id | Single artist detail | 3600s | none |
| GET | /v1/listening/albums/:id | Single album detail | 3600s | none |
| GET | /v1/listening/calendar | Daily scrobble counts | 3600s (current), 86400s (past) | year (default current) |
| GET | /v1/listening/trends | Listening trends over time | 86400s | metric, from, to |
| GET | /v1/listening/streaks | Current/longest listening streaks | 3600s | none |

## Streaks

Listening streaks track consecutive days with at least one scrobble. The streaks endpoint returns both the current streak and the longest streak on record.

- **Current streak**: The number of consecutive days (ending today or yesterday) that have at least one scrobble. Resets to zero if the user misses a full calendar day.
- **Longest streak**: The longest consecutive-day run of scrobbles across the entire listening history.
- Both streaks are computed from scrobble timestamps in the `lastfm_scrobbles` table, grouping by calendar date (UTC).

## Response Types

```typescript
interface NowPlayingResponse {
  is_playing: boolean;
  track: {
    name: string;
    artist: { id: number; name: string };
    album: { id: number; name: string; image_url: string | null; thumbhash: string | null };
    url: string;
  } | null;
  scrobbled_at: string | null;
}

interface TopItem {
  rank: number;
  id: number;
  name: string;
  detail: string;
  playcount: number;
  image_url: string | null;
  thumbhash: string | null;
  url: string;
}

interface TopListResponse {
  period: string;
  data: TopItem[];
  pagination: Pagination;
}

interface ListeningStats {
  total_scrobbles: number;
  unique_artists: number;
  unique_albums: number;
  unique_tracks: number;
  registered_date: string;
  years_tracking: number;
  scrobbles_per_day: number;
}

interface CalendarDay {
  date: string;
  count: number;
}

interface CalendarResponse {
  year: number;
  days: CalendarDay[];
  total: number;
  max_day: { date: string; count: number };
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

interface ListeningStreaks {
  current: { days: number; start_date: string; total_scrobbles: number };
  longest: { days: number; start_date: string; end_date: string; total_scrobbles: number };
}
```

All tables include `user_id` for multi-user support (default 1).

## Environment Variables

| Variable | Description |
| -------- | ----------- |
| LASTFM_API_KEY | Last.fm API key (read-only) |
| LASTFM_USERNAME | Last.fm username (pdugan20) |
| APPLE_MUSIC_DEVELOPER_TOKEN | Apple Music JWT (regenerate every 6 months) |

## Migration from pat-portfolio

- Currently pat-portfolio has `lib/listening/lastfm.ts` calling Last.fm API directly
- Route handlers in `app/api/listening/` proxy to Last.fm with 1hr cache
- Content filtering in `lib/listening/filters.ts`
- Rewind replaces all of this: pat-portfolio will call `api.rewind.rest` instead
- All filtering moves server-side into rewind's sync layer
- All image handling moves to rewind's image pipeline
- Phase 7 covers the actual migration

## Known Issues

- Last.fm artist images are broken (placeholder stars since ~2020)
- Last.fm album art is inconsistent -- some albums have art, many don't
- MBIDs are not always present on scrobble data -- fuzzy matching needed for image lookups
- Rate limit of 5/sec is per API key, not per IP
- `user.getRecentTracks` returns max 200 per page
- Scrobble timestamps are UTC
