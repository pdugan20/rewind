# Album attribution repair

## Background

The portfolio "Lately" card on patdugan.me shows a music-note placeholder instead
of album art for the last-played track ("Porch" by Pearl Jam, MTV Unplugged).
Investigation showed this is a surface symptom of a deeper data-integrity issue:
**1,541 `lastfm_tracks` rows point at an album whose `artist_id` belongs to a
different artist.**

## Root cause

Two compounding bugs.

### 1. Over-eager cross-artist album merge

Migration `0018_compilation_album_dedup.sql` merged any album name appearing
under **3 or more distinct artists** into the lowest-id album row, deleted the
losers, reparented tracks, summed playcounts into the winner, and flagged the
winner `is_compilation = 1`. The intent was to consolidate true compilations
(soundtracks, NOW-style comps); the implementation also consolidated common
album titles that are not compilations:

- "Greatest Hits" (album 53, attributed to Aerosmith, holds tracks from 48
  distinct artists — Tom Petty, Louis Armstrong, Ramones, Hendrix, CCR, …)
- "MTV Unplugged" (album 118, attributed to Bob Dylan, holds Pearl Jam tracks)
- "Live", "Demos", "Self-Titled" — same shape

`src/services/lastfm/sync.ts:92-101` perpetuates the merge for new scrobbles
via a `compilation_fallback` lookup, so the corruption is ongoing — 17
scrobbles in May 2026 alone landed under a wrong-artist album row.

### 2. Fragile now-playing lookup

`src/routes/listening.ts:1712-1727` resolves the live now-playing track's album
via `WHERE name = X AND artist_id = Y`. When `Y` doesn't match the (corrupted)
album row's artist_id, the handler returns `album.image: null` — the Lately
card has no image to render.

The `/recent` endpoint dodges this by joining through `lastfm_tracks.album_id`
directly, which is why the same track returns a (Bob Dylan's) album image
there. Bug #1 still causes wrong art everywhere — just less visibly.

## Target end state

**Album identity is `(name, artist_id)`, strictly.** Two different artists
with "Greatest Hits" or "MTV Unplugged" are two album rows. Real compilations
are albums whose `artist_id` points at a canonical **"Various Artists"** artist
row (Last.fm/MusicBrainz MBID `89ad4ac3-39f7-470e-963a-56509c546377`) — the
same model the upstream sources use.

`is_compilation` becomes derivable from a join and gets dropped.

Sync's `upsertAlbum` never merges across artists; it relies on the existing
`uniqueIndex('idx_lastfm_albums_unique').on(name, artistId)` for identity.

## Blast radius (baselined 2026-05-28)

| Metric                                                | Count |
| ----------------------------------------------------- | ----- |
| Tracks where `track.artist_id != album.artist_id`     | 1,541 |
| Albums flagged `is_compilation = 1`                   | 128   |
| Scrobbles affected (May 2026 alone)                   | 17    |
| Distinct artists pointing at album 53 "Greatest Hits" | 48    |

Downstream effects:

- **Wrong art** on Pearl Jam scrobbles (shows Bob Dylan's MTV Unplugged art via
  `/recent`, top-tracks, search, year-in-review).
- **Search misses** — migration 0018 deleted `search_index` rows for losers.
- **Playcount inflation** — migration 0018 summed loser playcounts into
  winners; album 53's count is the merged Greatest-Hits total across every
  artist scrobbled.
- **Now-playing returns `null`** image when the track artist doesn't match the
  (corrupted) album row's artist.

## Decisions locked in

| Decision                         | Choice                                                                                                                                                                                                      | Rationale                                                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compilation representation       | Dedicated "Various Artists" artist row (drop `is_compilation` flag)                                                                                                                                         | Matches MusicBrainz / Spotify / Apple Music model; one source of truth on the row; no flag drift                                                                                                       |
| Phase 3 split heuristic          | Dominant-artist split: if any single artist owns ≥ 50% of tracks on a compilation-flagged album, split out per-artist rows; if ≥ 4 distinct artists remain with sparse counts, keep a Various-Artists shell | Errs toward correctness for common-name collisions while preserving real soundtrack/comp grouping                                                                                                      |
| Album-artist signal at sync time | Default to track artist; do NOT call extra `track.getInfo` per scrobble (rate-limit cost)                                                                                                                   | `user.getRecentTracks` does not expose `album.artist`. Acceptable to attribute album to the track artist by default; comp grouping happens only for known Various-Artists MBIDs or explicit enrichment |
| Migration safety                 | Full DB backup before Phase 3; idempotent design with `_split_audit` table recording every action                                                                                                           | Phase 3 is the only step that's hard to reverse                                                                                                                                                        |

## Phase plan

Phases are ordered so each one is independently mergeable and makes the next
one safer.

| #   | Phase                 | Outcome                                                                                                                                                           | Reversibility                    |
| --- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 0   | Discovery             | This document, baseline counts, blast-radius queries                                                                                                              | N/A                              |
| 1   | Stop the bleeding     | Sync stops creating new corruption; now-playing handler fixed; sync-health invariant added                                                                        | Trivial rollback                 |
| 2   | Strict album identity | Canonical Various-Artists row inserted; `upsertAlbum` matches on `(name, artist_id)` only                                                                         | Rollback by re-enabling fallback |
| 3   | Repair migration      | 128 compilation-flagged albums classified and split per dominant-artist rule; per-artist rows minted; tracks repointed; `_split_audit` table records every action | Hard — needs DB backup           |
| 4   | Art backfill          | New album rows have cover art via existing `processListeningImages()` pipeline                                                                                    | Additive                         |
| 5   | Rebuild derived data  | Playcounts recomputed from scrobbles; `lastfm_top_albums` cron-rebuilt; `search_index` reindexed for listening domain                                             | Recompute from source            |
| 6   | Invariants + cleanup  | `upsertAlbum` test added; sync-health alarm wired; `is_compilation` column dropped                                                                                | N/A                              |

## Out of scope

- Discogs / physical-media collection has its own album/release model — not
  affected by this bug and not touched here.
- Plex/Letterboxd watch tables share the `images` polymorphic pattern but
  aren't part of the Last.fm corruption chain.
- Apple Music enrichment continues running unchanged on top of the corrected
  album rows.

## Open questions

None at kickoff. Any new questions surfaced during a phase get logged in
`TRACKER.md` under that phase.

## Related code paths

- `src/services/lastfm/sync.ts` — `upsertArtist`, `upsertAlbum`, `upsertTrack`
- `src/services/lastfm/transforms.ts` — `normalizeScrobble`
- `src/services/lastfm/client.ts` — Last.fm API surface (`LastfmRecentTrack`)
- `src/routes/listening.ts:1681-1791` — now-playing handler
- `src/routes/listening.ts:1794-1865` — recent handler (reference impl)
- `src/services/images/sync-images.ts` — `processListeningImages()`
- `src/routes/admin-reindex.ts` — search_index rebuild
- `src/lib/after-sync.ts` — per-sync search_index/feed writes
- `src/db/schema/lastfm.ts` — `lastfmAlbums`, `lastfmArtists`, `lastfmTracks`
- `migrations/0018_compilation_album_dedup.sql` — original buggy migration
