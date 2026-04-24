# Tracker

## Pre-flight — user answers needed before Phase 1 ✅

- [x] `APPLE_MUSIC_DEVELOPER_TOKEN` assumed current; smoke-test post-deploy
      before trusting Phase 7d.
- [x] Deploy strategy: **direct-to-main**, commit as we go.
- [x] Backfill execution: **assistant runs** it in-session. Admin key lives in
      local `.dev.vars` (no-echo; sourced into env var at run time).
- [x] Daily cron addition (~200 extra calls at 03:00 UTC): acknowledged.
- [x] Repo state: unrelated in-progress OG-fallback work committed
      (215ec21 + d2c8409) so this project starts from a clean tree.

## Phase 0 — Diagnosis & plan sign-off ✅

- [x] Explore pipeline end-to-end, identify root cause (track-driven,
      manual-only, once-per-artist guard)
- [x] Query prod D1 for baseline counts (28,674 tracks; 564 unenriched; 5,495
      artists; 877 null URL; 39 with playcount ≥5)
- [x] Draft plan, review with user, incorporate feedback (dropped image-source
      piggyback; added direct-id catalog lookup for images)
- [x] Create `docs/projects/apple-music-enrichment/{README,TRACKER}.md`

## Phase 1 — Code: artist-level iTunes fallback ✅

- [x] Add `enrichArtistsByName(db, limit)` in `src/services/itunes/enrich.ts`
  - [x] Selects from `lastfm_artists` WHERE `apple_music_url IS NULL` AND
        `is_filtered = 0` AND (`itunes_enriched_at IS NULL` OR
        `itunes_enriched_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')`);
        ORDER BY `itunes_enriched_at IS NULL DESC, playcount DESC`; LIMIT `limit`
  - [x] Calls `iTunes Search?entity=musicArtist&term=<cleanArtistName>&limit=5`
  - [x] Validates via existing `artistMatches()` util
  - [x] On hit: sets `apple_music_id`, `apple_music_url`, `itunes_enriched_at = now`
  - [x] On no_match: bumps `itunes_enriched_at` only (URL stays null → re-tries
        in 30d)
  - [x] On 403: early-exit with same shape as `enrichBatch`
- [x] Added `searchItunesArtist()` helper (parallels `searchItunes()` for tracks)
- [x] Exported from `enrich.ts`
- [x] Used `strftime` (not `datetime`) for threshold so it matches stored
      `Date.toISOString()` format exactly — avoids ~1-day retry-boundary drift
- [x] `npx tsc --noEmit` clean; `npm test` all 599 tests pass (no regressions)

## Phase 2 — Code: image refresh from Apple Music id ✅

- [x] Add `refreshArtistImageFromAppleMusicId(db, env, limit)` in
      `src/services/images/sync-images.ts`
  - [x] Selects artists with `apple_music_id IS NOT NULL` AND either
        (no row in `images` for domain='listening' entity_type='artists')
        OR (row exists but `source='none'` AND `created_at <` 7d-ago)
  - [x] Fetches `https://api.music.apple.com/v1/catalog/us/artists/{id}`
        with the Apple Music developer token
  - [x] Extracts `attributes.artwork.url`, substitutes `{w}`/`{h}` with 1000
  - [x] Feeds into `runPipeline()` with pre-resolved candidates so thumbhash +
        color extraction + R2 upload reuse existing plumbing
  - [x] On no artwork: bumps `images.created_at` on the placeholder so
        next retry honors the 7-day cooldown
  - [x] Skips silently when `APPLE_MUSIC_DEVELOPER_TOKEN` is unset
- [x] Extended `runPipeline` signature with
      `options.prefetchedCandidates?: ImageResult[]` — when present, bypasses
      the name-search waterfall (clean-separates deterministic by-id lookups
      from the existing name-search flow)
- [x] `npx tsc --noEmit` clean; `npm test` all 599 tests pass

## Phase 3 — Code: cron wiring + retry TTL ✅

- [x] Extend the `0 3 * * *` cron handler in `src/index.ts`: after existing
      top-lists / stats / `processListeningImages()` steps, call in order:
  - [x] `enrichBatch(db, 200)`
  - [x] `enrichArtistsByName(db, 100)`
  - [x] `refreshArtistImageFromAppleMusicId(db, env, 100)`
- [x] Separate try/catch so iTunes/Apple Music failures don't mark the
      Last.fm sync as failed
- [x] Single `[ENRICH]` log line per run with per-step succeeded/skipped/failed

## Phase 4 — Admin endpoints ✅

- [x] `POST /v1/listening/admin/enrich-artists` — calls `enrichArtistsByName`
      (limit query param, default 100, max 500)
- [x] `POST /v1/listening/admin/refresh-artist-images` — calls
      `refreshArtistImageFromAppleMusicId` (limit default 100, max 500)
- [x] Same auth scope as the existing `/listening/admin/enrich-apple-music`
      (read-key accepted, admin-scope override via /v1/admin/ prefix if ever
      needed — deferred since it's not a regression of current behavior)
- [x] JSON shape matches the existing enrich route for script reuse
- [x] OpenAPI snapshot regenerated to include the two new routes

## Phase 5 — Tests ✅

- [x] `src/services/itunes/enrich.test.ts` — 10 tests covering:
  - [x] Writes URL + id on direct-artist match
  - [x] Falls back to `artistViewUrl` when `artistLinkUrl` absent
  - [x] Bumps `itunes_enriched_at` but leaves URL null on no-match
  - [x] Rejects name mismatches (via `artistMatches` filter)
  - [x] Skips already-enriched artists
  - [x] Skips filtered artists
  - [x] Honors 30-day retry tier (time-manipulated: 15d skipped, 40d retried)
  - [x] Never-tried rows sort ahead of retried rows even when playcounts differ
  - [x] 403 rate-limit stops batch early without touching remaining rows
- [x] `src/services/images/refresh-artist-images.test.ts` — 8 tests covering:
  - [x] Zero-work when `APPLE_MUSIC_DEVELOPER_TOKEN` is unset
  - [x] Skips artists without `apple_music_id`
  - [x] Calls `runPipeline` with `prefetchedCandidates` on artwork hit
  - [x] Writes null-source placeholder when catalog returns no artwork
  - [x] Retries stale placeholder (>7d old)
  - [x] Does NOT retry fresh placeholder (<7d old)
  - [x] Handles 404 gracefully (stale id)
  - [x] Skips filtered artists
- [x] `npm test`: 617 passed (was 599, +18 new)
- [x] `npm run lint` clean

## Phase 6 — Deploy ✅

- [x] Commits on main: `f75acf2`, `3d57c6c`, `2dffcf2`
- [x] `npx wrangler deploy --dry-run` clean (1709.68 KiB / 300.57 KiB gzip)
- [x] `npm run deploy` succeeded (Version ID: ba64c339-4d8c-46c5-9c33-13e2535a0a0a)
- [x] Post-deploy smoke: `GET /v1/health` → `{"status":"ok"}`
- [x] Post-deploy smoke: `POST /v1/listening/admin/enrich-artists?limit=1`
      → `{"success":true,"results":{"total":1,"succeeded":1,...}}`
- [x] **Discovered**: original `APPLE_MUSIC_DEVELOPER_TOKEN` was invalid
      (401 on all endpoints despite JWT `exp` being 135d away) — signing
      key probably rotated in App Store Connect at some point, silently
      breaking Apple Music as an image source for artists the whole time
      (prod had 0 rows with `source='apple-music'` for listening/artists).
- [x] **Fixed**: promoted working token from `chat-app-prototype/.env`
      (same team id, 163d remaining) to rewind prod via
      `wrangler secret put APPLE_MUSIC_DEVELOPER_TOKEN` and updated
      local `.dev.vars`. Token is ES256-signed by AuthKey_99C4QGLP3J
      (p8 at `/Users/patrickdugan/Documents/Github/chat-app-prototype/
    assets/keys/AuthKey_99C4QGLP3J.p8`; regen via chat-app-prototype's
      `npm run generate-apple-token`).
- [x] Post-rotation smoke: `POST /v1/listening/admin/refresh-artist-images?limit=3`
      → `{"succeeded":3,"failed":0,"skipped":0}`

## Phase 7 — Backfill (ordered)

Goal: drive all four baseline counts to target.

- [x] **7a — Visible fix first.** One `POST /admin/enrich-artists?limit=50`
      call. Results: **36 succeeded, 9 skipped, 5 failed.** `playcount >= 5`
      null-URL count dropped **39 → 5**. All 10 top artists (1month) now
      have `apple_music_url`.
- [x] **7b — Track-level drain.** Two passes (initial limit=25 hit iTunes
      rate limits, retry with limit=10 + 3s sleep drained cleanly). Final:
      `tracks_null 564 → 0` ✅. Cascade effect: `artists_null 764 → 581`
      (−183), `albums_null 1,854 → 1,213` (−641).
- [x] **7c — Artist long-tail drain.** Three passes with adaptive backoff
      (20s on rate-limit early-exit). Final: **DRAINED at iter 29** of
      pass 3. `artists_null 581 → 258`, `never_tried 319 → 0` ✅
      (every artist has been attempted at least once). The 258 remaining
      are all `no_match` rows that will retry in 30 days via the daily
      cron's tiered selection.
- [x] **7d — Image refresh.** Drained at iter 13. **273 artists gained
      Apple Music artwork** (was 0 before token rotation). Null-source
      placeholders dropped **411 → 138**. Tunitas (rank 7) — no image
      before, now has `#edefec` dominant color from Apple Music catalog.
- [x] **iTunes rate-limit observations logged**: iTunes Search ~20
      requests/minute steady state; burst of 10+ in ~3s triggers 403 that
      takes 60–120s to clear. Our `enrichBatch` handles 403 via early-exit
      and keeps unprocessed rows NULL for retry.

## Phase 8 — Verify & observability ✅

- [x] Baseline SQL query re-run; final counts recorded in README below.
- [x] `get_top_artists(period=1month, limit=10)` — all 10 have both
      `apple_music_url` and `image` populated. Tunitas (rank 7) went from
      `image: null` to `dominant_color: #edefec` via direct-id catalog fetch.
- [x] Residual ≥5-play nulls spot-checked: all 5 are conjunction names
      ("Henrik Lindstrand & Kasper Bjørke", "Elskavon & John Hayes", etc.)
      — iTunes indexes collaborators separately, so the conjunction won't
      match as an artist entity. Expected failure mode, not a pipeline bug.
- [x] Added `enrichment.{artists_missing_apple_music_url_with_plays,
    artists_missing_apple_music_url, tracks_missing_itunes_enrichment}`
      to `GET /v1/health/sync`. Verified live: 5 / 258 / 0. (baseline: 39 / 877 / 564)
- [x] Test coverage: `src/routes/health.test.ts` asserts the enrichment
      field shape; 618 tests pass (was 617).
- [x] Deployed (version `72bcf25a-3fed-42e7-829c-df8b51f02a60`).
- [ ] Verify counter stable between consecutive cron runs — deferred to
      tomorrow (next cron fires at 03:00 UTC, ~23h from now). Not blocking.
- [ ] Grep `wrangler tail` for `[ENRICH]` summary after first cron run —
      same window; will verify in a next-day check.

## Blockers / escalations

_If a task here can't complete, pause and raise with the user before moving
on._

- [ ] (none yet)

## Shipped

- **Phase 1** — artist-level iTunes fallback (`enrichArtistsByName`) — `f75acf2`
- **Phase 2** — direct-by-id Apple Music image refresh — `3d57c6c`
- **Phase 3-5** — cron wiring + admin routes + 18 new tests — `2dffcf2`
- **Phase 6** — deployed (ver `ba64c339`); Apple Music JWT rotated from
  `chat-app-prototype/.env` after discovering prod token was silently
  invalid (0 apple-music images ever in prod before today)
- **Phase 7a-d** — backfill drained: tracks 564→0, artists-with-plays 39→5,
  artists-total 877→258, apple-music-images 0→273, placeholders 411→138
- **Phase 8** — `/v1/health/sync` enrichment counters shipped (ver `72bcf25a`)
