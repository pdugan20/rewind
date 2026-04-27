# Single-Entity Cards — Task Tracker

Legend: `[ ]` pending, `[x]` done, `[~]` in progress.

Phases ship independently — each delivers verifiable value (a passing test, an admin endpoint returning real data, an inline card in Claude Desktop). Earlier phases gate later ones; within a phase, sub-tasks usually parallelize.

Per the project's "robust and complete, avoid deferrals" guidance, every shipped feature in `README.md` Scope lands in this project. Items in `Out of scope` and `Follow-up projects` are explicitly outside.

## Phase 0: Foundation — IN PROGRESS

Goal: KV namespace bound, existing tools audited for `_meta.ui.resourceUri` consistency and `structuredContent` token bloat. ~half a day.

### 0.1 — Project docs

- [x] **0.1.1** `docs/projects/single-entity-cards/README.md` — scope, decisions, sequencing, open questions, follow-ups.
- [x] **0.1.2** `docs/projects/single-entity-cards/DESIGN.md` — `structuredContent` shapes, KV key conventions, Last.fm + MLB Stats API mappings, schema changes.
- [x] **0.1.3** `docs/projects/single-entity-cards/TRACKER.md` (this file).

### 0.2 — KV namespace — DONE

- [x] **0.2.1** Ran `wrangler kv namespace create rewind-cache` (prod id `e34b3662616b43048f3b7397f2fb9bac`) and `wrangler kv namespace create rewind-cache --preview` (preview id `b8773815b40f4bc5b739f5c3768457b1`).
- [x] **0.2.2** Added `[[kv_namespaces]]` block to `wrangler.toml` with `binding = "REWIND_CACHE"`, both ids set.
- [x] **0.2.3** Added `REWIND_CACHE: KVNamespace` to the `Env` interface in `src/types/env.ts`.
- [x] **0.2.4** `npx tsc --noEmit` passes; binding compiles cleanly.

### 0.3 — `_meta.ui.resourceUri` consistency audit — DONE

- [x] **0.3.1** Surveyed `server.tool` vs `server.registerTool` usage. Findings: `get_article`, `get_artist_details`, `get_attended_player` all on legacy `server.tool` form (Phases 1/2/3 will migrate). `get_attended_event` already on `server.registerTool` — reference impl.
- [x] **0.3.2** Auto-discovery of `web/*.html` entries by the inline-bundles script confirmed (per `attending-deep-stats` Phase 3 implementation).
- [x] **0.3.3** `registerUiResource()` pattern confirmed consistent — CSP allowlist + resource path + mime.

### 0.4 — `structuredContent` token-budget audit — DONE

- [x] **0.4.1** Static analysis of all single-entity tools captured in `BUDGET-AUDIT.md`.
- [x] **0.4.2** Two tools flagged: `get_article` (8–35 KB due to full body inclusion) and `get_attended_player` (10–30 KB due to unbounded appearances array). Both addressed by their respective phase trims.
- [x] **0.4.3** `BUDGET-AUDIT.md` committed with conventions to enforce going forward (no full bodies in structuredContent, list caps, aggregate-before-list, image-attachment objects).

### 0.5 — Phase 0 ship

- [ ] **0.5.1** Single commit: docs + KV binding + Env type + audit findings. Subject: `single-entity-cards Phase 0: foundation (KV + audit)`.
- [ ] **0.5.2** Push. Deploy auto-triggers; verify the KV binding is live in production via `wrangler kv key list --binding REWIND_CACHE` (will be empty, that's fine).

## Phase 1: Article card — DONE (modulo client smoke test)

Goal: `get_article` renders an inline card in Claude Desktop / iOS. Body trimmed from `structuredContent`. ~1 day.

### 1.1 — `get_article` `structuredContent` trim — DONE

- [x] **1.1.1** Trim done in the MCP tool layer (`mcp-server/src/tools/reading.ts`), not the backend route. Backend route stays stable for non-MCP consumers (docs site, API users); the MCP tool selectively rebuilds `structuredContent` to omit `content` and `excerpt`. Body still rendered into the text content block where the model reads it.
- [x] **1.1.2** Highlights capped at 5 in `structuredContent`; `highlight_count` carries the total. Total comes from the existing `highlights.length` (no new COUNT query needed — backend already returns the full array).
- [x] **1.1.3** No backend route changes → no `src/routes/reading.test.ts` updates needed.

### 1.2 — Vite entry — DONE

- [x] **1.2.1** `mcp-server/web/article.html` created.
- [x] **1.2.2** `mcp-server/web/article.tsx` created — `useApp()` + `useHostStyles()`, listens for ArticlePayload via `app.ontoolresult`.

### 1.3 — Card component — DONE

- [x] **1.3.1** `mcp-server/web/components/ArticleDetail.tsx` (named to avoid colliding with the existing `ArticleCard.tsx` used by `recent-reads`). Subcomponents: Hero, Byline, StatusPill, ProgressBar, HighlightsPanel, Footer.
- [x] **1.3.2** Hero uses og:image with thumbhash blur fade-in (200ms), `dominant_color → accent_color` linear-gradient fallback with first-letter monogram when image is null.
- [x] **1.3.3** Footer prefers `instapaper_app_url` (iOS deep-link); falls back to `instapaper_url`. Secondary "Read on source" button opens the original URL.
- [x] **1.3.4** StatusPill tones: `unread` (neutral), `read` (subdued), `archived` (subdued italic), `starred` (accent gold), `reading` (accent blue with progress bar shown when 0 < progress < 1).

### 1.4 — Fixtures — DONE

- [x] **1.4.1** `mcp-server/web/article.fixtures.ts` ships 4 fixtures: `default` (full-featured archived Simpsons essay with 4 highlights + 2 implied additional), `no-image` (plain unread, no hero), `in-progress` (status=reading with 0.42 progress + progress bar), `archived-no-highlights` (read article, no highlights, no og:image url but has thumbhash + colors).
- [ ] **1.4.2** Verify all fixtures render correctly in MCP Inspector — **action required from user** during smoke test.

### 1.5 — Wire into MCP tool — DONE

- [x] **1.5.1** `get_article` migrated from `server.tool` → `server.registerTool` with `_meta.ui.resourceUri = ui://rewind/article.html`. Description updated to mention text-block-vs-structuredContent split + the inline card.
- [x] **1.5.2** UI resource registered in `mcp-server/src/server.ts` with CSP `resourceDomains: ['https://cdn.rewind.rest']`.
- [x] **1.5.3** `INPUT=article.html npm run build:web` produced `web/dist/article.html` (458,399 chars).
- [x] **1.5.4** `src/ui-bundles.ts` auto-regenerated by the inline-bundles script.
- [x] **1.5.5** Manifest snapshot regenerated via `npm run mcp:update`. Tool count unchanged (still 48 — same tool, new registration form). Resource count +1 (`ui://rewind/article.html`). All 99 mcp-server tests pass.

### 1.6 — Smoke test — partial (deferred to user)

- [ ] **1.6.1** **Action required from user** — post-deploy: `rewind-local` MCP entry → Claude Desktop → query "show me the article I saved about [topic]" or "tell me about the Simpsons predictions article I read." Card should render inline.
- [ ] **1.6.2** **Action required from user** — capture a screenshot to `LIVE-CAPTURES.md`.

### 1.7 — Ship

- [ ] **1.7.1** Single commit: tool migration + Vite entry + component + fixtures + bundle + snapshot. Subject: `single-entity-cards Phase 1: article card`.
- [ ] **1.7.2** Push. Deploy.
- [ ] **1.7.3** Verify in production Claude Desktop.

## Phase 2: Artist card + top-tracks-by-artist — DONE (modulo client smoke test)

Goal: `get_artist_details` renders a single-artist card. `get_top_tracks` accepts `artist_id`, two competing layouts shipped as fixtures. Last.fm `getInfo` + `getSimilar` enrichment landed.

Schema: 5 new columns on `lastfm_artists` (`bio_summary`, `bio_content`, `bio_synced_at`, `similar_artists`, `similar_synced_at`). Migration `0012_far_avengers.sql` applied locally. Awaiting `npm run db:remote` for prod.

Last.fm enrichment helpers: `enrichArtistBio` (lazy-fill on artist detail render), `enrichArtistSimilar` (eager via daily 3:00 AM cron, top-200 by playcount). Intersection-with-user-listening enforced at storage time. 8 unit tests pass.

Two top-tracks UI layouts shipped as candidates — both register as `ui://` resources, neither wired to `_meta.ui.resourceUri` yet. Phase 4 picks the winner.

### 2.1 — Schema migrations

- [ ] **2.1.1** Add `bio_summary`, `bio_content`, `bio_synced_at`, `similar_artists`, `similar_synced_at` columns to `lastfm_artists` via Drizzle schema in `src/db/schema/lastfm.ts`.
- [ ] **2.1.2** `npm run db:generate` to produce the migration SQL.
- [ ] **2.1.3** `npm run db:migrate` (local) and `npm run db:remote` (prod after smoke-tested).

### 2.2 — Last.fm enrichment

- [ ] **2.2.1** Add `getArtistInfo(mbidOrName)` and `getArtistSimilar(mbidOrName)` callers to `src/services/lastfm/client.ts`. Match the existing `getTopTags` signature.
- [ ] **2.2.2** Add `enrichArtistBio(db, artistId)` helper to `src/services/lastfm/enrichment.ts`. Calls `getArtistInfo`, persists `bio_summary` + `bio_content` + `bio_synced_at`. Returns updated row.
- [ ] **2.2.3** Add `enrichArtistSimilar(db, artistId)` helper. Calls `getArtistSimilar`, resolves names against `lastfm_artists` (case-insensitive, MBID preferred), drops non-matches, persists JSON. Computes intersection at storage time.
- [ ] **2.2.4** `bio` is lazy-fill — call from the route handler when `bio_content IS NULL`. `similar_artists` is eager — wire into the daily 3:00 AM Last.fm cron for top-200 artists by playcount.
- [ ] **2.2.5** Admin endpoint `POST /v1/admin/sync/lastfm-artist-info` for manual backfill across all artists. Idempotent: skips artists with `bio_synced_at` < 90d old.
- [ ] **2.2.6** Tests for both enrichment helpers (mock Last.fm, verify persistence, verify intersection filter drops non-matches).

### 2.3 — `get_artist_details` route extension

- [ ] **2.3.1** Extend `/v1/listening/artists/:id` response to include `listening_stats` (total_scrobbles, first_scrobble_at, last_played_at, all_time_rank, distinct_tracks, distinct_albums), `sparkline`, and `similar_artists` (joined to `lastfm_artists` rows for cross-reference).
- [ ] **2.3.2** Lazy-fill bio: if `bio_content IS NULL`, call `enrichArtistBio` synchronously before returning.
- [ ] **2.3.3** Sparkline: reuse `services/lastfm/sparkline.ts` helper if it exists; else extract from the existing `top-artists` sparkline path.
- [ ] **2.3.4** Update tests; cover bio lazy-fill + similar-artists intersection cases.

### 2.4 — `get_top_tracks` artist filter

- [ ] **2.4.1** Add optional `artist_id` and `artist_name` query params to `/v1/listening/top/tracks`. Resolve `artist_name` to `artist_id` via case-insensitive substring match on `lastfm_artists.name`. Reject if both supplied.
- [ ] **2.4.2** Update SQL to filter `lastfm_tracks.artist_id = ?` when present. Composes with existing `DateFilterQuery`.
- [ ] **2.4.3** Update MCP tool `get_top_tracks` in `mcp-server/src/tools/listening.ts` with the new params. Tool description: "Use after `get_artist_details` only if a longer ranked list is needed; otherwise the embedded `top_tracks[]` from `get_artist_details` is sufficient."
- [ ] **2.4.4** Tests: filter by id, filter by name, filter + period, both supplied returns 400, unknown name returns 404.

### 2.5 — Artist card Vite entry + components

- [ ] **2.5.1** `mcp-server/web/artist.html` + `artist.tsx`.
- [ ] **2.5.2** `components/ArtistHero.tsx` — portrait + name + genre + bio_summary clamp.
- [ ] **2.5.3** `components/StatStrip.tsx` (reusable) — labeled stat tiles.
- [ ] **2.5.4** `components/Sparkline.tsx` — extract or reuse from `top-artists` if available.
- [ ] **2.5.5** Top tracks list: 5-row dense list with rank + art + name/album + scrobble count.
- [ ] **2.5.6** Top albums grid: 3 tiles in a row, reuse `AlbumCard.tsx` styling.
- [ ] **2.5.7** `components/SimilarArtistChips.tsx` — horizontal chip row, hidden when intersection empty.
- [ ] **2.5.8** Footer Apple Music link.

### 2.6 — Top-tracks-by-artist — both candidate UIs

- [ ] **2.6.1** `mcp-server/web/top-tracks-grid.html` + `top-tracks-grid.tsx`. Reuses `AlbumCard.tsx` styling adapted for tracks.
- [ ] **2.6.2** `mcp-server/web/top-tracks-list.html` + `top-tracks-list.tsx`. Dense ranked list styling adapted from `recent-reads`.
- [ ] **2.6.3** Both consume the same `structuredContent` shape from `get_top_tracks`.
- [ ] **2.6.4** Fixtures for both: 25 tracks for one artist, 5 tracks (small N), tracks across multiple albums.
- [ ] **2.6.5** **Neither is wired into `_meta.ui.resourceUri` yet.** Both are purely fixture-only previewable in MCP Inspector. Phase 4 picks the winner.

### 2.7 — Wire artist card into MCP tool

- [ ] **2.7.1** `get_artist_details` → `server.registerTool` with `_meta.ui.resourceUri = ui://rewind/artist.html`.
- [ ] **2.7.2** `registerUiResource()` in `server.ts` for the artist card.
- [ ] **2.7.3** Build, regenerate manifest snapshot, bump test count.

### 2.8 — Smoke test

- [ ] **2.8.1** Query: "Tell me about my Olivia Rodrigo listening history." Verify card renders with bio + stats + sparkline + top tracks + top albums + similar artists.
- [ ] **2.8.2** Query: "What Olivia Rodrigo songs have I been listening to lately." Verify the model uses `get_top_tracks(artist_id=X, period='1month')` (or similar) and returns a 25-track list. Preview both grid + list candidates side-by-side in MCP Inspector.
- [ ] **2.8.3** Capture screenshots of all three (artist card, grid candidate, list candidate) to `LIVE-CAPTURES.md`.

### 2.9 — Ship

- [ ] **2.9.1** Single commit. Subject: `single-entity-cards Phase 2: artist card + top-tracks-by-artist`.
- [ ] **2.9.2** Push, deploy, verify.

## Phase 3: Athlete card (MLB only) — pending

Goal: `get_attended_player` renders an MLB athlete card with live season stats + your-attended summary. ~3 days.

### 3.1 — Schema + table seed

- [ ] **3.1.1** New schema file `src/db/schema/mlb-teams.ts` — see DESIGN.md for shape.
- [ ] **3.1.2** `npm run db:generate` migration.
- [ ] **3.1.3** Seed `mlb_teams` once via the new sync helper (Section 3.3.2). Includes all 30 active MLB clubs.

### 3.2 — MLB Stats API service

- [ ] **3.2.1** `src/services/mlb-stats/client.ts` — exports `fetchPlayerSeasonStats(env, mlbStatsId, season)`. Hits `https://statsapi.mlb.com/api/v1/people/{id}/stats?stats=season&group=hitting,pitching&season={N}`. Returns `{ hitter: {...} | null, pitcher: {...} | null }` mapped per DESIGN.md.
- [ ] **3.2.2** KV cache wrapper. Key `mlb_stats:player:{id}:{season}`, TTL 1h. Returns `{ data, cache_hit: boolean }`.
- [ ] **3.2.3** Error handling: timeout (5s), non-200, malformed body all degrade to `null` so the card can render an "unavailable" state.
- [ ] **3.2.4** Tests with mocked fetch: hitter-only, pitcher-only, both (Ohtani-style), 404, timeout.

### 3.3 — `mlb_teams` sync

- [ ] **3.3.1** `src/services/mlb-stats/teams.ts` — `syncMlbTeams(env)` hits `/api/v1/teams?sportId=1`, upserts into `mlb_teams`. Pulls each team's logo via the existing image pipeline (R2 + thumbhash + dominant_color + accent_color).
- [ ] **3.3.2** Admin endpoint `POST /v1/admin/sync/mlb-teams` to trigger.
- [ ] **3.3.3** Yearly cron entry in `wrangler.toml` (March 1 each year, ahead of opening day).
- [ ] **3.3.4** Read-through endpoint `GET /v1/mlb/teams` (cached, 24h).

### 3.4 — `get_attended_player` route extension

- [ ] **3.4.1** Extend `/v1/attending/players/:id` response per DESIGN.md: add `team` (joined from `mlb_teams`), `supported`, `season_stats` (live MLB Stats API for MLB only), `attended_summary` (aggregate from `attended_event_players`), `attended_appearances` (capped at 10 most recent), `attended_appearance_count`.
- [ ] **3.4.2** Non-MLB short-circuit returns the appearance-only shape.
- [ ] **3.4.3** `attended_summary` aggregation reuses the `aggregatePlayerStats` helper from `attending-deep-stats` Phase 2 with a "no season filter" path.
- [ ] **3.4.4** Notable reasons derivation: parse `notable=1` rows for batting/pitching context (multi-hit, HR, complete game, etc.) — match the existing `attended-event` card's notable-badge logic.
- [ ] **3.4.5** Tests: MLB hitter end-to-end, MLB pitcher end-to-end, two-way (Ohtani), non-MLB short-circuit, MLB Stats API failure → graceful null.

### 3.5 — Athlete card components

- [ ] **3.5.1** `mcp-server/web/attended-player.html` + `attended-player.tsx`.
- [ ] **3.5.2** `components/PlayerHero.tsx` — photo + name + team logo + position/# + bats/throws.
- [ ] **3.5.3** `components/SeasonStatsBlock.tsx` — "This season" column, hitter or pitcher variant, "unavailable" fallback.
- [ ] **3.5.4** `components/AttendedSummaryBlock.tsx` — "In games you attended" column, hitter or pitcher variant.
- [ ] **3.5.5** `components/NotableHighlights.tsx` — bulleted summary of notable reasons across appearances.
- [ ] **3.5.6** Recent-appearances list — reuse `attended-event` row styling where possible; max 5 rows + "show all" expand.
- [ ] **3.5.7** Non-MLB rendering: hide season + notable blocks; keep hero + appearances list with a "we don't have stat lines for [league]" disclosure.

### 3.6 — Fixtures

- [ ] **3.6.1** `attended-player.fixtures.ts` — at least 5: MLB hitter (Cal Raleigh), MLB pitcher (Kirby), two-way player (Ohtani), MLB hitter with cache miss / unavailable season stats, non-MLB player (NFL or NBA).

### 3.7 — Wire into MCP tool

- [ ] **3.7.1** `get_attended_player` → `server.registerTool` with `_meta.ui.resourceUri = ui://rewind/attended-player.html`.
- [ ] **3.7.2** `registerUiResource()` with CSP `resourceDomains: ['https://cdn.rewind.rest']`.
- [ ] **3.7.3** Build, regenerate manifest, bump count.

### 3.8 — Smoke test

- [ ] **3.8.1** Query: "How many home runs has Cal Raleigh hit this year, and was I in attendance for any of those games?"
- [ ] **3.8.2** Verify card renders with this-season stats, attended-summary HR count, notable highlights showing the live HRs.
- [ ] **3.8.3** Capture screenshots to `LIVE-CAPTURES.md`.

### 3.9 — Ship

- [ ] **3.9.1** Single commit. Subject: `single-entity-cards Phase 3: athlete card (MLB only)`.
- [ ] **3.9.2** Push, deploy, verify.

## Phase 4: Polish + winner selection — pending

Goal: pick top-tracks layout winner, remove loser, run polish pass. ~half a day.

### 4.1 — Top-tracks winner selection

- [ ] **4.1.1** Side-by-side preview of both layouts in MCP Inspector with at least 3 distinct artist datasets (heavy listener, light listener, mixed-album distribution).
- [ ] **4.1.2** Decision captured at the bottom of `LIVE-CAPTURES.md` with date + reason. Default tiebreaker: list layout (more information density per row, scales better past 25 tracks).
- [ ] **4.1.3** Winner gets renamed to `top-tracks.html` / `.tsx`. Loser is **deleted**, not commented out.
- [ ] **4.1.4** `get_top_tracks` MCP tool gets `_meta.ui.resourceUri = ui://rewind/top-tracks.html` (only when `artist_id` is present? — decide during 4.1.1 whether to wire conditionally or always-on; open question is whether the existing "no artist filter" call should also render the new card).

### 4.2 — Token-budget pass

- [ ] **4.2.1** Re-run the Phase 0 audit on the three new tools (`get_article`, `get_artist_details`, `get_attended_player`). Confirm each `structuredContent` < 8 KB.
- [ ] **4.2.2** Trim list lengths (top tracks 10 → 5, etc.) if any tool blows the budget.
- [ ] **4.2.3** Update `BUDGET-AUDIT.md` with after-numbers.

### 4.3 — Lint + tests + docs

- [ ] **4.3.1** `npm run lint`, `npm run lint:claude`, `npm test`.
- [ ] **4.3.2** Update `mcp-server/README.md` Tools table — note that `get_article`, `get_artist_details`, `get_attended_player`, `get_top_tracks` now ship cards.
- [ ] **4.3.3** Update `docs-mintlify/mcp-server.mdx` accordions accordingly.
- [ ] **4.3.4** Changelog entry — see `docs-mintlify/changelog.mdx`.

### 4.4 — Ship

- [ ] **4.4.1** Single commit. Subject: `single-entity-cards Phase 4: polish + top-tracks winner`.
- [ ] **4.4.2** Push, deploy, verify.
- [ ] **4.4.3** Move project into `docs/projects/` (do not archive yet — leave for follow-up reference. Archive only if a follow-up project explicitly supersedes).

### 4.5 — Open follow-ups

- [ ] **4.5.1** Open GitHub issues for each `Follow-up projects` item in `README.md` so they don't get lost: sports box-score parity, single-entity cards for movies/TV/albums/vinyl, concert-performer cards, year-in-review cards, click-to-open custom handlers, refresh-on-stale.
