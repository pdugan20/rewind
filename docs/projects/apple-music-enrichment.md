# Apple Music Enrichment

Enrich listening data with Apple Music deep links and 30-second preview audio via the iTunes Search API, enabling clickable artist/album/track links and future preview playback on `/listening`.

## Context

The `/listening` page displays top artists, albums, and tracks from Rewind, but links fall back to Apple Music search URLs. This project adds direct Apple Music URLs and preview audio by enriching existing artist/album/track records with data from the iTunes Search API.

Related: [pat-portfolio#24](https://github.com/pdugan20/pat-portfolio/issues/24)

## Existing Infrastructure

Code that already exists and will be reused:

- **Name matching utilities** (`src/services/images/sources/utils.ts`): `artistMatches()`, `albumMatches()`, `cleanArtistName()` — word-boundary prefix matching with "the" stripping and feat. cleanup. Battle-tested during image pipeline validation (caught 43% mismatch rate on iTunes album art, now resolved).
- **iTunes Search API client** (`src/services/images/sources/itunes.ts`): Already calls the same API (`itunes.apple.com/search`) for album art with `entity=album`. The enrichment service uses `entity=song` instead, but URL construction, rate limiting patterns, and response parsing are similar.
- **Apple Music API client** (`src/services/images/sources/apple-music.ts`): Uses the Apple Music catalog search API with JWT auth. Available as a secondary enrichment source if iTunes Search doesn't find a match.

## iTunes Search API

```text
GET https://itunes.apple.com/search
```

**Key params:**

| Param    | Type   | Description                                  |
| -------- | ------ | -------------------------------------------- |
| `term`   | string | Search query (artist name, track name, etc.) |
| `entity` | string | `musicArtist`, `album`, `song`               |
| `limit`  | number | Max results (default 50)                     |
| `media`  | string | `music` (filter to music only)               |

No authentication required. Rate limit ~20 requests/minute per IP (soft limit).

### Song lookup response (key fields)

A single `entity=song` lookup returns URLs for all three entity levels:

```json
{
  "trackId": 1440853776,
  "trackName": "Imagine",
  "trackViewUrl": "https://music.apple.com/us/album/imagine/...",
  "artistId": 136975,
  "artistName": "John Lennon",
  "artistViewUrl": "https://music.apple.com/us/artist/john-lennon/136975",
  "collectionId": 1440853474,
  "collectionName": "Imagine",
  "collectionViewUrl": "https://music.apple.com/us/album/imagine/1440853474",
  "previewUrl": "https://audio-ssl.itunes.apple.com/...m4a"
}
```

A song lookup returns `artistViewUrl`, `collectionViewUrl`, and `trackViewUrl` in a single response. Enriching all three entity types from track-level lookups minimizes total API calls.

## Schema Changes

### New columns on `lastfm_artists` (`src/db/schema/lastfm.ts`)

| Column             | Type    | Description                      |
| ------------------ | ------- | -------------------------------- |
| `appleMusicId`     | integer | iTunes artist ID                 |
| `appleMusicUrl`    | text    | Apple Music artist page URL      |
| `itunesEnrichedAt` | text    | ISO timestamp of last enrichment |

### New columns on `lastfm_albums`

| Column             | Type    | Description                      |
| ------------------ | ------- | -------------------------------- |
| `appleMusicId`     | integer | iTunes collection ID             |
| `appleMusicUrl`    | text    | Apple Music album page URL       |
| `itunesEnrichedAt` | text    | ISO timestamp of last enrichment |

### New columns on `lastfm_tracks`

| Column             | Type    | Description                      |
| ------------------ | ------- | -------------------------------- |
| `appleMusicId`     | integer | iTunes track ID                  |
| `appleMusicUrl`    | text    | Apple Music track page URL       |
| `previewUrl`       | text    | 30-second M4A preview URL        |
| `itunesEnrichedAt` | text    | ISO timestamp of last enrichment |

All columns nullable. `itunesEnrichedAt` enables incremental backfill (`WHERE itunesEnrichedAt IS NULL`) and re-enrichment for stale URLs (`WHERE itunesEnrichedAt < threshold`).

## Enrichment Strategy

### Search and matching

For track-level lookups:

```text
term = "{cleanArtistName(artistName)} {trackName}"
entity = song
limit = 5
media = music
```

Validate results using existing `artistMatches()` from `src/services/images/sources/utils.ts`. From the first valid match, extract and store:

- **Track**: `trackId`, `trackViewUrl`, `previewUrl`
- **Album**: `collectionId`, `collectionViewUrl` (only if album record exists in DB)
- **Artist**: `artistId`, `artistViewUrl` (only update if not already enriched)

### Rate limiting

- 2-second delay between calls (~30 req/min, under the soft limit)
- Back off to 5 seconds on 403 response
- Throughput: ~1,800 lookups/hour

### Backfill scope

Current unfiltered entity counts:

| Entity  | Count  |
| ------- | ------ |
| Tracks  | 25,216 |
| Albums  | 8,696  |
| Artists | 4,397  |

At ~1,800 tracks/hour, full backfill takes ~14 hours. Albums and artists are enriched passively through track lookups, so no separate pass needed.

### Priority order

1. Tracks with highest playcount (most likely to be seen on portfolio)
2. Tracks belonging to top-list artists
3. Remaining tracks by playcount descending

## API Response Changes

Add `apple_music_url` to artist, album, and track objects. Add `preview_url` to track objects. Fields are `null` when not yet enriched.

Endpoints to update:

- `/v1/listening/top/artists` — add `apple_music_url`
- `/v1/listening/top/albums` — add `apple_music_url`
- `/v1/listening/top/tracks` — add `apple_music_url`, `preview_url`
- `/v1/listening/year/{year}` — add URLs to top lists
- `/v1/listening/artists/{id}` — add `apple_music_url`
- `/v1/listening/albums/{id}` — add `apple_music_url`

## Task Tracker

### Phase 1: Schema and Enrichment Service

- [ ] **1.1** Generate Drizzle migration adding `apple_music_id`, `apple_music_url`, `itunes_enriched_at` to `lastfm_artists`
- [ ] **1.2** Add same columns to `lastfm_albums` (plus migration)
- [ ] **1.3** Add same columns plus `preview_url` to `lastfm_tracks` (plus migration)
- [ ] **1.4** Update Drizzle schema in `src/db/schema/lastfm.ts` with new columns
- [ ] **1.5** Create `src/services/itunes/enrich.ts` — search by artist+track using iTunes Search API, validate with `artistMatches()`, extract URLs, update DB records for artist/album/track in one pass
- [ ] **1.6** Tests for enrichment logic (valid match, no match, feat. artist handling, filtered track skip)

### Phase 2: Backfill

- [ ] **2.1** Create `backfillAppleMusicLinks()` — queries unenriched tracks by playcount DESC, calls enrichment service with rate limiting
- [ ] **2.2** Add admin endpoint: `POST /v1/admin/listening/enrich-apple-music` with `limit` param
- [ ] **2.3** Create `scripts/backfill-apple-music.sh` — loops the admin endpoint like the image backfill scripts
- [ ] **2.4** Run initial backfill, monitor hit rate
- [ ] **2.5** Verify enrichment coverage on top artists/albums/tracks

### Phase 3: Sync Integration

- [ ] **3.1** After upserting a new track in `syncRecentScrobbles()`, enrich if `itunesEnrichedAt IS NULL`
- [ ] **3.2** Skip enrichment during scrobble sync if approaching rate limit, defer to next cycle
- [ ] **3.3** Add enrichment stats to sync run tracking

### Phase 4: API Response Updates

- [ ] **4.1** Add `apple_music_url` to top artist/album/track responses
- [ ] **4.2** Add `apple_music_url` and `preview_url` to year-in-review top lists
- [ ] **4.3** Add `apple_music_url` to artist and album detail endpoints
- [ ] **4.4** Update OpenAPI schemas and snapshot

### Phase 5: Documentation

- [ ] **5.1** Update `docs/domains/listening.md` with enrichment details
- [ ] **5.2** Update `docs/ARCHITECTURE.md` with enrichment pipeline
- [ ] **5.3** Update CLAUDE.md if schema structure section changes
