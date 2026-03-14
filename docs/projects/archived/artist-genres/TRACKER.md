# Artist Genre Tags -- Tracker

## Phase 1: Schema, Allowlist, and Client

Add the database columns, genre mapping constant, and Last.fm client method.

**1.1 -- Schema**

- [x] **1.1.1** Add `tags` (text, JSON) and `genre` (text) columns to `lastfmArtists` in `src/db/schema/lastfm.ts`
- [x] **1.1.2** Write migration manually (`migrations/0017_artist_genre_tags.sql`) -- drizzle-kit generate has pre-existing .js import issue
- [x] **1.1.3** Apply migration to remote D1

**1.2 -- Genre Allowlist**

- [x] **1.2.1** Create `src/services/lastfm/genres.ts` with `GENRE_MAP` constant and `resolveGenre()` function
- [x] **1.2.2** Unit tests for `resolveGenre()`: synonym normalization, junk filtering, empty input, deduplication (10 tests)

**1.3 -- Last.fm Client**

- [x] **1.3.1** Add `getArtistTopTags(artist: string)` method to `LastfmClient`
- [x] **1.3.2** Add `LastfmTag` interface export

**1.4 -- Verify**

- [x] **1.4.1** Run full test suite (478 passed), lint, typecheck -- all clean

## Phase 2: Backfill

Populate tags and genre for all existing artists.

**2.1 -- Backfill Function**

- [x] **2.1.1** Add `backfillArtistTags()` function to `src/services/lastfm/sync.ts` (batch processing, 500 per invocation, skip artists with existing tags)
- [x] **2.1.2** Wire into admin sync endpoint: `POST /v1/admin/sync/listening { type: "artist_tags" }`
- [x] **2.1.3** Return `{ tagged, remaining }` so caller knows when backfill is complete

**2.2 -- Backfill Script**

- [x] **2.2.1** Create `scripts/backfills/backfill-artist-tags.sh` that calls admin endpoint in a loop until `remaining: 0`
- [x] **2.2.2** Progress logging every batch

**2.3 -- Run Backfill**

- [x] **2.3.1** Deploy with backfill function
- [x] **2.3.2** Run `scripts/backfills/backfill-artist-tags.sh` against production -- 9 batches, ~4,382 artists processed
- [x] **2.3.3** Spot-checked: Beatles -> Classic Rock, Nirvana -> Grunge, A Tribe Called Quest -> Hip-Hop, Wilco -> Alt-Country, Taylor Swift -> Country
- [x] **2.3.4** Coverage: 4,076/4,382 (93%) artists have a genre. 306 artists had no usable tags from Last.fm (empty or all junk). 1 artist (+44) had URL encoding issue, set to empty tags.

**2.4 -- Allowlist Tuning**

- [x] **2.4.1** Queried unmatched tags -- all genre-less artists had empty tag arrays (Last.fm returned nothing). No missing genres in allowlist.
- ~~**2.4.2**~~ Not needed -- no allowlist gaps found.

## Phase 3: Sync Integration

Tag new artists automatically during scrobble sync.

**3.1 -- Inline Tagging**

- [x] **3.1.1** In `syncRecentScrobbles`, after `upsertArtist` returns `isNew: true`, call `getArtistTopTags` and populate `tags`/`genre`
- [x] **3.1.2** Wrapped in try/catch -- tagging failure is non-fatal

**3.2 -- Verify**

- [x] **3.2.1** Run full test suite (478 passed), lint, typecheck -- all clean

## Phase 4: Genre Endpoints

Expose genre data through the API.

**4.1 -- Genre Breakdown Endpoint**

- [x] **4.1.1** Define route schema for `GET /v1/listening/genres` with `from`, `to`, `date`, `group_by` (week/month/year), `limit` query params
- [x] **4.1.2** Implement handler: join scrobbles -> tracks -> artists, group by period + genre, roll up beyond limit as "Other"

**4.2 -- Genre on Artist Responses**

- [x] **4.2.1** Add `genre` and `tags` fields to artist detail endpoint (`/listening/artists/:id`)
- [x] **4.2.2** Add `genre` field to artist browse (`/listening/artists`) and top artists (`/listening/top/artists`) responses
- [x] **4.2.3** Update response schemas (`ArtistDetailSchema`, `ArtistBrowseSchema`, `NormalizedTagSchema`)

**4.3 -- Verify**

- [x] **4.3.1** Run full test suite (478 passed), lint, typecheck -- all clean
- [x] **4.3.2** Update OpenAPI snapshot

## Phase 5: Documentation, Cleanup, and Archive

**5.1 -- Documentation**

- [x] **5.1.1** Update `docs/domains/listening.md` -- genre tags section, genres endpoint, artist.getTopTags in API methods, sync strategy update
- [x] **5.1.2** No ARCHITECTURE.md changes needed (genre allowlist is domain-specific, not a cross-cutting convention)
- [x] **5.1.3** No CLAUDE.md changes needed (genres.ts follows existing patterns)

**5.2 -- Final Verification**

- [x] **5.2.1** Run full test suite (478 passed), lint, typecheck -- all clean
- [x] **5.2.2** Deploy to production (Cloudflare Workers)
- [x] **5.2.3** Smoke test: `/listening/genres?from=2025-01&to=2025-12&group_by=month` returns monthly genre breakdowns; `/listening/artists/91` returns genre: "Classic Rock" with tags array

**5.3 -- Archive**

- [x] **5.3.1** Move project to `docs/projects/archived/artist-genres/`
- [x] **5.3.2** Mark TRACKER.md tasks complete

## Deferred

- **Genre summary endpoint** (`/listening/genres/summary`): Aggregate genre stats for dashboard cards. Build when the frontend needs it.
- **Genre filtering on browse endpoints**: e.g., `/listening/artists?genre=Rock`. Add when needed.
- **Genre data in year-in-review**: Incorporate genre breakdown into the existing year-in-review response. Separate task after this project lands.
