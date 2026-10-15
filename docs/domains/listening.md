# Listening Domain

For current endpoints and response fields, use the [public listening guide](../../docs-mintlify/domains/listening.mdx) and generated API reference. These notes retain integration decisions and historical operational context; source files remain authoritative.

Last.fm scrobble data + Apple Music listening history (138,885+ scrobbles since 2012), top artists/albums/tracks by period, content filtering for audiobooks and holiday music. Apple Music API used for high-res artist images and enrichment.

## Data Sources

- Last.fm (primary) -- scrobbles, top lists, user stats. Username: pdugan20
- Apple Music (one-time import) -- 8,595 scrobbles from Apple privacy data export (Play History Daily Tracks CSV). Merged into lastfm\_\* tables with full enrichment via iTunes batch ID lookup.
- Apple Music API -- artist images, high-res album art (user has Apple Developer account)
- iTunes Search/Lookup API -- track enrichment (apple_music_id, apple_music_url, preview_url, duration_ms), album art fallback
- Cover Art Archive -- primary album art source (via MusicBrainz MBID)

## Last.fm API

- Base URL: `https://ws.audioscrobbler.com/2.0/`
- Auth: api_key query parameter (read-only, no OAuth)
- Rate limit: 5 requests/second
- Format: JSON (`format=json`)
- Pagination: `limit` (max 200) + `page`
- Time periods: `7day`, `1month`, `3month`, `6month`, `12month`, `overall`

### Key Methods

| Method               | Description                                | Key Params                  |
| -------------------- | ------------------------------------------ | --------------------------- |
| user.getRecentTracks | Recent scrobbles, includes nowplaying flag | user, limit, page, from, to |
| user.getTopArtists   | Top artists by period                      | user, period, limit, page   |
| user.getTopAlbums    | Top albums by period                       | user, period, limit, page   |
| user.getTopTracks    | Top tracks by period                       | user, period, limit, page   |
| user.getInfo         | Total scrobbles, registration date         | user                        |
| artist.getTopTags    | Community tags for an artist               | artist                      |
| artist.getInfo       | Artist details, tags, bio                  | artist, mbid                |
| album.getInfo        | Album details, tracks                      | artist, album, mbid         |

Note: Artist images deprecated since ~2020. All artist image URLs return placeholder stars.

## Apple Music API

- Base URL: `https://api.music.apple.com/v1/`
- Auth: `Authorization: Bearer {developer_token}` (JWT signed with MusicKit private key)
- Rate limit: Generous, undocumented
- Used for: Artist images, high-res album art (up to 3000x3000), album release year and track count, album tracklists
- Artwork URL template: replace `{w}x{h}` with desired dimensions

### Key Endpoints

- `GET /v1/catalog/{storefront}/search?types=artists&term=...`
- `GET /v1/catalog/{storefront}/artists/{id}`
- `GET /v1/catalog/{storefront}/albums/{id}?include=tracks` -- tracklist in disc/track order with ISRC, duration, preview and song URL ([`tracklist.ts`](../../src/services/apple-music/tracklist.ts), stored in `lastfm_album_tracks`). When the stored album id names a different release (title or artist mismatch), sync looks the album up by name with the same confirmed album search as the album check, and stores the corrected id, URL and tracklist only when the result passes the same identity test; a failed lookup leaves the album to retry at the next sync

## iTunes Search/Lookup API

- Base URL: `https://itunes.apple.com/search` and `https://itunes.apple.com/lookup`
- Auth: None
- Rate limit: ~20/minute (soft); Apple answers with HTTP 403 or 429, which stops a batch until the next run
- Used for: Track enrichment (Apple Music IDs, URLs, preview audio, duration), album art fallback
- Key endpoints:
  - `GET /search?term={artist}+{track}&media=music&entity=song&limit=5` -- fuzzy search for enrichment
  - `GET /lookup?id={trackId1},{trackId2},...&entity=song` -- batch lookup by Apple Music track IDs (up to 200 per request)
- Lookup returns full metadata: trackId, artistId, collectionId, trackViewUrl, artistViewUrl, collectionViewUrl, previewUrl, trackTimeMillis
- Image URL: `artworkUrl100` field, replace `100x100` with desired size (e.g., `600x600`, `3000x3000`)
- **Various-artists records.** Last.fm reports only the track artist, so sync files a soundtrack song under a per-artist album ("Reservoir Dogs" by Harry Nilsson, by Stealers Wheel, …). Track enrichment cannot see this, because the song may already belong to the artist's own album and only the play records point at the soundtrack. So after each sync, [`enrichNewAlbums`](../../src/services/itunes/album-enrich.ts) checks up to 5 unchecked albums created since 2026-10-15 that have recorded plays. It looks up the played album in the Apple Music catalog with the developer token: an album search by name, confirmed by opening up to three matching candidates and finding the played song on the tracklist. The iTunes Search API rate-limits Cloudflare's shared egress (HTTP 429), so it is only the fallback when no token is configured; that path searches one played song with the album name in the term, then a plain search. When the matched album is credited to "Various Artists", every play recorded on it, and any track first seen there, moves to one album credited to the canonical Various Artists row, which takes the catalog id and is enrolled for disc-art discovery with its check queued, as a play would. When the match confirms the album under its own artist, it takes the catalog id. The album is then marked checked. Each filing writes a `FILE_UNDER_VARIOUS_ARTISTS` row to `lastfm_album_attribution_audit` (original album, new album, tracks moved, the iTunes match), and sync files later plays reported under that exact per-artist album there too. The rule is keyed on the album row, never on the title alone, because unrelated releases share titles such as _Greatest Hits_. Track enrichment leaves an album unlinked when its match is credited to Various Artists, so the album check sees it. Albums credited to another album artist (for example _Pure McCartney_, credited to Paul McCartney but holding Wings tracks) keep the track artist: only the Various Artists row may hold other artists' tracks ([album attribution repair](../projects/album-attribution-repair/README.md)). The emptied per-artist album row stays, with no plays.
- **Reviewing older albums.** Albums created before 2026-10-15 change only through `POST /v1/listening/admin/review-albums` (admin key), which runs the same check for up to 20 listed albums. It defaults to `dry_run: true`, which writes nothing and reports each album's searched song, match and action (`file_under_various_artists` with the target album and plays moved, `link_album`, `already_linked`, `no_album_match`, `no_match`, or `error` with the reason). Review that preview before repeating the request with `"dry_run": false`, which applies the same decisions.

## Sync Strategy

- **Recent scrobbles**: every 15 minutes via cron. Fetch `user.getRecentTracks` with `from={last_scrobble_timestamp}`. Insert new scrobbles, upsert artists/albums/tracks. New artists are automatically tagged with genres via `artist.getTopTags`.
- **Recent albums shelf**: after each 15-minute scrobble sync, [`refreshDiscman`](../../src/services/discman/refresh.ts) enriches up to 15 newest unenriched tracks (previews arrive within one sync instead of the daily batch), stores catalog tracklists for the shelf's albums when missing or 90 days stale, and publishes one row to `listening_discman_snapshots`. `GET /v1/listening/discman` serves that row. The shelf holds the 12 most recently played albums whose active CD artwork is accepted; albums without it (including each artist of a various-artists soundtrack, which Last.fm files separately) are skipped, so it can reach past newer listening. There is no time window; the scan stops after 20,000 scrobbles or once every album with art is found. Art accepted later appears at the next rebuild.
- **Top lists**: daily at 3 AM. Fetch all 6 periods for artists, albums, tracks. Delete old rankings, insert new.
- **User stats**: daily at 3 AM alongside top lists. Call `user.getInfo` for total scrobbles. Compute unique counts from local DB.
- **Full historical backfill**: one-time. Paginate through all `user.getRecentTracks` from oldest to newest. ~124K scrobbles / 200 per page / 5 per second = ~2 minutes.
- **Apple Music import**: one-time. Parse "Play History Daily Tracks" CSV from Apple privacy export. Batch resolve all track IDs via iTunes Lookup API (200 per request). Insert scrobbles with full enrichment (Apple Music IDs, URLs, preview audio, duration). Dedup against existing Last.fm scrobbles using artist+track+hour window.
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

## Genre Tags

Artist genre data is sourced from Last.fm's `artist.getTopTags` API (community-submitted tags). Raw tags are filtered through a curated allowlist in `src/services/lastfm/genres.ts` that normalizes synonyms (e.g., "hip hop", "Hip-Hop", "rap" all map to "Hip-Hop") and discards non-genre tags ("seen live", "female vocalists", etc.).

Each artist stores:

- `tags` (JSON) -- normalized tags with weights: `[{"name":"Rock","count":100},{"name":"Pop","count":14}]`
- `genre` (text) -- primary genre (highest-weighted allowlisted tag), indexed for fast queries

Genre data is populated automatically when new artists are discovered during scrobble sync. Coverage: ~93% of non-filtered artists have a genre assigned.

The `/listening/genres` endpoint joins scrobbles through tracks to artists, grouping by time period and genre. The `limit` param controls how many genres are shown before the rest are rolled up as "Other" -- ideal for stacked bar charts.

## Streaks

Listening streaks track consecutive days with at least one scrobble. The streaks endpoint returns both the current streak and the longest streak on record.

- **Current streak**: The number of consecutive days (ending today or yesterday) that have at least one scrobble. Resets to zero if the user misses a full calendar day.
- **Longest streak**: The longest consecutive-day run of scrobbles across the entire listening history.
- Both streaks are computed from scrobble timestamps in the `lastfm_scrobbles` table, grouping by calendar date (UTC).

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
