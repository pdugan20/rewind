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

## Phase 6 — Deploy

- [ ] Feature branch pushed, PR opened (if that's the agreed path)
- [ ] CI green
- [ ] `npm run deploy` (or merge-triggered deploy, depending on setup)
- [ ] Post-deploy smoke: `curl https://api.rewind.rest/v1/health` returns ok
- [ ] Post-deploy smoke: `curl -X POST .../v1/admin/listening/enrich-artists?limit=1`
      returns a valid response shape

## Phase 7 — Backfill (ordered)

Goal: drive all four baseline counts to target.

- [ ] **7a — Visible fix first.** Run
      `POST /v1/admin/listening/enrich-artists?limit=50` prioritized by
      `playcount DESC`. Expect the 39 `playcount >= 5` artists to clear in
      ~2 minutes. Verify via `get_top_artists` MCP call — top 10 all have
      `apple_music_url`.
- [ ] **7b — Track-level drain.** Loop
      `POST /v1/admin/listening/enrich-apple-music?limit=200` with 3s between
      batches via existing `scripts/backfills/backfill-apple-music.sh` until
      response reports `total: 0`. Expected ~28 min for 564 tracks. Will also
      fill artists and albums as side effect.
- [ ] **7c — Artist long-tail drain.** Loop
      `POST /v1/admin/listening/enrich-artists?limit=100` until empty.
      Expected ~30–45 min; target gets smaller as 7b reduces it.
- [ ] **7d — Image refresh.** Loop
      `POST /v1/admin/listening/refresh-artist-images?limit=100` until empty.
      Expected ~15–30 min. Should give Tunitas an image if Apple Music has
      the artist.
- [ ] Sanity queries after each step, recorded in TRACKER under the step.

## Phase 8 — Verify & observability

- [ ] Re-run baseline SQL query; record final counts in TRACKER
- [ ] Verify `get_top_artists` response: top 10 all have `apple_music_url`
      AND `image` populated
- [ ] Spot-check residual null-URL artists — confirm they're legitimately
      not on Apple Music (search manually for 3–5)
- [ ] Add `artists_missing_apple_music_url_with_plays` counter to
      `GET /v1/health/sync` response
- [ ] Verify counter value is stable between two consecutive cron runs
      (indicates steady state)
- [ ] Grep `wrangler tail` output for `[ENRICH]` summary after first cron run
      post-deploy — confirm format and counts
- [ ] Archive: update `docs/projects/apple-music-enrichment/README.md` status
      section with final numbers

## Blockers / escalations

_If a task here can't complete, pause and raise with the user before moving
on._

- [ ] (none yet)

## Shipped

_Move completed phases here with their commit SHAs for traceability._
