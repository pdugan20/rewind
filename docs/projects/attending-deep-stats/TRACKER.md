# Attending Deep Stats — Task Tracker

> **Reconciled 2026-08-11:** core shipped work is preserved here. Current
> expansion work is tracked in GitHub #67–#69; gated Phase 5/6 ideas below are
> not independently active unless re-scoped into a current issue.
> Legend: [ ] pending, [x] done, [~] in progress.

Phases ship independently — each delivers verifiable value (a passing test, an admin endpoint returning real data, an inline card in Claude Desktop). Earlier phases gate later ones; within a phase, sub-tasks usually parallelize.

**The hard checkpoint is Phase 4.** Phases 5 and 6 are explicitly gated on Phase 4 outcomes; do not begin them without revisiting this tracker.

## Phase 0: Baseline + coverage audit — DONE

Goal: know what we're working with before we ship aggregates that could lie silently. ~half a day.

Executed in-band rather than as a permanent script — the Python audit ran once against prod via `api.rewind.rest`, output captured to `coverage-baseline.md`. The audit forced two design changes (now reflected in DESIGN.md and README's Decisions table): `season` becomes optional with default = career, and the `sample_size_warning` boolean is dropped in favor of always-included raw `pa`/`bf`/`games`.

### 0.1 — Coverage audit — DONE

- [x] **0.1.1** Audit ran against prod via `api.rewind.rest`. Per-season MLB box-score coverage table captured to `coverage-baseline.md`. **Result: 84% overall coverage.** 38 of 45 attended MLB games have `attended_event_players` rows. Recent seasons (2023–2026) hover 75–89%; one 2019 game has zero coverage.
- [x] **0.1.2** Output committed to `docs/projects/attending-deep-stats/coverage-baseline.md`.

### 0.2 — Sample-size distribution — DONE

- [x] **0.2.1** Per-(player, season) PA + BF histograms captured to `coverage-baseline.md`. **Result**: 88.8% of (hitter, season) pairs are 1–10 PAs; 0% are over 50. 63.8% of (pitcher, season) pairs are 1–10 BFs; 1.3% are 61–120, 0% are over 120. Single-season slices are tiny.
- [x] **0.2.2** **Validated thresholds were way too high.** Pivoted away from a boolean warning entirely (would always fire). Instead: response always includes `pa`/`bf`/`games`; tool description tells the model to cite them. `season` query param also flipped from required to optional, defaulting to career — that's where the meaningful per-player samples live (Cal Raleigh 130 PAs / 32 games; Kirby 238 BFs / 10 starts).

### 0.3 — Document current MCP behavior — partial (user action)

- [x] **0.3.1** Template captured to `baseline-queries.md` with the four target queries + a "bonus query" slot. **Action required from user**: run the queries through Claude Desktop / web / iOS and paste transcripts. Phase 1–3 do not block on this; Phase 4 checkpoint needs it.
- [x] **0.3.2** `baseline-queries.md` committed.

## Phase 1: Tier 1 — filter and discovery ergonomics — DONE

Goal: the natural-language query "what Mariners games did I attend this season" works end-to-end without the model having to fetch every event and substring-match.

### 1.1 — `team` + `team_id` filter on `/v1/attending/events` — DONE

- [x] **1.1.1** Added `team` (string) AND `team_id` (integer) query params. `team` is case-insensitive substring against `json_extract(event_data, '$.home_team.name')` and `$.away_team.name`. `team_id` is exact match against `$.home_team.id` and `$.away_team.id`. Both shipped together (both come free from the same JSON-extract).
- [x] **1.1.2** OpenAPI schema updated with explicit description: substring matches against either side; team_id uses league-native ids (MLB Stats id for MLB, ESPN id for ESPN-driven leagues).
- [x] **1.1.3** Six tests in `src/routes/attending.test.ts`: substring matches both home/away; case-insensitive; cross-league; team_id by integer; combines with other filters; returns empty when no match.
- [x] **1.1.4** Spec snapshot regenerated via `npm run spec:update`.

### 1.2 — `name` substring filter on `/v1/attending/players` — DONE

- [x] **1.2.1** Added `name` (string, optional) query param to `playersListRoute`. Case-insensitive substring match on `players.full_name`.
- [x] **1.2.2** Response shape unchanged; pagination unchanged.
- [x] **1.2.3** Three tests: case-insensitive match, multi-hit disambiguation (two "Will Smith"s differ by `primary_position` + `primary_team_id`), combines with `league` filter.
- [x] **1.2.4** Spec snapshot regenerated.

### 1.3 — MCP tool wrappers — DONE

- [x] **1.3.1** `get_attended_events` gains `team` + `team_id` parameters with descriptive help text steering the model to use `team` for natural language ("mariners", "huskies") and `team_id` for stable lookups.
- [x] **1.3.2** **NEW MCP tool** `get_attended_players` (list/search, plural) added — the existing tool was only `get_attended_player` (singular by id). New tool wraps the players list endpoint with name/league/team_id filters; tool description steers the model to disambiguate via `primary_team_id` + `primary_position` on each result. Tool count: 46 → 47.
- [x] **1.3.3** Manifest snapshot regenerated. `server.test.ts` count assertion bumped 46 → 47.
- [x] **1.3.4** All 99 MCP tests pass; full root suite 936/936 passes.
- [x] **1.3.5** `docs-mintlify/mcp-server.mdx` Attending accordion gains a row for `get_attended_players`.

### 1.4 — End-to-end sanity check — partial (deferred to Phase 4)

- [ ] **1.4.1** Live conversational verification against Claude Desktop / web / iOS deferred to Phase 4 alongside the broader checkpoint. Tests prove the API behavior; real model behavior validated end-to-end at Phase 4.

### 1.5 — Ship — DONE

- [x] **1.5.1** Commit + push (single commit covering routes + tests + MCP tools + mintlify mdx + spec snapshot).
- [x] **1.5.2** Deploy auto-triggered on CI green; live endpoints verified.

## Phase 2: Tier 2 pilot — `/v1/attending/players/:id/stats` — DONE

Goal: aggregate per-player stat lines, MLB-only, with sample-size disclosure baked into the response.

### 2.1 — Lock in response shape — DONE

- [x] **2.1.1** Documented in [DESIGN.md](./DESIGN.md). Three variants (hitter, pitcher, unsupported), discriminated by `supported` + (`hitter`/`pitcher`/—).
- [x] **2.1.2** Hitter shape: `{ supported: true, hitter: true, league: 'mlb', scope, season?, player, games, games_with_box_score, batting: { pa, ab, r, h, doubles, triples, hr, rbi, bb, k, sb, hbp, total_bases, avg, slg } }`. **OBP omitted** because `sf` (sacrifice flies) is not stored — see DESIGN.md.
- [x] **2.1.3** Pitcher shape: `{ supported: true, pitcher: true, league: 'mlb', scope, season?, player, games, games_with_box_score, pitching: { ip, bf, h, r, er, bb, k, hr, pitches, strikes, era, whip, decisions: { w, l, sv, hld, bs } } }`.
- [x] **2.1.4** Non-MLB shape: `{ supported: false, league, reason, scope, season?, player, appearances: [{ event_id, event_date, title, home_team, away_team, final_score, my_team_won }] }`.

### 2.2 — Aggregation service — DONE

- [x] **2.2.1** `src/services/attending/player-stats.ts` exports `aggregatePlayerStats(db, playerId, season?)`. Single-query loads player + attended-event appearances joined to events; in-process aggregation.
- [x] **2.2.2** Filters to `attended=1` (no-shows excluded). When `season` is set, filters by `event_data.season` via json_extract.
- [x] **2.2.3** Reduces JSON blobs into accumulators. AVG/SLG/ERA/WHIP recomputed from totals (not averaged from per-game rates). IP uses outs-math (`6.2 + 0.1 = 7.0`, not 6.3) — `parseIpToOuts`/`formatIp` helpers exported for tests.
- [x] **2.2.4** **Boolean warnings dropped per Phase 0 audit.** Response always includes raw `pa`/`bf`/`games`; tool description tells the model to cite them.
- [x] **2.2.5** Coverage signal exposed via `games_with_box_score < games`; MCP wrapper formats it as a "Note: N of M attended games lack box-score data" line when partial.
- [x] **2.2.6** 10 service tests in `src/services/attending/player-stats.test.ts`: IP outs-math (parse + format + round-trip across third-out wraparound), hitter career, hitter season slice, pitcher career with decisions/ERA/WHIP, non-MLB → supported:false with appearance summaries, unknown player → throws PlayerNotFoundError, no-show games excluded from aggregates.

### 2.3 — Route handler — DONE

- [x] **2.3.1** `playerStatsRoute` in `src/routes/attending.ts`. Path `/players/{id}/stats`. **`season` is optional** (Phase 0 design pivot — career is the meaningful default).
- [x] **2.3.2** OpenAPI schema as `z.union([HitterStatsSchema, PitcherStatsSchema, UnsupportedStatsSchema])`. Description in route walks the model through career-by-default and the small-sample reality.
- [x] **2.3.3** Cache `medium` (1h).
- [x] **2.3.4** 4 route tests: 404 for unknown player; hitter shape with career scope by default; respects `?season` for single-season slice; `supported: false` for non-MLB with appearance summaries.

### 2.4 — MCP tool wrapper — DONE

- [x] **2.4.1** New `get_attended_player_stats` tool in `mcp-server/src/tools/attending.ts`. Required `id`, optional `season`. Description steers career-by-default, small-sample warning, MLB-only.
- [x] **2.4.2** Text rendering branches on hitter vs pitcher vs unsupported. Hitter prose: `"Cal Raleigh across all attended games — 32 attended games, 130 PAs. Slash: .295 / .452 (AVG / SLG; OBP not stored). Counting: ..."`. Pitcher prose: `"George Kirby across all attended games — 10 attended games, 238 BF. 65.1 IP, 24 ER, 71 K, 12 BB. 3.31 ERA, 1.10 WHIP. Decisions: 4W-3L"`. Includes coverage note when partial.
- [x] **2.4.3** Manifest snapshot regenerated. Tool count 47 → 48. `server.test.ts` count assertion bumped.
- [x] **2.4.4** `docs-mintlify/mcp-server.mdx` Attending accordion gains a row for `get_attended_player_stats`.

### 2.5 — End-to-end sanity check — partial (deferred to Phase 4)

- [ ] **2.5.1** Live conversational verification via Claude Desktop / web / iOS deferred to Phase 4 alongside the broader checkpoint. Tests prove the API behavior; real model behavior validated end-to-end at Phase 4.

### 2.6 — Ship — DONE

- [x] **2.6.1** Spec snapshot regenerated.
- [x] **2.6.2** Commit + push.
- [x] **2.6.3** Deploy auto-triggered on CI green.

## Phase 3: UI pilot — game card on `get_attended_event` — DONE (modulo client smoke test)

Goal: when the user asks about a single game, the response renders an interactive card inline (in MCP Apps clients) with linescore, top performers, and ticket info.

### 3.1 — Design — DONE

- [x] **3.1.1** Card sections locked in via the implementation: hero (date + venue + result badge), scoreboard with team names/scores (`my_team` emphasized), MLB per-inning linescore (table, scrolls horizontally on narrow widths), notable performers (with silo headshots, decision badges, stat-line summary from `summary` field), ticket block (single ticket spells out section/row/seat + price; multi-ticket summarizes count + total).
- [x] **3.1.2** Implementation IS the spec at this point — see `mcp-server/web/components/GameCard.tsx`.
- [x] **3.1.3** Confirmed during Phase 0 audit that `get_attended_event` returns linescore + players[] + venue + tickets — no API-shape changes needed.

### 3.2 — Vite entry — DONE

- [x] **3.2.1** `mcp-server/web/attended-event.html` created.
- [x] **3.2.2** `mcp-server/web/attended-event.tsx` — `useApp()` + `useHostStyles()`, listens to `app.ontoolresult` for the EventDetail payload.

### 3.3 — Card component — DONE

- [x] **3.3.1** `mcp-server/web/components/GameCard.tsx` — Scoreboard, Linescore, PerformerRow, TicketBlock subcomponents.
- [x] **3.3.2** Thumbhash placeholders via `lib/thumbhash.js`, fades in CDN photo on load.
- [x] **3.3.3** Non-sports events: scoreboard hides (no scores), linescore hides, ticket + venue + notable-performers blocks remain (concert performer photos and ticket info still useful).
- [ ] **3.3.4** Click handlers (opening player photo via `app.openLink`) deferred — Phase 6 territory; the card today is read-only. Not blocking Phase 4 evaluation.

### 3.4 — Wire into MCP tool — DONE

- [x] **3.4.1** `get_attended_event` migrated from `server.tool` → `server.registerTool` form with `_meta.ui.resourceUri = ui://rewind/attended-event.html`.
- [x] **3.4.2** UI resource registered in `mcp-server/src/server.ts` via `registerUiResource()` with CSP `resourceDomains: ['https://cdn.rewind.rest']` for player + venue photos.
- [x] **3.4.3** `npm run build:web` produced `web/dist/attended-event.html` (458,875 chars single-file).
- [x] **3.4.4** Inline-bundles script auto-discovers `web/*.html` entries; `src/ui-bundles.ts` regenerated.

### 3.5 — Smoke test — partial (deferred to user)

- [ ] **3.5.1** Local `mint dev` doesn't apply (MCP Apps sandbox is the host's iframe, not Mintlify). Worker deploy ships the bundle; first real verification is the next bullet.
- [ ] **3.5.2** **Action required from user**: post-deploy, test in Claude Desktop, Claude web, and Claude iOS with a real query — "tell me about my last Mariners game." Card should render inline. Capture transcripts to `baseline-queries.md` (rolled into the Phase 4 checkpoint).
- [x] **3.5.3** Non-MCP-Apps fallback verified by code path: `withRichResponse` returns the same text + structuredContent regardless of `_meta.ui.resourceUri`; only the iframe rendering is gated on the host.

### 3.6 — Ship — DONE

- [x] **3.6.1** Bundle in `mcp-server/web/dist/attended-event.html`. Inlined into `src/ui-bundles.ts`.
- [x] **3.6.2** Commit + push.
- [x] **3.6.3** Deploy auto-triggered on CI green.

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
