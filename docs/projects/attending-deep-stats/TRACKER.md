# Attending Deep Stats — Task Tracker

Legend: [ ] pending, [x] done, [~] in progress.

Phases ship independently — each delivers verifiable value (a passing test, an admin endpoint returning real data, an inline card in Claude Desktop). Earlier phases gate later ones; within a phase, sub-tasks usually parallelize.

**The hard checkpoint is Phase 4.** Phases 5 and 6 are explicitly gated on Phase 4 outcomes; do not begin them without revisiting this tracker.

## Phase 0: Baseline + coverage audit — pending

Goal: know what we're working with before we ship aggregates that could lie silently. ~half a day.

### 0.1 — Coverage audit script

- [ ] **0.1.1** `scripts/tools/audit-attending-coverage.ts` — for each (season, league, attended) bucket, count `attended_events` rows, count rows with at least one `attended_event_players` row, count rows with `event_data->>'home_score'` populated. Output a table to stdout.
- [ ] **0.1.2** Run against prod (read-only). Capture output to `docs/projects/attending-deep-stats/coverage-baseline.md` so Phase 4 has a comparison anchor.

### 0.2 — Sample-size distribution

- [ ] **0.2.1** Same script, second pass: for each (player_id, season) where the player has any `attended_event_players` row, compute total PAs (hitters) and total BFs (pitchers). Output a histogram so we can see how small "small" actually is.
- [ ] **0.2.2** Use this to validate the `pa < 50` / `bf < 60` thresholds in Decisions; bump them in the README if the distribution suggests a different floor.

### 0.3 — Document current MCP behavior

- [ ] **0.3.1** Run each of the four target queries through Claude Desktop / Claude web today. Capture transcripts (or at minimum, the tool calls the model made and how many turns it took to land on an answer).
- [ ] **0.3.2** Save to `docs/projects/attending-deep-stats/baseline-queries.md`. This is the before-photo for the Phase 4 checkpoint.

## Phase 1: Tier 1 — filter and discovery ergonomics — pending

Goal: the natural-language query "what Mariners games did I attend this season" works end-to-end without the model having to fetch every event and substring-match. ~half a day to a day.

### 1.1 — `team` substring filter on `/v1/attending/events`

- [ ] **1.1.1** Add `team` (string, optional) query param to `eventsRoute` in `src/routes/attending.ts`. Case-insensitive substring match against `event_data->>'home_team'` OR `event_data->>'away_team'`. SQLite `json_extract` + `LIKE` with `LOWER()` on both sides.
- [ ] **1.1.2** Update OpenAPI schema for the route. Document explicitly: substring match, not slug, not team_id; works for any league with `home_team` / `away_team` populated in `event_data`.
- [ ] **1.1.3** Tests: `team=mariners` returns Mariners home + away games; `team=Yankees` returns games at Yankee Stadium where Yankees were either team; case-insensitive verified.
- [ ] **1.1.4** Spec snapshot regenerated via `npm run spec:update`.

### 1.2 — `name` substring filter on `/v1/attending/players`

- [ ] **1.2.1** Add `name` (string, optional) query param to `playersListRoute` in `src/routes/attending.ts`. Case-insensitive substring match against `players.full_name`.
- [ ] **1.2.2** Response shape unchanged; pagination unchanged.
- [ ] **1.2.3** Tests: `name=julio` returns multiple matches; verifies team + position are present in each row so the consumer can disambiguate.
- [ ] **1.2.4** Spec snapshot regenerated.

### 1.3 — MCP tool wrappers

- [ ] **1.3.1** `mcp-server/src/tools/attending.ts` — `get_attended_events` gains `team` parameter, passes through to the API. Update tool description to mention "Filter by team via substring match: 'mariners', 'huskies', etc."
- [ ] **1.3.2** Same file — `get_attended_players` (the list, not the detail) gains `name` parameter. Tool description: "Search by full name substring; multiple matches are common (e.g. 'will smith' returns several MLB players)."
- [ ] **1.3.3** Manifest snapshot regenerated.
- [ ] **1.3.4** Tests on the MCP wrappers (or at minimum, the tool registration unit tests).

### 1.4 — End-to-end sanity check

- [ ] **1.4.1** Locally run the four target queries from Phase 0.3 against the dev MCP server. Capture how many turns each takes after Phase 1 vs the Phase 0 baseline. Ideally "Mariners games this season" goes from 3+ turns to 1.

### 1.5 — Ship

- [ ] **1.5.1** Commit + push. CI green.
- [ ] **1.5.2** Deploy auto-triggered. Verify endpoints live: `curl /v1/attending/events?team=mariners` returns expected shape.

## Phase 2: Tier 2 pilot — `/v1/attending/players/:id/stats` — pending

Goal: aggregate per-player stat lines for one season, MLB-only, with sample-size disclosure and coverage metadata baked into the response. ~1–2 days.

### 2.1 — Lock in response shape

- [ ] **2.1.1** Document the full response shape in `docs/projects/attending-deep-stats/DESIGN.md` (new file). Two variants — hitter and pitcher — discriminated by player primary position.
- [ ] **2.1.2** Hitter shape: `{ supported: true, league: 'mlb', games_attended: N, games_with_box_score: M, batting: { pa, ab, h, hr, rbi, bb, k, avg, obp, slg }, sample_size_warning: bool, coverage_warning: bool }`.
- [ ] **2.1.3** Pitcher shape: `{ supported: true, league: 'mlb', games_attended: N, games_with_box_score: M, pitching: { games, ip, h, r, er, bb, k, hr, era, whip, wins, losses, saves, holds, blown_saves }, sample_size_warning: bool, coverage_warning: bool }`.
- [ ] **2.1.4** Non-MLB shape: `{ supported: false, league: '<league>', reason: 'box-score parsing not yet supported for this league', appearances: [...] }` where appearances list is the existing per-event entries from `attended_event_players`.

### 2.2 — Aggregation service

- [ ] **2.2.1** `src/services/attending/player-stats.ts` exports `aggregatePlayerStats(db, playerId, season): Promise<PlayerStatsResponse>`.
- [ ] **2.2.2** Reads `attended_event_players` joined to `attended_events` and `players`. Filters to `attended=1` and `attended_events.event_type` matches `<league>_game` for the player's primary `league`.
- [ ] **2.2.3** Reduces JSON `batting_line` / `pitching_line` blobs into accumulator. Recomputes ratios at the end.
- [ ] **2.2.4** Sample-size flag: `sample_size_warning = pa < 50` (hitters) or `bf < 60` (pitchers). Bumpable from Phase 0.2 distribution if needed.
- [ ] **2.2.5** Coverage flag: `coverage_warning = games_with_box_score / games_attended < 0.8`.
- [ ] **2.2.6** Unit tests with seeded fixtures: hitter normal, hitter small-sample, pitcher normal, pitcher with decisions, non-MLB player returns `supported: false`, player with no attended games returns `games_attended: 0`.

### 2.3 — Route handler

- [ ] **2.3.1** Add `playerStatsRoute` to `src/routes/attending.ts`. Path `/players/{id}/stats`, query `season` (required, integer).
- [ ] **2.3.2** OpenAPI schema with full response variants documented (Zod discriminated union or a simple `z.object({ supported: ... })` union).
- [ ] **2.3.3** Cache `medium` (1h).
- [ ] **2.3.4** Route tests: 200 with hitter shape, 200 with pitcher shape, 200 with `supported: false` for non-MLB, 404 for unknown player, 400 for invalid season.

### 2.4 — MCP tool wrapper

- [ ] **2.4.1** New `get_attended_player_stats` tool in `mcp-server/src/tools/attending.ts`. Required params: `player_id`, `season`. Tool description: "Aggregate stats for one player at games you attended in one season. MLB only. Returns slash line for hitters / ERA + decisions for pitchers, with sample-size and coverage warnings."
- [ ] **2.4.2** Text rendering: include the warnings in the prose so the model picks them up. Example: "Julio Rodriguez at games you attended in 2025: .276/.348/.512 in 25 games (174 PAs). 2 missing box scores."
- [ ] **2.4.3** Manifest snapshot regenerated.

### 2.5 — End-to-end sanity check

- [ ] **2.5.1** Run "what's Julio's batting average at games I've attended this year" through Claude Desktop. Verify the model picks `get_attended_player_stats`, gets the right shape, and includes the sample size in its response prose.
- [ ] **2.5.2** Run "how many times have I seen Kirby pitch" — should still work via `get_attended_player` (existing); the new stats tool also returns the count. Validate the model picks the right tool.

### 2.6 — Ship

- [ ] **2.6.1** Spec snapshot regenerated.
- [ ] **2.6.2** Commit + push. CI green.
- [ ] **2.6.3** Deploy auto-triggered. Verify live.

## Phase 3: UI pilot — game card on `get_attended_event` — pending

Goal: when the user asks about a single game, the response renders an interactive card inline (in MCP Apps clients) with linescore, top performers, and ticket info. ~2–4 days.

### 3.1 — Design

- [ ] **3.1.1** `docs/projects/attending-deep-stats/DESIGN.md` gains a `## Game card` section: hero (date, opponent, venue, final score), linescore, top 3 performers from this user's perspective (notable=true rows, sorted by some signal), ticket section/row/seat block.
- [ ] **3.1.2** Sketch (text or rough HTML) committed.
- [ ] **3.1.3** Confirm `get_attended_event` already returns enough structuredContent to drive the card. If not, list deltas needed before building.

### 3.2 — Vite entry

- [ ] **3.2.1** `mcp-server/web/attended-event.html` — `<div id="root">` + module script.
- [ ] **3.2.2** `mcp-server/web/attended-event.tsx` — root component using `useApp()` from `@modelcontextprotocol/ext-apps/react`.

### 3.3 — Card component

- [ ] **3.3.1** `mcp-server/web/components/GameCard.tsx` — hero (date / matchup / final), linescore (per-inning for MLB if available; otherwise just final), performers panel.
- [ ] **3.3.2** Uses thumbhash placeholders for player photos before `cdn_url` loads (matches existing `PosterCard` pattern).
- [ ] **3.3.3** Empty state for non-sports events (concerts/theater) — render the venue + ticket block only, no linescore.
- [ ] **3.3.4** Click handlers: opening a player photo links to `/v1/attending/players/:id` (via `app.openLink`).

### 3.4 — Wire into MCP tool

- [ ] **3.4.1** `mcp-server/src/tools/attending.ts` — `get_attended_event` migrates to `server.registerTool` form (if not already) with `_meta.ui.resourceUri = ui://rewind/attended-event.html`.
- [ ] **3.4.2** Register the UI resource in `mcp-server/src/resources/ui.ts`. CSP allowlist for `cdn.rewind.rest` (player photos + venue images).
- [ ] **3.4.3** Build pipeline: `INPUT=attended-event.html npm run build:web`. Verify `web/dist/attended-event.html` exists and is single-file.
- [ ] **3.4.4** Inline-bundles script picks up the new entry; `src/ui-bundles.ts` regenerated.

### 3.5 — Smoke test

- [ ] **3.5.1** Local `npm run dev` against the MCP server. Hit `get_attended_event` with a real event id (e.g. a recent Mariners game with stat lines). Card renders.
- [ ] **3.5.2** Build + deploy worker to staging or preview. Test in Claude Desktop, Claude web, and Claude iOS with a real query — "tell me about my last Mariners game." All three should render the card inline.
- [ ] **3.5.3** Verify non-MCP-Apps clients (e.g. text-only CLI) still see the existing rich response unchanged.

### 3.6 — Ship

- [ ] **3.6.1** Bundle visible in `mcp-server/web/dist/`. Inlined into `src/ui-bundles.ts`.
- [ ] **3.6.2** Commit + push. CI green. Worker deploy auto-triggered.
- [ ] **3.6.3** Verify card renders in production Claude Desktop, Claude web, and Claude iOS.

## Phase 4: ITERATION CHECKPOINT — pending

**This is a hard gate.** Do not begin Phase 5 or 6 without completing Phase 4. ~half a day, plus ≥ 1 week of real-conversation usage between Phase 3 ship and this review.

### 4.1 — Live usage requirement

- [ ] **4.1.1** Run ≥ 5 distinct natural-language queries via Claude Desktop, Claude web, or Claude iOS over ≥ 1 week of real conversation. Capture screenshots or transcripts. iOS coverage matters because the card pipeline now ships there too — at least one query should be tested on iOS to confirm the inline render works in production.
- [ ] **4.1.2** At least one query per category: a team filter ("Mariners games"), a player stat ("Julio's average"), a count ("how many times Kirby"), a single-game card render ("tell me about my last game"), and one query you didn't anticipate during planning.

### 4.2 — Document outcomes

- [ ] **4.2.1** New file `docs/projects/attending-deep-stats/CHECKPOINT.md`. For each captured query: which tool the model picked, how many turns, whether the response felt useful, whether the card rendered, surprises.
- [ ] **4.2.2** Sample-size warning behavior — did the model actually cite the warning when relevant, or ignore it? If ignored, the warning shape needs work.
- [ ] **4.2.3** Coverage warning behavior — same question.
- [ ] **4.2.4** Tool-count signal — did the model reach for `get_attended_player_stats` when it should have, or default to `get_attended_player`? If the latter, the new tool's description needs work, or we should fold it into the existing tool as a flag.

### 4.3 — Decide go/no-go on remaining phases

- [ ] **4.3.1** **Phase 5 (team stats)** — go if the user asked team-perspective questions during Phase 4.1 ("how have the Mariners done at games I attended") and the model couldn't answer well. Skip if the queries didn't come up or compose adequately from per-player + per-event data.
- [ ] **4.3.2** **Phase 6 (more UI cards)** — go if the game card from Phase 3 actually renders in real conversation and the user finds it valuable. Skip if the user mostly uses CLI / non-Apps clients, or if the card felt redundant with prose.
- [ ] **4.3.3** **Pivot option: NFL/NBA box-score parsers.** If Phase 4 reveals the user keeps asking about non-MLB games where Tier 2 returns `supported: false`, the next project may be sports-leagues parity in `services/sports/` rather than continuing here.
- [ ] **4.3.4** Decisions captured at the bottom of CHECKPOINT.md with date + reason.

### 4.4 — Update README + TRACKER

- [ ] **4.4.1** Mark Phase 4 status; explicitly state which of Phase 5 / 6 are go vs deferred.
- [ ] **4.4.2** If deferring, move deferred work into the README's Follow-up projects section with a brief rationale.

## Phase 5: Tier 2 expansion — `/v1/attending/teams/:team_id/stats` — GATED ON PHASE 4

Goal: fan-perspective totals for a team in a season — W/L in person, total HRs, runs, ERA, batters faced. ~1 day.

(Detailed task list will be filled in during Phase 4 once the response shape decisions are informed by real usage. Expected sub-phases: design + endpoint + tests + MCP wrapper + ship, mirroring Phase 2's structure.)

- [ ] **5.1** Lock in response shape — depends on Phase 4 findings. Probably `{ team, season, games_attended, wins, losses, no_shows, team_hrs, total_hrs_in_attended_games, runs_for, runs_against, top_performers: [...] }`.
- [ ] **5.2** Aggregation service `src/services/attending/team-stats.ts`.
- [ ] **5.3** Route handler — `/teams/{team_id}/stats?season=N`.
- [ ] **5.4** MCP tool wrapper — `get_attended_team_stats` (or fold into existing `get_attended_season` as expanded data).
- [ ] **5.5** Tests + spec + ship.

## Phase 6: UI expansion — player + team season cards — GATED ON PHASE 4

Goal: ship one or two more UI cards if Phase 4 says they'd get used. ~3–5 days.

(Detailed task list filled in during Phase 4. Expected sub-phases: design + Vite entries + components + tool wiring + smoke test + ship, mirroring Phase 3's structure.)

- [ ] **6.1** Player stats card — renders on `get_attended_player_stats`. Photo + slash line + HR list.
- [ ] **6.2** Team season card — renders on `get_attended_team_stats`. Like the existing season-grid but team-scoped, with HR / run / ERA totals.
- [ ] **6.3** CSP allowlists, build pipeline, smoke tests, ship.

## Phase 7: Polish, deploy, close-out — pending

Catches anything that surfaced during execution. ~half a day.

- [ ] **7.1** Update root `README.md` and `docs-mintlify/domains/attending.mdx` if any user-facing endpoints changed.
- [ ] **7.2** Update `mcp-server/README.md` Tools table with new MCP tools shipped.
- [ ] **7.3** Add a changelog entry summarizing what shipped vs what was deferred at the Phase 4 checkpoint.
- [ ] **7.4** Move project into `docs/projects/archived/` once everything is done or deferred to follow-ups.
- [ ] **7.5** Open follow-up GitHub issues for any deferred work (NFL/NBA box-score parsers, teams table, additional cards) so they don't get lost.
