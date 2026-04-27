# Project: Single-Entity Cards

Three new MCP Apps card UIs for single-entity tools — `get_article` (Instapaper), `get_artist_details` (Last.fm), `get_attended_player` (MLB) — plus an `artist_id` filter on `get_top_tracks` with two competing layouts so we can pick the winner before merge.

The three existing card components (`recent-watches`, `recent-reads`, `top-albums`/`top-artists`, `attended-event`/`attended-season`) are all _list-shaped_. This project rounds out the surface with the _single-entity_ shape — a richer hero + supplementary stats layout that pairs with a verbose model-written prose answer.

## Target client

**Primary:** Claude Desktop (macOS, ~720px max width per the desktop width cap memory) and Claude iOS (renders MCP Apps as of April 2026). The deployed Worker at `mcp.rewind.rest` and the `rewind-mcp-server` npm package both ship the bundles.

**Secondary / dev-only:** Claude Code CLI doesn't render `ui://` resources; we validate iteratively against `rewind-local` MCP Inspector + Claude Desktop using the dev workflow established by [reading-music-cards](../reading-music-cards/README.md).

## Motivation

Five concrete things this unlocks:

1. **Single-entity natural-language queries** that today degrade to a wall of prose with no visual anchor:
   - "Tell me about my Olivia Rodrigo listening history"
   - "How many home runs has Cal Raleigh hit this year, and was I in attendance for any of those games?"
   - "I was reading an article the other month about the Simpsons, can you find that for me?"
2. **Per-artist top tracks**, currently impossible — `get_top_tracks` has no artist filter, so the only way to answer "what Olivia Rodrigo songs have I been listening to lately" is to call `get_artist_details` and read its embedded (capped, period-less) `top_tracks[]`. Adding `artist_id` + reusing `DateFilterQuery` gives the model first-class composition over period and artist.
3. **Verbose-text-plus-supplementary-card pattern**, validated. The list cards already exist but the user-facing experience hasn't been pressure-tested on single-entity tools where the model is expected to write 3–4 paragraphs of analysis from `structuredContent` and the card is meant to _supplement_ (not duplicate) that text. This project is where we lock in the convention.
4. **Live-data athlete card** — the first Rewind card that fetches live external data on render (MLB Stats API for current-season stats), backed by a 1h KV cache. Establishes the pattern for any future card that wants fresh external enrichment.
5. **Artist enrichment depth.** We've collected images and Apple Music links but discarded bio + similar-artists. This project closes that gap, with similar-artists auto-cross-referenced against your own listening history (so the card surfaces only artists _you've also listened to_ — a join that makes related artists meaningful instead of generic).

## Status

Direct commits to `main`, one focused commit per phase or per logical chunk. No worktree branch.

| Phase | Status                                                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------- |
| 0     | Foundation — KV namespace bind + `_meta.ui.resourceUri` audit + `structuredContent` token-budget audit — IN PROGRESS |
| 1     | Article card — `ui://rewind/article.html`, simplest of the three, validates the supplementary-card pattern           |
| 2     | Artist card + top-tracks-by-artist — Last.fm `getInfo` + `getSimilar` enrichment, two competing top-tracks layouts   |
| 3     | Athlete card (MLB) — MLB Stats API service, KV-cached season stats, `mlb_teams` lookup, attended-summary derivations |
| 4     | Polish — pick top-tracks layout winner, remove loser, claudelint + tests, structuredContent token-budget pass        |

No hard checkpoint between phases — the user's explicit guidance was "robust and complete, avoid deferrals." Phases ship in order so a regression in the pattern (e.g. structuredContent shape decisions) caught in Phase 1 propagates cleanly into Phases 2–3.

## Scope

In scope:

- **`ui://rewind/article.html`** — single-article card on `get_article`. Hero og:image, title + byline + domain, meta strip (read time, saved date, status, progress), 2–3 line description, top 3 highlights, footer link to Instapaper.
- **`ui://rewind/artist.html`** — single-artist card on `get_artist_details`. Hero portrait + name + genre + 2-line bio summary, stat strip (total scrobbles, first scrobble date, last played, all-time rank), sparkline of plays over time, top-5 tracks list, top-3 albums grid, similar-artists footer (cross-referenced against the user's own listening).
- **`ui://rewind/attended-player.html`** — MLB-only single-athlete card on `get_attended_player`. Hero headshot + team logo + name/#/position + bats/throws, two stat columns ("This season" via live MLB Stats API | "In games you attended" derived from `attended_event_players`), notable highlights ("3 HRs you witnessed live"), recent-appearances list with notable badges.
- **`get_top_tracks` artist filter** — adds `artist_id` (and `artist_name` resolver) to both the MCP tool and `/v1/listening/top/tracks`. Composes with existing `period`, `from`, `to` via `DateFilterQuery`. Two competing UI layouts shipped as fixtures (`top-tracks-grid.html`, `top-tracks-list.html`); winner wired into `_meta.ui.resourceUri` in Phase 4.
- **Last.fm artist enrichment** — `bio_summary`, `bio_content`, `similar_artists` (JSON) columns added to `lastfm_artists`. `artist.getInfo` and `artist.getSimilar` calls added to the Last.fm sync; backfill via admin endpoint.
- **MLB Stats API service** — new `src/services/mlb-stats/` with one endpoint wrapper for `/api/v1/people/{id}/stats?stats=season&group=hitting,pitching`. KV-cached 1h.
- **`mlb_teams` lookup table** — name, abbreviation, league, primary_color, logo_image_key. Synced once, refreshed yearly via cron. Logos passed through the existing image pipeline for thumbhash + dominant/accent colors.
- **KV namespace** — `REWIND_CACHE` binding on the main worker. Used initially by the MLB Stats API service; available for any future fetch-on-render enrichment.

Out of scope:

- **Non-MLB athlete cards.** NBA, NFL, WNBA, NCAAF, NCAAB are out — they'd need their own stat sources (ESPN box scores from the `sports-boxscore-parity` follow-up project) and different card layouts (no plate appearances, different "notable" rules). Athlete card v1 returns a coverage-disclosure response for non-MLB players (`{ supported: false, league, attended_summary_only: true }`) so the model can phrase queries correctly.
- **Movie / TV / album / vinyl single-entity cards.** `get_movie_details`, `get_album_details`, etc. exist but aren't in this scope. Same pattern would apply; ship as follow-ups once the convention is proven on these three.
- **Concert / arts performer cards.** Cross-domain `lastfm_artist_id` ↔ `attended_event_performers` linking is its own design problem (artist on Last.fm vs. performer at a concert can be the same entity or different). Defer.
- **Editorial / human-curated bio text.** `bio_summary` and `bio_content` come from Last.fm's `artist.getInfo`. We do not write our own.
- **Real-time / in-season MLB Stats API freshness below 1h.** The cache TTL is 1h; if a player hits a HR mid-game the card won't reflect it until cache expiry. Acceptable.
- **Instapaper article body in `structuredContent`.** Phase 0 strips the full article body out of `get_article`'s `structuredContent` (currently included, ~5–30 KB). The body is still fetchable via the same tool; just not dumped on every call.
- **Click handlers / interactive controls inside cards.** All three cards are read-only in v1, matching the existing `attended-event` card's approach. Click-to-open links happen via host-level URL handling on `<a href>` tags, not custom `app.openLink` plumbing.

## Architecture

### What's already on disk

```text
reading_items                        -- title, author, url, og_image, description, word_count, highlights, full content
reading_highlights                   -- per-highlight text, note, created_at
lastfm_artists                       -- name, mbid, url, playcount, tags JSON, genre, apple_music_id, image_key
lastfm_tracks                        -- name, artist_id, album_id, scrobble_count, apple_music_id, preview_url
lastfm_scrobbles                     -- played_at, track_id (joins to artist via track)
players                              -- name, position, jersey, bats, throws, debut, birth_country, photo_silo, photo_full, mlb_stats_id
attended_event_players               -- per-game per-player batting_line / pitching_line / decision JSON
images                               -- domain/entity_type/entity_id → r2 key + thumbhash + dominant_color + accent_color
```

### New surface

```text
KV namespace: REWIND_CACHE                                  -- Phase 0

GET  /v1/listening/top/tracks?artist_id=N                   -- Phase 2 (extends existing endpoint)
GET  /v1/listening/artists/:id (extended)                   -- Phase 2 (adds bio + similar_artists + first/last + rank + sparkline)
GET  /v1/attending/players/:id (extended)                   -- Phase 3 (adds team object, season_stats, attended_summary)
POST /v1/admin/sync/lastfm-artist-info                      -- Phase 2 (backfill admin endpoint)
GET  /v1/mlb/teams                                          -- Phase 3 (read-through to mlb_teams table)
POST /v1/admin/sync/mlb-teams                               -- Phase 3 (yearly refresh trigger)

mlb_teams                                                   -- Phase 3 new table

ui://rewind/article.html                                    -- Phase 1
ui://rewind/artist.html                                     -- Phase 2
ui://rewind/top-tracks-grid.html                            -- Phase 2 (candidate)
ui://rewind/top-tracks-list.html                            -- Phase 2 (candidate)
ui://rewind/top-tracks.html                                 -- Phase 4 (winner; alias of grid OR list)
ui://rewind/attended-player.html                            -- Phase 3
```

### Where each piece lives

```text
src/services/lastfm/
  client.ts                          -- Phase 2: add getArtistInfo + getArtistSimilar callers
  sync.ts                            -- Phase 2: enrich on artist discovery; backfill helper
  enrichment.ts                      -- Phase 2: similar-artists cross-reference helper

src/services/mlb-stats/              -- Phase 3 new directory
  client.ts                          -- /api/v1/people/{id}/stats wrapper
  teams.ts                           -- /api/v1/teams sync into mlb_teams

src/routes/
  listening.ts                       -- Phase 2: artist_id on top/tracks; extend artists/:id
  attending.ts                       -- Phase 3: extend players/:id with season_stats + attended_summary
  reading.ts                         -- Phase 0: trim full content from get_article structuredContent
  system.ts                          -- Phase 2 + 3: admin endpoints

src/db/schema/
  lastfm.ts                          -- Phase 2: add bio_summary, bio_content, similar_artists, similar_synced_at
  mlb-teams.ts                       -- Phase 3 new schema file

src/types/env.ts                     -- Phase 0: add REWIND_CACHE: KVNamespace

mcp-server/src/tools/
  reading.ts                         -- Phase 1: wire _meta.ui.resourceUri on get_article
  listening.ts                       -- Phase 2: wire artist card; add artist_id to get_top_tracks
  attending.ts                       -- Phase 3: wire athlete card

mcp-server/web/
  article.html / .tsx                -- Phase 1
  artist.html / .tsx                 -- Phase 2
  top-tracks-grid.html / .tsx        -- Phase 2
  top-tracks-list.html / .tsx        -- Phase 2
  attended-player.html / .tsx        -- Phase 3
  components/
    ArticleCard.tsx                  -- Phase 1
    ArtistHero.tsx                   -- Phase 2
    SimilarArtistChips.tsx           -- Phase 2
    PlayerHero.tsx                   -- Phase 3
    SeasonStatsBlock.tsx             -- Phase 3
    AttendedSummaryBlock.tsx         -- Phase 3
    NotableHighlights.tsx            -- Phase 3

migrations/                          -- Drizzle-generated SQL for the schema changes
```

### Data flow per card

**Article card.** Tool call → API hits `reading_items` + `reading_highlights` → response carries `structuredContent` minus full body → host renders card from structuredContent. Zero new external calls.

**Artist card.** Tool call → API hits `lastfm_artists` (joined to images, top tracks, top albums, similar artists). If `bio_content IS NULL`, lazy-fetch from Last.fm in the same request, persist, return. Same pattern as existing `itunes-enrichment` lazy fill.

**Athlete card.** Tool call → API loads player + team from D1. Concurrently: live MLB Stats API fetch via `services/mlb-stats/client.ts`, KV-cached 1h. Aggregate `attended_event_players` into the per-user "in games you attended" block. All three composed into the response. Non-MLB players short-circuit to a coverage-disclosure response.

**Top tracks by artist.** `get_top_tracks(artist_id, period, from, to, limit)` → API joins `lastfm_scrobbles → lastfm_tracks → lastfm_artists`, filters on `artist_id`, applies date filter via `buildDateCondition`, groups by track, orders by play count. Same response shape as today; just filtered.

## Decisions

These lock in the open questions surfaced during planning. Defaults are picked; flag during implementation if any need to change.

| Decision                                                                                                                                              | Why                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Always-on UI** — every single-entity tool that has a card declares `_meta.ui.resourceUri` unconditionally; no `view: card \| data` parameter        | MCP Apps spec — host decides at render time whether to display. Matches the existing `get_attended_event` pattern. Model never passes a "view" hint; we don't invent one.                                                                                                                                                    |
| **`structuredContent` is data only, not prose**                                                                                                       | The model never sees the rendered HTML. It writes verbose prose from `structuredContent`. Prose or HTML in `structuredContent` is wasted tokens. Numbers / IDs / URLs / dates / structured fields only.                                                                                                                      |
| **`structuredContent` is a superset of what the card renders**                                                                                        | Some fields (e.g. full bio body, full appearance list) help the model write a richer paragraph but don't fit on the card. They go in `structuredContent` even if the card hides them.                                                                                                                                        |
| **No related artists, no similar artists** without a self-join filter                                                                                 | Related-artist lists from Last.fm are generic and noisy. The artist card's "similar artists" section is the _intersection_ of Last.fm `artist.getSimilar` ∩ your own `lastfm_artists` table — only related artists _you've also listened to_, sorted by your own playcount. Generic suggestions add no value here.           |
| **Athlete card is MLB-only in v1**                                                                                                                    | `players` schema and `attended_event_players` only carry MLB stat lines. Returning empty for an NFL player would silently look like "the player has zero stats" rather than "we don't have the data." Explicit `supported: false` for non-MLB players, mirroring the `/players/:id/stats` shape from `attending-deep-stats`. |
| **MLB Stats API season stats fetched on render, KV-cached 1h**                                                                                        | Freshness matters for the example query ("how many HRs has Cal Raleigh hit _this year_"). Stats change daily during the season. 1h staleness is acceptable; nightly sync into D1 would be too stale during gameweeks.                                                                                                        |
| **`REWIND_CACHE` is a single shared KV namespace**, not per-purpose namespaces                                                                        | KV is cheap; namespaces are not free-form. One shared namespace with key prefixes (`mlb_stats:season:{id}:{season}`, `fanart:{mbid}`, etc.) is simpler than three separate bindings. Future fetch-on-render features compose without `wrangler.toml` churn.                                                                  |
| **`bio_summary` + `bio_content` lazy-filled on first artist card render**, not eagerly synced for all artists                                         | We have ~hundreds of artists. Eager backfill = hundreds of Last.fm calls on next sync. Lazy fill = one extra call the first time a card is requested for a given artist, then cached forever. Same pattern as `itunes-enrichment`.                                                                                           |
| **`similar_artists` synced eagerly via the daily Last.fm cron** for the user's top-N artists by playcount, not on demand                              | Computing the "similar ∩ my listened" intersection requires both the Last.fm response _and_ a cross-reference query. Doing it lazily would slow the artist card's first render by an extra round-trip. Top-200 artists by playcount get refreshed nightly; long-tail artists fall back to "no similar artists shown."        |
| **Two top-tracks layouts shipped to `web/` as fixtures during Phase 2**, winner picked in Phase 4                                                     | User explicitly asked for "build both, we can pick and iterate." Both bundles ship; only one is wired into `_meta.ui.resourceUri` after the picker call. The losing component is removed in Phase 4 (not kept "for later" — that's a deferral by another name).                                                              |
| **`get_article` `structuredContent` drops the full article body**                                                                                     | Currently 5–30 KB per response, included unconditionally. The body is never displayed by the card and is rarely needed by the model for a "find me that article" query. Audit will check whether any other tool returns the full body when only an excerpt is needed.                                                        |
| **`mlb_teams` is a new D1 table, not a JSON file**                                                                                                    | Logos go through the image pipeline → R2 + thumbhash + colors. That requires an `images` row, which keys off `(domain='attending', entity_type='mlb_teams', entity_id=team_id)` — needs a real table the FK can point at. JSON wouldn't compose with existing image plumbing.                                                |
| **Card layouts are read-only in v1** (no click-to-open custom handlers)                                                                               | Match the `attended-event` card's approach. Standard `<a href>` links work in iframe hosts; custom `app.openLink` plumbing is its own integration cost. Defer to a Phase 5 follow-up if needed.                                                                                                                              |
| **Artist card's "first scrobble date" comes from a `MIN(scrobbled_at)` query, not a stored column**                                                   | Indexed on `(track_id, scrobbled_at)`. Cheap. Storing a `first_scrobbled_at` column on `lastfm_artists` would require a backfill + sync invariant. Query is fine.                                                                                                                                                            |
| **Sparkline granularity matches the existing `top-artists` convention** — period-aware (`day` for short windows, `week` for medium, `month` for ≥6mo) | Reuse the helper that already builds sparklines for the top-artists card. Don't invent a new shape.                                                                                                                                                                                                                          |

## Concerns and risks

1. **Token budget on `structuredContent`.** Three new tools, each potentially carrying multiple nested arrays (top tracks, top albums, similar artists, recent appearances, highlights). If any one of them balloons past ~8 KB, the model's context for writing prose shrinks. Phase 0 audit + a token-budget pass in Phase 4 mitigate this; if budgets are tight, we trim list lengths (`top_tracks: 10 → 5`) before merging.

2. **MLB Stats API rate limits.** The endpoint is unauthenticated and has no published rate limit, but Cloudflare-routed traffic has historically been rate-limited by some MLB endpoints. KV cache (1h) keeps repeat calls cheap; first-render-per-player-per-hour is the floor. Worst case: degrade gracefully to "season stats unavailable" rather than failing the whole card.

3. **Last.fm `artist.getSimilar` quality.** Last.fm's similar-artists are sometimes generic (e.g. "Olivia Rodrigo" → "Taylor Swift" — true but obvious). The intersect-with-my-listening filter is the main mitigation. If the intersection is empty, hide the section entirely rather than showing nothing useful. If it's _too_ obvious in practice, consider a secondary signal (e.g. require minimum playcount threshold).

4. **Bio quality on long-tail artists.** Last.fm bios on indie artists are often thin or wiki-pasted. Card design uses `bio_summary` (1–2 sentences) by default with `bio_content` available in `structuredContent` for the model. Acceptable degradation.

5. **iOS rendering of the live-stats column.** The athlete card depends on a successful KV-cached live fetch. If iOS networking quirks or the user's connection cause the fetch to fail, the card needs a graceful fallback ("season stats unavailable"). Phase 3 adds an explicit error state.

6. **mlb_teams logo licensing.** MLB team logos are trademarked. The existing usage pattern (R2-cached, served on cdn.rewind.rest, displayed inline in private personal-data UI) is consistent with how player photos are already served — but this is the first time team logos hit the surface. Worth a note. Personal-use data archive surfaced privately to the user is a reasonable defense; we are not redistributing.

7. **Bundle size.** Each `ui://` entry inlines its own React + dependencies via `vite-plugin-singlefile`. The five new HTML entries add ~2.2 MB total to `web/dist/`, all inlined into `src/ui-bundles.ts`. The Worker has bundle-size limits (10 MB compressed); current consumed budget is well under, but worth monitoring.

8. **Top-tracks layout indecision.** Building both is the right call for picker velocity, but if neither feels right we'll know it after Phase 2 ends, before Phase 3 starts. Phase 4 isn't only "pick the winner" — it's also "iterate if neither won." Worth budgeting an extra day for that.

## Sequencing strategy

1. **Phase 0 (foundation)** is cheap and prevents two classes of bug — misconfigured KV (Phase 3 would fail silently) and `structuredContent` token bloat (any phase could trip it). Half a day.

2. **Phase 1 (article card)** is the simplest. Zero new backend, zero new external dependencies. Validates the "verbose text + supplementary card" pattern on the lowest-risk surface. If the pattern feels wrong (e.g. the card duplicates the prose, or the model leaves out detail because it's "in the card"), we discover it here before committing the artist + athlete designs.

3. **Phase 2 (artist + top-tracks)** is the medium phase. Last.fm enrichment + two competing UI layouts + the per-artist top-tracks query. Largest LOC of any phase, but data plumbing is well-understood (matches existing Last.fm sync).

4. **Phase 3 (athlete card)** is the most risk per LOC — first card with live external data, first KV usage, first MLB Stats API integration, first `mlb_teams` plumbing. Doing it last means the structuredContent shape conventions and supplementary-card UX are already locked in from Phases 1–2.

5. **Phase 4 (polish)** picks the top-tracks winner, removes the loser, runs the token-budget pass, claudelint, deploys.

## Open questions

These are real unknowns that will shape later phases:

1. **Will the model use the lazy-fill artist bio call, or will it skip the second sync round-trip?** The `get_artist_details` tool description says "may take 200ms longer on first call for newly-discovered artists" — but if the model interprets that as "don't call this," the bio never fills. Phase 2 should validate by running the example query against a freshly-pulled artist with no bio yet.

2. **Does the host iframe sandbox allow direct fetch from `cdn.rewind.rest` on iOS?** Existing cards work, so probably yes, but the new cards add MLB team logos served from `cdn.rewind.rest` and Last.fm-hosted similar-artist mini-portraits. CSP allowlist already covers `cdn.rewind.rest`; add the Last.fm CDN host if we link similar-artist images directly rather than proxying them through R2.

3. **What's the right `structuredContent` shape for the "in games you attended" stat block when the player is a hitter who pitched once (rare position-player-pitching)?** The `attending-deep-stats` schema discriminates `hitter | pitcher | unsupported`; the card layout assumes one or the other. Phase 3 needs to resolve whether to show both panels or just the dominant one.

4. **How does Claude phrase a query like "tell me about my Olivia Rodrigo listening" when both `get_artist_details(id)` and the new `get_top_tracks(artist_id)` are available?** Tool-count + tool-description pressure may steer it toward calling only one. Phase 2's tool description for `get_top_tracks` should explicitly say "use after `get_artist_details` if a longer ranked list is needed; otherwise the embedded `top_tracks[]` from `get_artist_details` is sufficient."

5. **Will the user notice the difference between the two top-tracks layouts in real conversation?** If both render adequately, the picker call is aesthetic. Worth screen-recording the same query against both bundles before deciding.

## Iteration protocol

Matches the [reading-music-cards](../reading-music-cards/README.md) protocol:

- UI design done live: user sends screenshots + verbal feedback; assistant edits TSX, rebuilds, user reloads Claude Desktop (local entry).
- Default to `rewind-local` MCP entry during iteration; do not publish to npm mid-phase.
- Use MCP Inspector for non-routing changes (component-only edits) to avoid full Claude Desktop reload cycles.
- If a phase hits an unexpected blocker (Claude Desktop rendering issue, spec disagreement, tool-wiring that doesn't fire), **stop and escalate** rather than shipping a partial fix.
- When a card lands in production, capture a screenshot with a representative query into a small `LIVE-CAPTURES.md` doc — useful for the changelog and for catching regressions later.

## Follow-up projects

These are deliberately _not_ in this project:

- **Sports box-score parity (NFL / NBA / WNBA / NCAAF / NCAAB).** Picks up `sports-boxscore-parity/` follow-up; once those leagues have stat lines, the athlete card extends from MLB-only to multi-league. Card layout would need a sport-specific stats panel.
- **Single-entity cards for movies / TV / albums / vinyl.** `get_movie_details`, `get_album_details`, `get_release_details`, etc. would each get cards following this project's pattern. Wait until this lands and the convention is proven.
- **Concert / arts performer cards** with `lastfm_artist_id` cross-reference into `attended_event_performers`. Cross-domain join; its own design problem.
- **Year-in-review cards.** `get_year_in_review` is currently text + image blocks. A card would sit on top — but the existing surface works, so it's lower priority.
- **Click-to-open custom handlers** inside cards (e.g. opening Spotify deep links via `app.openLink`).
- **Card refresh-on-stale.** When KV cache is stale (≥ 1h old), the athlete card could optionally show a "refreshing..." state and refetch on mount. Not in scope; v1 is read-once.

## Documents

| File                       | Purpose                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| [TRACKER.md](./TRACKER.md) | Phased task checklist                                                                                 |
| [DESIGN.md](./DESIGN.md)   | Source-of-truth `structuredContent` shapes per tool, KV key conventions, MLB Stats API response shape |
