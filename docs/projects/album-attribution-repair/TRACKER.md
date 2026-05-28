# Tracker

## Pre-flight — decisions locked

- [x] Compilation representation: dedicated "Various Artists" artist row;
      `is_compilation` column will be dropped after Phase 6.
- [x] Phase 3 split heuristic: dominant-artist (≥ 50% ownership) split with
      Various-Artists shell preserved for true comps (4+ artists, sparse).
- [x] Album-artist signal: default to track artist at sync time. No extra
      `track.getInfo` calls per scrobble.
- [x] Phase 3 safety: full DB backup before run; `_split_audit` table records
      every action; idempotent re-run by checking the audit table.
- [x] Deploy strategy: ship phases as separate PRs to `main`, one at a time.

## Phase 0 — Discovery ✅

- [x] Reproduced symptom: `/v1/listening/now-playing` returns `album.image:
null` for Porch by Pearl Jam while `/recent` returns Bob Dylan's MTV
      Unplugged art for the same track.
- [x] Identified Bug 1: `migrations/0018_compilation_album_dedup.sql` merged
      same-named albums under 3+ distinct artists, flagged winners
      `is_compilation = 1`.
- [x] Identified Bug 2: `src/routes/listening.ts:1712-1727` looks up album by
      `(name, artist_id)`, fails when the row was merged under a different
      artist.
- [x] Confirmed `is_compilation` is read in exactly one place
      (`src/services/lastfm/sync.ts:96`).
- [x] Confirmed `upsertTrack` (sync.ts:137-149) overwrites `album_id` on every
      scrobble — so Phase 3 repairs would be re-corrupted unless Phase 2 ships
      first. Dependency ordered correctly.
- [x] Baselined blast radius (2026-05-28):
      1,541 mismatched tracks · 128 compilation albums · 17 affected scrobbles
      in May 2026 · 48 distinct artists on album 53 "Greatest Hits".
- [x] Created `docs/projects/album-attribution-repair/{README,TRACKER}.md`.

## Phase 1 — Stop the bleeding

User-visible: now-playing card stops returning `null` image. New corruption
stops.

- [x] **Fix now-playing handler** (`src/routes/listening.ts:1681-1791`)
  - [x] Look up the track via `(name, artist_id)` first
  - [x] If track found and has `album_id`, join through to `lastfm_albums` for
        album name + image (matches `/recent` shape)
  - [x] Fall back to Last.fm's `album['#text']` for name-only when no track row
        exists yet
  - [x] Keep current artist + track Apple Music URL lookups unchanged
- [x] **Disable compilation fallback** in `src/services/lastfm/sync.ts:92-101`
  - [x] Remove the fallback block entirely; rely on the strict
        `(name, artist_id)` match plus row creation
  - [x] Add a comment pointing at this doc for context
- [x] **Sync-health invariant counter**
  - [x] In `src/routes/system.ts`, extend `GET /v1/health/sync` to include
        `lastfm_album_artist_mismatch_count` from the same query we ran in
        Phase 0
  - [x] Counter should drop to 0 after Phase 3 + Phase 6 land
- [x] Tests
  - [x] `upsertAlbum` test: same name under two artists creates two rows
        (also covers compilation-flagged existing row case)
  - [ ] now-playing handler test: deferred — needs Last.fm client mock; the
        e2e schema test already covers the response shape and the
        `upsertAlbum` tests cover the underlying identity invariant
- [x] `npx tsc --noEmit` clean
- [x] `npm test` green (1002 tests)
- [ ] PR + deploy + verify Lately card on patdugan.me renders Pearl Jam's
      Porch with album art (even if it's still Bob Dylan's art — that's
      Phase 3's job)

## Phase 2 — Strict album identity

Schema-level fix: introduce Various Artists row, lock identity to
`(name, artist_id)`.

- [ ] **Various Artists artist row**
  - [ ] Migration: insert into `lastfm_artists` with
        `mbid = '89ad4ac3-39f7-470e-963a-56509c546377'`, name `'Various Artists'`,
        `is_filtered = 0`
  - [ ] Export `VARIOUS_ARTISTS_ID` constant from `src/services/lastfm/sync.ts`
        or a new `src/services/lastfm/constants.ts`
- [ ] **`upsertAlbum` becomes strict**
  - [ ] Remove all fallbacks; only match on `(name, artist_id)`
  - [ ] If miss: insert new row
  - [ ] Keep `is_compilation` column writes off (column stays for read-side
        compat until Phase 6)
- [ ] **Optional: detect Various-Artists scrobbles at sync time**
  - [ ] If Last.fm payload's track MBID hits a known Various Artists release
        (best-effort), or if `artist['#text'] === 'Various Artists'`, point
        the album row at `VARIOUS_ARTISTS_ID` instead of the track artist
  - [ ] Defer to a follow-up if cost/complexity is high — Phase 3 will catch
        the existing cases anyway
- [ ] Tests
  - [ ] Strict-identity test: two artists with same album name → two rows
  - [ ] Various Artists row exists post-migration
- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` green
- [ ] PR + deploy

## Phase 3 — Repair migration

The only hard-to-reverse step. Run dry first; full DB backup before live run.

- [ ] **`_split_audit` table** (lives in production for at least 30 days post-run)
  - [ ] Columns: `winner_album_id`, `album_name`, `track_artist_id`,
        `new_album_id`, `tracks_moved`, `action`
        (`split_per_artist` | `keep_as_various_artists` | `skip_legit_comp`),
        `created_at`
- [ ] **Repair script** at `scripts/backfills/repair-album-attribution.ts`
  - [ ] Dry-run mode (default): outputs CSV of planned actions, no writes
  - [ ] For each `lastfm_albums` row with `is_compilation = 1`:
    - [ ] Group its tracks by `track.artist_id`
    - [ ] Compute share = `tracks_for_artist / total_tracks_on_album`
    - [ ] Classify: - dominant artist (share ≥ 0.50): `split_per_artist` — mint new
          `(name, that_artist_id)` row, copy `mbid`, `url`,
          re-derive `playcount` from scrobble count, repoint that artist's
          tracks to the new row - remaining sparse artists (< 0.50 share, ≥ 4 distinct on the
          album): leave their tracks pointing at the winner row, but
          re-attribute the winner row's `artist_id` to
          `VARIOUS_ARTISTS_ID` and re-derive its playcount - all artists below 0.50, only 2-3 distinct: split all to per-artist
          rows; delete the now-orphaned winner row
    - [ ] Emit `_split_audit` rows for every action
  - [ ] Live-run mode (`--apply`): writes to DB inside one D1 batch per album
- [ ] **Dry-run review**
  - [ ] Generate dry-run CSV
  - [ ] Manually spot-check 10 albums (Pearl Jam MTV Unplugged, Aerosmith
        Greatest Hits, Pulp Fiction Soundtrack, Mamas & Papas "Gold",
        Tarantino comps, McCartney III Imagined, …)
  - [ ] Confirm classifications match intent
- [ ] **Backup**
  - [ ] Export prod D1 to a dated R2 snapshot
        (`d1-snapshots/rewind-db-<YYYY-MM-DD>-pre-repair.sql`)
  - [ ] Document restore steps in this tracker
- [ ] **Live run**
  - [ ] `npx tsx scripts/backfills/repair-album-attribution.ts --apply`
  - [ ] Verify post-run counts: mismatch count → 0, new album row count =
        number of `split_per_artist` actions
- [ ] PR with code + dated `_split_audit` snapshot summary

## Phase 4 — Art backfill for split rows

- [ ] Existing `processListeningImages()` in
      `src/services/images/sync-images.ts` will pick up new album rows missing
      `image_key` on the next daily cron — confirm by querying for unfilled
      art among the new IDs.
- [ ] If too slow (large batch), kick off explicitly via admin endpoint:
      `POST /v1/listening/admin/process-images?entityType=albums&limit=500`
- [ ] After 48h, query: split albums still missing art. Acceptable for some to
      remain placeholders; the bug is wrong-art, not missing-art.
- [ ] Spot-check on portfolio: Lately card shows the correct Pearl Jam
      MTV Unplugged cover.

## Phase 5 — Rebuild derived data

- [ ] **Playcounts on winner rows**
  - [ ] Already re-derived inside Phase 3 split logic — confirm none remain
        with the inflated migration-0018 totals
- [ ] **`lastfm_top_albums`**
  - [ ] Daily cron will rebuild from current playcounts; trigger an immediate
        run via `POST /v1/admin/sync` with `type: 'top_lists'` to avoid
        showing stale top-albums until next cron
- [ ] **`search_index`**
  - [ ] Trigger reindex: `POST /v1/admin/reindex` with
        `{ "domains": ["listening"] }`
  - [ ] Verify split albums searchable by `<artist> <album_name>`
- [ ] **`lastfm_monthly_stats` / `lastfm_yearly_stats`**
  - [ ] These count unique albums per period. Splits affect `uniqueAlbums`
        counts. Trigger recompute via the existing stats sync.

## Phase 6 — Invariants and cleanup

- [ ] **Tests**
  - [ ] `upsertAlbum` test (already added in Phase 1) confirmed green
  - [ ] Sync regression test: scrobble of "Pearl Jam · Porch · MTV Unplugged"
        creates a Pearl Jam-attributed album row, not a Bob Dylan one
- [ ] **Runtime invariant**
  - [ ] Add cron check in `src/index.ts`: nightly count of mismatched rows;
        log at `[WARN]` if non-zero
  - [ ] Optionally: page via Sentry alert at threshold > 10
- [ ] **Schema cleanup**
  - [ ] Migration: drop `lastfm_albums.is_compilation` column and the
        `idx_lastfm_albums_compilation` index
  - [ ] Remove the field from `src/db/schema/lastfm.ts`
  - [ ] Remove the comment reference in `src/routes/listening.ts:2831` (the
        listening-signal heuristic still applies but the comment becomes
        outdated)
- [ ] **Docs**
  - [ ] Add a one-line entry to `docs-mintlify/changelog.mdx`
  - [ ] Mark this project complete in `docs/projects/`

## Rollback / restore notes

- Phase 1 & 2: revert PRs; sync resumes pre-fix behavior (new corruption
  resumes but old data is untouched).
- Phase 3: restore from the dated R2 D1 snapshot. The `_split_audit` table
  records every action so a custom inverse migration is possible, but full
  restore is the simpler path.
- Phases 4-6: re-running is safe (additive / idempotent recompute).
