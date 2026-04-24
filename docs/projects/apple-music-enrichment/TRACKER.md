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

## Phase 2 — Code: image refresh from Apple Music id

- [ ] Add `refreshArtistImageFromAppleMusicId(db, limit)` in
      `src/services/images/sync-images.ts`
  - [ ] Selects artists with `apple_music_id IS NOT NULL` AND either (no row
        in `images` for domain='listening' entity_type='artists') OR (row
        exists but source is null-placeholder older than 7d)
  - [ ] Fetches `https://api.music.apple.com/v1/catalog/us/artists/{id}`
        with the Apple Music developer token
  - [ ] Extracts `attributes.artwork.url`, substitutes `{w}`/`{h}` with 1000
  - [ ] Feeds into existing `processItems()` so thumbhash + color extraction +
        R2 upload reuse current plumbing
  - [ ] Skips silently (no error) when artist has no artwork in the catalog
  - [ ] Respects same idempotency guards as the existing Apple Music source
        (source name `apple-music`, same column)

## Phase 3 — Code: cron wiring + retry TTL

- [ ] Extend the `0 3 * * *` cron handler in `src/index.ts`: after existing
      top-lists / stats / `processListeningImages()` steps, call in order:
  - [ ] `enrichBatch(db, 200)` (existing, just add the call)
  - [ ] `enrichArtistsByName(db, 100)` (new)
  - [ ] `refreshArtistImageFromAppleMusicId(db, 100)` (new)
- [ ] Wrap each in the same try/catch isolation the other sync steps use so
      one failing doesn't poison the others
- [ ] Emit a single `[ENRICH]` log line per run summarizing
      `succeeded / no_match / rate_limited / failed` per step

## Phase 4 — Admin endpoints

- [ ] `POST /v1/admin/listening/enrich-artists` in `src/routes/listening.ts`
      — calls `enrichArtistsByName` with configurable `limit` query param
      (default 100, max 500)
- [ ] `POST /v1/admin/listening/refresh-artist-images` — calls
      `refreshArtistImageFromAppleMusicId` similarly
- [ ] Same Bearer-admin-key auth as existing admin routes
- [ ] Return JSON shape matching existing enrich route (for script reuse)

## Phase 5 — Tests

- [ ] `src/services/itunes/enrich.test.ts`:
  - [ ] `enrichArtistsByName` writes URL + id on mocked direct-artist match
  - [ ] `enrichArtistsByName` bumps `itunes_enriched_at` but leaves URL null
        on no-match
  - [ ] `enrichArtistsByName` honors 30-day retry tier (time-manipulated)
  - [ ] `enrichArtistsByName` early-exits on 403 without touching remaining
        rows
- [ ] `src/services/images/sync-images.test.ts` (new file or existing):
  - [ ] `refreshArtistImageFromAppleMusicId` skips artists without
        `apple_music_id`
  - [ ] Handles Apple Music catalog 404 / no artwork gracefully
- [ ] `npm test` all green
- [ ] `npm run lint` clean

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
