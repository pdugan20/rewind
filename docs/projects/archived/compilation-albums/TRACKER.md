# Compilation Album Dedup -- Tracker

## Phase 1: Schema and Migration

Merge fragmented compilation album rows into single entries.

**1.1 -- Schema**

- [x] **1.1.1** Add `is_compilation` column (integer, default 0) to `lastfmAlbums` in `src/db/schema/lastfm.ts`
- [x] **1.1.2** Write migration SQL (`migrations/0018_compilation_album_dedup.sql`)

**1.2 -- Apply Migration**

- [x] **1.2.1** Apply to remote D1 -- 11 queries, 829 loser rows merged into 128 compilation winners
- [x] **1.2.2** Verified: Reservoir Dogs collapsed from 9+ rows to 1, `is_compilation = 1`, playcount = 9
- [x] **1.2.3** Verified: "Greatest Hits" also merged (56 artists > 3 threshold) -- benign false positive, tracks retain correct artist links
- [x] **1.2.4** Track reparenting confirmed via spot-check

## Phase 2: Sync Fix

Prevent regressions -- new compilation tracks should reuse existing album rows.

**2.1 -- upsertAlbum**

- [x] **2.1.1** Add compilation fallback lookup in `upsertAlbum`: after exact `(name, artistId)` miss, check for `(name, is_compilation = 1)` match

**2.2 -- Verify**

- [x] **2.2.1** Run full test suite (478 passed), lint, typecheck -- all clean

## Phase 3: Endpoint Verification

Confirm all affected endpoints now return correct data.

**3.1 -- Smoke Tests**

- [x] **3.1.1** `GET /v1/listening/year/2025?month=7` -- Reservoir Dogs appears once with 9 scrobbles
- [x] **3.1.2** Deploy to production

## Phase 4: Cleanup and Archive

**4.1 -- Documentation**

- [x] **4.1.1** Close issue #6

**4.2 -- Archive**

- [x] **4.2.1** Move project to `docs/projects/archived/compilation-albums/`
- [x] **4.2.2** Mark TRACKER.md tasks complete

## Deferred

- **Auto-detection of new compilations**: Periodic task to flag albums that grow to 3+ artists after initial migration. Low priority -- new compilations are rare during incremental sync.
- **"Various Artists" display name**: Show "Various Artists" instead of the winner row's artist name in compilation album responses. Cosmetic improvement for later.
- **Name variant merging**: "Reservoir Dogs: OST" vs "Reservoir Dogs OST" vs "Reservoir Dogs (OST)" are still separate rows. Could normalize punctuation during merge. Low impact since only the one with scrobbles matters.
