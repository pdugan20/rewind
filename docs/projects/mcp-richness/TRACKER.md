# MCP Richness -- Task Tracker

Legend: [ ] pending, [x] done, [~] in progress.

## Phase 0: Foundation

Land the shared infrastructure every domain phase depends on.

**0.1 -- SDK bump** -- COMPLETE

- [x] **0.1.1** Bumped 1.12.1 -> 1.29.0. No breaking changes hit the Rewind code in practice; legacy `server.tool` / `server.resource` / `server.prompt` signatures still work. Modern `registerTool` / `registerResource` / `registerPrompt` available for new work. See DESIGN.md.
- [x] **0.1.2** `mcp-server/package.json` updated to `^1.29.0`, `npm install` clean
- [x] **0.1.3** No type errors surfaced; `tsc` builds clean
- [x] **0.1.4** `npm test` passes (40/40) in `mcp-server/`

**0.2 -- Content-block helpers** -- COMPLETE

- [x] **0.2.1** Added `TextBlock` / `ImageBlock` / `ResourceLinkBlock` / `ContentBlock` / `ToolResult<S>` types to `mcp-server/src/tools/helpers.ts`
- [x] **0.2.2** `text(value)` builder
- [x] **0.2.3** `resourceLink(uri, name, opts?)` builder (returns null on empty/null URI)
- [x] **0.2.4** `imageBlock(client, domain, entityType, entityId, size?)` builder (fetches via new `RewindClient.getBinary`, base64-encodes, null on failure). Also added `includeImagesParam` zod input helper for per-tool opt-out.
- [x] **0.2.5** `withRichResponse(fn)` wrapper paralleling `withErrorHandling`
- [x] **0.2.6** 14 unit tests added in `src/__tests__/helpers.test.ts` covering happy path + null/failure paths for every builder and wrapper; existing `withErrorHandling` kept verbatim and covered

**0.3 -- `server.instructions`** -- COMPLETE

- [x] **0.3.1** Added `SERVER_INSTRUCTIONS` constant and passed via `McpServer` options in `src/server.ts`
- [x] **0.3.2** Test added: `exposes server instructions` in `server.test.ts` -- asserts the client sees it, mentions Rewind/domains/resource-link, and is under 2KB

**0.4 -- Smoke test** -- AWAITING USER SESSION

Phase 0 code is complete and all 55 tests pass. The smoke test requires a live Claude Code session.

- [ ] **0.4.1** Run SMOKE-TEST.md Phase 0 checks against a local build connected to Claude Code
- [ ] **0.4.2** Capture terminal emulator name + image-rendering behavior in SMOKE-TEST.md notes
- [ ] **0.4.3** If any policy needs adjusting (image cap, MIME default, token budget), update DESIGN.md before Phase 1 starts

To run the smoke test yourself:

```bash
cd mcp-server && npm run build
claude mcp add --transport stdio rewind-local --env REWIND_API_KEY=<your-key> \
  -- node $(pwd)/dist/index.js
# then in a fresh Claude Code session:
/mcp          # confirm connected, note instructions populated
```

Try these prompts to exercise the new surface:

- "What can the rewind server do?" -- should paraphrase `instructions`
- Any existing tool call (e.g. "get my recent listens") -- should work unchanged since no tool was modified in Phase 0

## Phase 1: Watching (pilot domain) -- CODE COMPLETE

Full Tier 1+2 for watching. Validates the pattern.

**1.1 -- `resource_link` for external URLs** -- COMPLETE

- [x] **1.1.1** `get_movie_details` emits a deduped `resource_link` for every unique `review_url` in `watch_history` (labelled with the watch date)
- [x] **1.1.2** `get_recent_watches` emits a `resource_link` per top-N item for `review_url` where present
- [x] **1.1.3** `browse_movies` emits posters but not Letterboxd links (browse results don't include per-watch `review_url`, only the movie itself). Reconsider in Phase 6 if a watch-history join endpoint appears.

**1.2 -- `structuredContent` on stats/aggregate tools** -- COMPLETE

- [x] **1.2.1** `get_watching_stats` mirrors `/v1/watching/stats` response via `structuredContent`
- [x] **1.2.2** Added `get_watching_genres` wrapping `/v1/watching/stats/genres`
- [x] **1.2.3** Added `get_watching_decades` wrapping `/v1/watching/stats/decades`
- [x] **1.2.4** Added `get_watching_directors` wrapping `/v1/watching/stats/directors` (with `limit` arg)

**1.3 -- `image` content on detail + list tools** -- COMPLETE

- [x] **1.3.1** `get_movie_details` -- poster image (gated by `include_images`, default true)
- [x] **1.3.2** `get_recent_watches` -- top-N=5 posters (gated)
- [x] **1.3.3** `browse_movies` -- top-N=5 posters (gated)

**1.4 -- Entity resources for @-mention** -- COMPLETE

- [x] **1.4.1** Registered `rewind://movie/{id}` resource template -- returns full movie detail JSON
- [x] **1.4.2** Registered `rewind://show/{id}` resource template -- returns full show detail JSON
- [x] **1.4.3** Canonical id scheme: use **internal Rewind database id** (same id that `/v1/watching/movies/{id}` and `/v1/images/watching/movies/{id}/...` accept). TMDB id is nullable so unsuitable as canonical.

**1.5 -- Pilot smoke test** -- DEFERRED TO PROJECT END

Target client clarified mid-phase: primary target is Claude Desktop + iOS, not Claude Code CLI. Live stdio e2e (`src/__tests__/stdio-e2e.live.ts`) verified the server emits spec-correct responses (text + base64 image + resource_link + structuredContent) when called via real MCP protocol. Claude Code CLI tests uncovered UI limitations (image blocks don't render inline, `structuredContent` appears to hide `content`) that are client-side and non-blocking for the target. All Claude Desktop smoke testing batched to end of project per user call.

- [x] **1.5.1** Live stdio e2e confirms server output is spec-compliant; Claude Code quirks out of scope
- [x] **1.5.2** DESIGN.md updated with target-client clarification (Claude Desktop primary, Claude Code dev-only)

## Phase 2: Listening -- COMPLETE

**2.1 -- `resource_link`** -- COMPLETE

- [x] **2.1.1** `get_album_details` emits `apple_music_url` + Last.fm URL as resource_links
- [x] **2.1.2** `get_artist_details` emits `apple_music_url` + Last.fm URL as resource_links
- [x] **2.1.3** `get_recent_listens` emits top-N Apple Music links
- [x] **2.1.4** `get_top_tracks` / `get_top_albums` / `get_top_artists` emit top-N Apple Music links
- [x] **2.1.5** `get_now_playing` emits track/artist Apple Music links + Last.fm link

**2.2 -- `structuredContent`** -- COMPLETE

- [x] **2.2.1** `get_listening_stats` mirrors `/v1/listening/stats` shape (added `registered_date`)
- [x] **2.2.2** `get_listening_streaks` mirrors streaks response
- [x] **2.2.3** `get_top_artists` / `get_top_albums` / `get_top_tracks` -- structured list + period metadata
- [x] **2.2.4** Added `get_listening_genres` wrapping `/v1/listening/genres` (actual route path; earlier tracker said "/genre/over-time")

**2.3 -- `image` content** -- COMPLETE

- [x] **2.3.1** `get_album_details` -- album cover
- [x] **2.3.2** `get_artist_details` -- artist image
- [x] **2.3.3** `get_recent_listens` -- top-N album covers (N=5)
- [x] **2.3.4** `get_top_artists` / `get_top_albums` -- top-N images (tracks skipped; no per-track artwork in API)
- [x] **2.3.5** `get_now_playing` -- current album cover

**2.4 -- Entity resources** -- COMPLETE (2 of 3)

- [x] **2.4.1** `rewind://album/{id}` resource
- [x] **2.4.2** `rewind://artist/{id}` resource
- [ ] **2.4.3** `rewind://track/{id}` resource -- **skipped**: no `/listening/tracks/{id}` endpoint exists in the API. Tracks surface via album detail and search. Reconsider if a dedicated track endpoint ships.

## Phase 3: Collecting -- COMPLETE

- [x] **3.1.1** `get_vinyl_collection` emits top-N `discogs_url` resource_links
- [x] **3.2.1** `get_collecting_stats` mirrors full `/v1/collecting/stats` shape (including estimated_value, most_collected_artist)
- [x] **3.2.2** `get_physical_media_stats` returns `{ total, formats: [...] }` as structuredContent
- [x] **3.2.3** `get_vinyl_collection` / `get_physical_media` return structured list + pagination
- [x] **3.3.1** `get_vinyl_collection` -- top-N covers (N=5), gated by `include_images`
- [x] **3.3.2** `get_physical_media` -- top-N covers (N=5), gated by `include_images`
- [x] **3.4.1** `rewind://vinyl/{id}` resource wrapping `/v1/collecting/vinyl/{id}`
- [x] **3.4.2** `rewind://physical-media/{id}` resource wrapping `/v1/collecting/media/{id}`

## Phase 4: Reading -- COMPLETE

- [x] **4.1.1** `get_recent_reads` emits top-N article `url` resource_links
- [x] **4.1.2** `get_reading_highlights` emits deduped article URLs as resource_links
- [x] **4.1.3** `get_random_highlight` emits the article URL as a resource_link
- [x] **4.2.1** `get_reading_stats` mirrors `/v1/reading/stats`
- [x] **4.2.2** `get_recent_reads` returns structured items + pagination fields where the API includes them
- [x] **4.2.3** `get_reading_highlights` returns structured items + pagination
- [x] **4.3.1** Articles do have `ImageAttachment` when the pipeline has an OG image; `get_recent_reads` emits top-N article images (gated by `include_images`). No separate favicon path.
- [x] **4.4.1** `rewind://article/{id}` resource wrapping `/v1/reading/articles/{id}`
- [ ] **4.4.2** `rewind://highlight/{id}` resource -- **skipped**: no `/v1/reading/highlights/{id}` endpoint in the API. Highlights surface via `get_reading_highlights` listing and via the `highlights` array in an article detail. Reconsider if a dedicated highlight endpoint ships.

## Phase 5: Running -- COMPLETE

- [x] **5.1.1** `get_activity_details` emits `strava_url` as a resource_link
- [x] **5.1.2** `get_recent_runs` emits top-N Strava resource_links
- [x] **5.2.1** `get_running_stats` mirrors lifetime-totals shape (Eddington included)
- [x] **5.2.2** `get_running_streaks` mirrors streaks shape
- [x] **5.2.3** `get_personal_records` returns structured PR list
- [x] **5.2.4** `get_activity_details` mirrors full API activity shape
- [x] **5.2.5** `get_activity_splits` returns `{ activity_id, items: Split[] }`
- [x] **5.2.6** Added `get_running_years` wrapping `/v1/running/stats/years`
- [x] **5.3.1** Skipped per plan: running has no entity-level artwork. Maps/polylines are Tier 3 (MCP Apps) and parked.
- [x] **5.4.1** `rewind://activity/{id}` resource wrapping `/v1/running/activities/{id}`

## Phase 6: Cross-domain -- COMPLETE (code)

- [x] **6.1.1** `search` emits one `resource_link` per match that maps to a registered entity URI via `rewindUri(domain, entity_type, entity_id)`. Unmapped types (e.g. `track`) are skipped silently.
- [x] **6.1.2** `search` emits `structuredContent` with full `items` + `pagination`
- [ ] **6.2.1** `get_feed` -- **skipped for now**: the feed API returns `domain` but not `entity_type`, so we can't reliably map each event to a single entity URI. Structured items are returned so Claude can still introspect. Revisit if/when `entity_type` is added to feed items.
- [x] **6.2.2** `get_feed` emits `structuredContent` with feed items + pagination
- [ ] **6.3.1** `get_on_this_day` -- **skipped** for same reason as 6.2.1 (no entity_type on items)
- [x] **6.3.2** `get_on_this_day` emits `structuredContent` grouped by year

**6.4 -- Project smoke test** -- AWAITING CLAUDE DESKTOP SESSION

- [x] **6.4.1** Smoke-tested in Claude Desktop. Confirmed: image content blocks render inside the collapsed tool-use accordion (not inline in the assistant body -- this is Claude Desktop's UI placement per [open issue #1329](https://github.com/anthropics/anthropic-sdk-python/issues/1329); the protocol works). Fixed a 1MB per-response cap by switching list-tool images to the CDN `/cdn-cgi/image/width=150,...` transform path (22x smaller).
- [x] **6.4.2** `mcp-server/README.md` updated with Rich responses section + Entity resources table; new tools noted. `deploy` script added to `mcp-server/package.json`.
- [x] **6.4.3** Version bumped to `0.2.0` in `package.json` and in the `McpServer` info block. Worker deployed (`mcp.rewind.rest`, version `795dffcc`). `npm publish` is user-triggered: run from `mcp-server/` after `npm login`.

## Post-project additions

- **3 new MCP prompts** (`/mcp__rewind__letterboxd-review-draft`, `/mcp__rewind__training-report`, `/mcp__rewind__film-diet`) shipped in v0.2.0. Test expectation updated from 3 to 6 prompts. Deployed.
- **Image resize helper** (`resizeCdnUrl` in `helpers.ts`) rewrites Rewind CDN URLs to Cloudflare Images transform paths. All list tools (`get_recent_watches`, `browse_movies`, `get_recent_listens`, `get_top_albums`, `get_top_artists`, `get_vinyl_collection`, `get_physical_media`, `get_recent_reads`) now fetch 150px variants to stay under Claude Desktop's 1MB per-response cap. Detail tools (`get_movie_details` etc.) still fetch full-size.

## Additional follow-up work (post-v0.2.0)

Shipped after the initial project close to address gaps surfaced by live use:

**Tool / API alignment** -- earlier MCP schemas advertised `limit: max(50)` on tools that hit API endpoints capped at 20 (`/v1/watching/recent`, `/v1/running/recent`, `/v1/collecting/recent`, `/v1/collecting/media/recent`). Claude's "last month" queries hit 400 Bad Request. Fixes:

- Raised API caps to `max(50)` on all six recent endpoints (`watching`, `running`, `listening`, `reading`, `collecting/recent`, `collecting/media/recent`). Listening + reading were already at 50 but lacked pagination.
- Added `page` query param + offset handling on all six endpoints.
- MCP tool schemas aligned: `max(50)` + `page` input on `get_recent_watches`, `get_recent_runs`, `get_recent_listens`, `get_recent_reads`. Vinyl + physical media MCP tools already used the browse endpoints (capped at 100) and were unaffected.
- OpenAPI snapshot regenerated.

**Dedup** -- `get_recent_watches` now dedupes by `movie.id` (Plex + Letterboxd often log the same film twice). Prefers the entry with a `user_rating`, else the most recent. Underlying API still returns duplicates -- other callers unaffected.

**Star ratings** -- `user_rating` is a 0-5 star scale, not `/10`. Added `formatStars(r)` helper in `helpers.ts`. Updated `get_recent_watches`, `get_movie_details` watch-history lines, `browse_movies`, and the `PosterCard` component (mcp-apps project) to render `4.5★` instead of `4.5/10`. TMDB rating left on its native `/10` scale with `.toFixed(1)`.
