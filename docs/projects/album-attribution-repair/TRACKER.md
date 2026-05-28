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

- [x] **Various Artists artist row**
  - [x] Migration `0038_seed_various_artists.sql`: inserts canonical row
        with `mbid = '89ad4ac3-39f7-470e-963a-56509c546377'`, name
        `'Various Artists'`, `is_filtered = 0` (idempotent via
        `INSERT OR IGNORE`)
  - [x] `VARIOUS_ARTISTS_MBID` / `VARIOUS_ARTISTS_NAME` constants +
        `getVariousArtistsId(db)` helper in
        `src/services/lastfm/constants.ts`
- [x] **`upsertAlbum` is strict**
  - [x] Strictness landed in Phase 1 (compilation fallback removed); Phase 2
        retains the strict `(name, artist_id)` match plus row creation
  - [x] `is_compilation` writes remain off; the column stays for read-side
        compat until Phase 6
- [x] **MBID-first artist resolution**
  - [x] `upsertArtist` now prefers an MBID match when present, falling back
        to name match. Anchors the canonical Various Artists row even if a
        scrobble's display name drifts; benefits all artists generally
- [x] Tests
  - [x] Strict-identity test (Phase 1) confirmed green
  - [x] Various Artists row exists post-migration; resolves via
        `getVariousArtistsId`; name-only fallback works
  - [x] `upsertArtist` MBID-first lookup: drifted-name scrobble resolves
        to the canonical row without creating a duplicate
- [x] `npx tsc --noEmit` clean
- [x] `npm test` green (1006 tests)
- [ ] PR + deploy

## Phase 3 — Repair migration

The only hard-to-reverse step. Run dry first; full DB backup before live run.

- [x] **`lastfm_album_attribution_audit` table** (migration 0039;
      lives in production for at least 30 days post-run)
  - [x] Columns: `original_album_id`, `original_album_name`,
        `original_artist_id`, `action`
        (`KEEP_AS_VA` | `COLLAPSE_TO_PRIMARY` | `SPLIT_PER_ARTIST`),
        `new_album_id`, `new_artist_id`, `tracks_moved`, `notes`,
        `created_at`
- [x] **Repair module** at `src/services/lastfm/repair-attribution.ts`
  - [x] `planRepair(db)` loads comp-flagged albums + per-artist track
        shares and classifies each
  - [x] Refined classifier (cluster-count + comp-name regex + shape-comp
        signal): - 0 clusters + comp-named OR sparse-shape → `KEEP_AS_VA` - 0 clusters + no comp signal → `SPLIT_PER_ARTIST` (sparse anomaly) - 1 cluster → `COLLAPSE_TO_PRIMARY` - ≥ 2 clusters + comp-named → `KEEP_AS_VA` (preserve group) - ≥ 2 clusters + not comp-named → `SPLIT_PER_ARTIST` (name collision)
  - [x] `applyRepair(db)` executes: - **KEEP_AS_VA**: re-attribute album.artist_id → Various Artists;
        recompute playcount; tracks already point at this row - **COLLAPSE_TO_PRIMARY**: mint per-artist row for the primary
        artist (or reuse the original if album_artist matches),
        repoint tracks, inherit the image, delete the original row
        when it becomes empty - **SPLIT_PER_ARTIST**: per artist on the album, mint a row,
        repoint that artist's tracks. The album_artist's split keeps
        the original row + image; other splits get fresh rows; their
        art is deferred to Phase 4
  - [x] Audit row for every action
  - [x] Idempotent (tests cover re-run safety)
- [x] **Admin endpoint** `POST /v1/admin/repair-album-attribution`
  - [x] Default mode returns JSON summary; `Accept: text/csv` returns
        the dry-run CSV
  - [x] `?apply=true` executes the plan
- [x] **Dry-run CSV** committed at
      `docs/projects/album-attribution-repair/dry-run-2026-05-28.csv`
- [x] **Classifier review** (action distribution: 60 KEEP_AS_VA / 28
      COLLAPSE_TO_PRIMARY / 40 SPLIT_PER_ARTIST)
- [ ] **Backup**
  - [ ] Export prod D1 to a dated R2 snapshot
        (`d1-snapshots/rewind-db-2026-05-28-pre-repair.sql`)
  - [ ] Document restore steps in this tracker
- [ ] **Live run**
  - [ ] `curl -X POST 'https://api.rewind.rest/v1/admin/repair-album-attribution?apply=true'`
  - [ ] Verify post-run: `integrity.lastfm_album_artist_mismatch_count`
        drops sharply (feature-credit residue may remain — tracked
        separately)
- [x] PR (code + tests + dry-run CSV) opened

## Phase 4 — Art backfill for split rows

Operational; no new code. The Phase 3 apply creates new album rows
without `image_key`; the existing image pipeline fills them in.

- [ ] After Phase 3 applies, immediately trigger the admin backfill:
      `curl -X POST -H "Authorization: Bearer rw_..." -H "Content-Type: application/json" \`
      `-d '{"type":"albums","limit":200}' https://api.rewind.rest/v1/listening/admin/backfill-images`
      Re-run until `succeeded + skipped` covers all new rows
      (or wait for the daily `0 3` cron to drain the queue).
- [ ] After 48 h, query albums still missing art. Acceptable for some to
      remain placeholders; the bug is wrong-art, not missing-art.
- [ ] Spot-check on portfolio: Lately card shows the correct Pearl Jam
      MTV Unplugged cover.

## Phase 5 — Rebuild derived data

Operational; no new code. Playcounts are recomputed by Phase 3 apply.
The remaining derived data is regenerated via existing admin endpoints
and the daily cron.

- [ ] **`lastfm_top_albums`** — trigger an immediate rebuild:
      `curl -X POST -H "Authorization: Bearer rw_..." -H "Content-Type: application/json" \`
      `-d '{"type":"top_lists"}' https://api.rewind.rest/v1/admin/sync/listening`
- [ ] **`search_index`** — reindex listening:
      `curl -X POST -H "Authorization: Bearer rw_..." -H "Content-Type: application/json" \`
      `-d '{"domains":["listening"]}' https://api.rewind.rest/v1/admin/reindex-search`
- [ ] **`lastfm_monthly_stats` / `lastfm_yearly_stats`** — kick the stats
      sync (counts unique albums per period; splits change those counts):
      `curl -X POST -H "Authorization: Bearer rw_..." -H "Content-Type: application/json" \`
      `-d '{"type":"stats"}' https://api.rewind.rest/v1/admin/sync/listening`

## Phase 6 — Invariants and cleanup

- [x] **Tests**
  - [x] `upsertAlbum` strict-identity test (Phase 1)
  - [x] `upsertArtist` MBID-first lookup test (Phase 2)
  - [x] `planRepair` + `applyRepair` test suite (Phase 3)
- [x] **Runtime invariant** — nightly integrity check
  - [x] Daily `0 3` cron computes mismatch count excluding the canonical
        Various Artists row; logs `[WARN]` when non-zero, `[INTEGRITY]
album attribution clean` otherwise
  - [ ] Optionally page via Sentry at a threshold once a steady-state
        baseline is established
- [ ] **Schema cleanup** — deferred to a follow-up PR
      after Phase 3 has applied in prod and the audit table has been
      observed for ≥ 30 days
  - [ ] Drop `lastfm_albums.is_compilation` column + the
        `idx_lastfm_albums_compilation` index
  - [ ] Remove the field from `src/db/schema/lastfm.ts`
  - [ ] Remove the obsolete comment reference in
        `src/routes/listening.ts:2831`
- [ ] **Docs**
  - [ ] Add a one-line entry to `docs-mintlify/changelog.mdx` once the
        live apply has run
  - [ ] Mark this project complete in `docs/projects/`

## Rollback / restore notes

- Phase 1 & 2: revert PRs; sync resumes pre-fix behavior (new corruption
  resumes but old data is untouched).
- Phase 3: restore from the dated R2 D1 snapshot. The `_split_audit` table
  records every action so a custom inverse migration is possible, but full
  restore is the simpler path.
- Phases 4-6: re-running is safe (additive / idempotent recompute).
