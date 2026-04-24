# apple-music-enrichment

Make the Apple Music URL / image pipeline for listening artists (and albums)
self-healing instead of one-shot. Backfill the existing gap and keep it
closed going forward.

## Problem

The API endpoint `GET /v1/listening/top/artists` returns `apple_music_url: null`
for 877 of 5,495 artists (16%), including 39 with ≥5 plays — enough that the
user-facing top-artists card in the MCP Apps UI shows broken / missing
Apple Music links past rank ~4. Two artists in the current top 10
(Tunitas rank 7 — no image at all) are also missing artwork.

Root cause is architectural, not data:

- `enrichBatch()` in `src/services/itunes/enrich.ts` is the only code path that
  writes `lastfm_artists.apple_music_url`. It is **track-driven** (iterates
  `lastfm_tracks`, enriches the associated artist as a side effect) and
  **manual-only** — wired to `POST /v1/admin/listening/enrich-apple-music` and
  the `scripts/backfills/backfill-apple-music.sh` helper, but **not to the
  cron**. So artists piling up after the last manual run never get URLs.
- Even when `enrichBatch` runs to completion, artists whose iTunes song-search
  match didn't return `artistId + artistViewUrl` are stuck forever. Example in
  prod: Silk Sonic (id=709, old row, still null URL).
- `upsertArtist()` in `src/services/lastfm/sync.ts` never passes a `url`
  argument from any callsite (verified at lines 280/447/515/588/738) — so
  Last.fm sync–created artists have empty `url` too, removing the fallback.
- Image pipeline (`src/services/images/pipeline.ts`) tries Deezer → AppleMusic
  → FanartTV; when none match by name, it writes a null-source placeholder
  that is never retried, so artists like Tunitas are permanently image-less.

## Goals

1. **Phase 0 — Diagnosis & plan sign-off.** Already done. Prod counts captured,
   plan reviewed, go-ahead from user. This README + TRACKER.
2. **Phase 1 — Code: artist-level iTunes fallback.** New `enrichArtistsByName`
   selects artists with `apple_music_url IS NULL` and hits
   `iTunes Search?entity=musicArtist`. Covers artists the track-driven pass
   can't reach (Silk Sonic) and new artists (>id 5700 cluster).
3. **Phase 2 — Code: image refresh from Apple Music id.** New
   `refreshArtistImageFromAppleMusicId` hits
   `api.music.apple.com/v1/catalog/us/artists/{id}` directly when we have the
   id, bypassing the name-search ambiguity that misses Tunitas-class artists.
4. **Phase 3 — Code: cron wiring + retry TTL.** Add three enrichment steps to
   the existing `0 3 * * *` handler. Both new functions use a tiered predicate
   so never-tried rows go first, and rows last tried ≥30d ago retry (catches
   artists newly added to Apple Music after prior failures).
5. **Phase 4 — Admin endpoints for backfill & manual poke.** Mirror the
   existing `enrich-apple-music` route:
   `POST /v1/admin/listening/enrich-artists` and
   `POST /v1/admin/listening/refresh-artist-images`.
6. **Phase 5 — Tests.** Vitest coverage for all three new/changed code paths,
   including the retry-TTL semantics.
7. **Phase 6 — Deploy.**
8. **Phase 7 — Backfill to completion.** Run prioritized passes in order:
   top-ranked artists first (clears the visible bug), then track-level drain,
   then artist-name long tail, then image refresh. Target empty queues.
9. **Phase 8 — Verify & observability.** Sanity queries hit zero; add
   `artists_missing_apple_music_url_with_plays` to `GET /v1/health/sync` so a
   silent regression is visible without manual SQL.

## Non-goals

- Album-level URL enrichment beyond the existing track-side-effect path. Track
  backfill in Phase 7 is expected to drop the 1,854 null-URL albums
  substantially; an album-direct lookup would be a separate project if the
  remaining count is still significant.
- Fallback to non-Apple sources for URL (e.g. Spotify, YouTube). Out of scope.
- Rewriting the track-driven `enrichBatch` — it works, we just add siblings
  and wire them in.
- Backfilling empty `lastfm_artists.url` (Last.fm URL) from the Last.fm API.
  Separate issue, not user-blocking.
- Publishing a new `rewind-mcp-server` npm version. No MCP server changes in
  this project.

## Success criteria

- `SELECT COUNT(*) FROM lastfm_artists WHERE apple_music_url IS NULL AND
playcount >= 5` drops from **39 → 0** (or a small single-digit residue of
  genuinely-not-on-Apple-Music artists).
- `SELECT COUNT(*) FROM lastfm_artists WHERE apple_music_url IS NULL` drops
  from **877 → under ~200** (long tail of obscure artists truly absent from
  the catalog).
- `SELECT COUNT(*) FROM lastfm_tracks WHERE itunes_enriched_at IS NULL AND
is_filtered = 0` drops from **564 → 0**.
- Top-10 artists in `get_top_artists` (period=1month) all have non-null
  `apple_music_url` (verified via MCP tool).
- Tunitas has an `image` object (via the direct id → catalog lookup), if
  Apple Music has the artist at all.
- `/v1/health/sync` returns the new counter; value is stable between days
  after backfill completes.
- Daily cron emits `[ENRICH]` log line with non-zero counts during burn-in,
  trending toward near-zero as the system reaches steady state.
- No regression in existing `enrichBatch` behavior — all existing tests pass.

## Prod baseline (captured 2026-04-23)

| Metric                                                         | Count        |
| -------------------------------------------------------------- | ------------ |
| Total tracks                                                   | 28,674       |
| Tracks unenriched (`itunes_enriched_at IS NULL`, not filtered) | 564          |
| Tracks with Apple Music URL                                    | 24,432 (85%) |
| Total artists                                                  | 5,495        |
| Artists with null URL                                          | 877 (16%)    |
| Artists with null URL AND `playcount >= 5`                     | 39           |
| Artists with Apple Music id                                    | 4,618 (84%)  |
| Albums with null URL                                           | 1,854        |

## Backfill pacing assumptions

- iTunes Search API: ~20 req/min safe steady-state (3s/call, mirrors existing
  `scripts/backfills/backfill-apple-music.sh`). 403 → stop batch, resume next
  tick.
- Apple Music Catalog API: higher per-JWT limit; expect no throttling at
  backfill volumes (<1,000 calls).

Estimated end-to-end backfill: **~75–90 minutes** serialized. The visible
part of the bug (39 top artists) clears in **~2 minutes**.

## References

- Diagnostic conversation: (this) — includes prod count query output.
- Existing enrichment: `src/services/itunes/enrich.ts` (keep; extend).
- Existing image pipeline: `src/services/images/pipeline.ts`,
  `src/services/images/sources/apple-music.ts`.
- Existing cron handler: `src/index.ts` (`0 3 * * *` scheduler).
- Existing backfill helper: `scripts/backfills/backfill-apple-music.sh`.
- Admin route precedent: `src/routes/listening.ts:3257`
  (`POST /v1/admin/listening/enrich-apple-music`).

## Iteration protocol

- One PR covering all code + tests. Merge, deploy, **then** run the backfill
  against prod so the new admin endpoints exist.
- Backfill runs are logged; pause and escalate if iTunes starts 403-ing past
  the built-in early-exit (means rate assumptions are wrong).
- If a phase hits an unexpected blocker, stop and escalate rather than
  shipping a partial fix.

## Open questions / needs from user before we start

Listed separately in TRACKER under "Pre-flight" so they're tracked. Short
version:

1. Is `APPLE_MUSIC_DEVELOPER_TOKEN` currently valid? Image refresh phase
   depends on it.
2. OK to deploy from main, or prefer a feature branch + PR review first?
3. Who runs the backfill — user invokes `curl` / `wrangler` locally against
   prod admin endpoints, or me via Bash? I'd default to me, with user
   supplying the admin key via env var and an audit visible in the transcript.
4. Any concern about the daily cron adding ~200 external API calls around
   03:00 UTC? (Rewind already makes hundreds of sync calls at that hour; this
   is a small fraction but worth confirming.)
