# Project: Attending Deep Stats

Turn the existing attending domain into a queryable, fan-perspective analytic surface for natural-language questions like "what Mariners games have I attended this season," "how many home runs have the Mariners hit at games I attended," "what's Julio's batting average at games I've attended this year," and "how many times have I seen Kirby pitch."

The underlying data is mostly already on disk — `attended_event_players` carries per-game `batting_line` / `pitching_line` JSON parsed from MLB box scores, and each event's `event_data` carries `home_team` / `away_team` / scores. The gaps are query shape (no team filter on `/events`), aggregation (model has to fetch every game and sum client-side), and UI (only the season grid renders inline today; everything else is text + accordion images).

## Motivation

Five concrete things this unlocks:

1. **Natural-language fan queries** in Claude Desktop / Claude web that today either fail or require the model to fetch and aggregate over many JSON blobs:
   - "Which Mariners games did I attend this season?"
   - "How many HRs have my teams hit in person this year?"
   - "What's Julio's slash line at games I've attended?"
   - "How many times have I seen Kirby pitch?"
2. **Sample-size-honest stats**. "Julio at games I attended" might be 80–150 PAs — small. The aggregate endpoint returns the slash line with `pa: 132` alongside it so the model can phrase results as `5 hits in 23 AB` when the sample is too small to express as `.250`.
3. **Per-game game card** rendered inline on `get_attended_event` — linescore, top performers, attendance metadata, ticket section/row/seat. Highest fanout in the attending tool surface; every event detail call benefits.
4. **Player stats card** rendered inline on the new `/players/:id/stats` endpoint — photo, slash line, HR list, decisions for pitchers. The "Julio at my games" answer becomes a chart, not prose.
5. **Validates the data depth bet**. We've spent real effort on box-score enrichment + ESPN player-id resolution; this project is the consumer that proves the depth was worth it. If the natural-language queries don't actually feel useful after Phase 3, the project tells us to stop building UI and instead invest in NFL/NBA box-score parsers (i.e. _breadth_ rather than _depth_).

## Status

Branch TBD (likely `worktree-attending-deep-stats`).

| Phase | Status                                                                 |
| ----- | ---------------------------------------------------------------------- |
| 0     | Baseline + coverage audit — pending                                    |
| 1     | Tier 1: filter and discovery ergonomics — pending                      |
| 2     | Tier 2 pilot: `/players/:id/stats` endpoint (MLB-only) — pending       |
| 3     | UI pilot: game card on `get_attended_event` — pending                  |
| 4     | **ITERATION CHECKPOINT** — review, document learnings, decide go/no-go |
| 5     | Tier 2 expansion: `/teams/:team_id/stats` — gated on Phase 4 outcome   |
| 6     | UI expansion: player stats card + team season card — gated on Phase 4  |
| 7     | Polish, deploy, close-out                                              |

The hard checkpoint after Phase 3 exists because the value of Phases 5 and 6 depends on whether the model actually reaches for the new endpoints + cards in real conversation, and whether the queries the user asks lean MLB-specific (Phase 5+ continues) or cross-league (pivot to NFL/NBA box-score parsers instead).

## Scope

In scope:

- **Tier 1**: `team` substring filter on `/events`; `name` substring filter on `/players`. Both are case-insensitive, use existing schema, no new tables.
- **Tier 2 pilot**: `GET /v1/attending/players/:id/stats?season=N` — MLB-only response shape with hitter slash line + counting stats + per-game appearance summary, or pitcher line + decisions, depending on the player's primary position. Sample-size disclosure (`pa`, `bf`, `games`) baked into the response so consumers (including the model) can phrase results honestly. Cached medium (1h).
- **UI pilot**: Game card rendered inline on `get_attended_event` via MCP Apps. React + Vite, follows the existing `attended-season` pattern.
- **MCP tool updates** to expose Tier 1 filters via `get_attended_events` and the new endpoint via `get_attended_player_stats` (or a flag on the existing `get_attended_player` — decided in Phase 2).
- **Iteration gate**. After Phase 3 ships, run real natural-language queries against the MCP server for ≥ 1 week, document what worked and didn't, then decide what (if any) of Phases 5–6 are worth shipping.
- **Tier 2 expansion (gated)**: `/teams/:team_id/stats` — fan-perspective totals (W/L in person, total HRs, runs, ERA, batters faced).
- **UI expansion (gated)**: player stats card + team season card.

Out of scope:

- **NFL / NBA / WNBA / NCAAF / NCAAB box-score enrichment.** Per-player stat lines for non-MLB games would require ESPN box-score parsers in `services/sports/`. Tier 2 endpoints return MLB-only data; non-MLB players get a coverage-disclosure response (`{ supported: false, reason: "league not supported", appearances_only: [...] }`) rather than empty stats that look real.
- **Teams table.** The team filter in Phase 1 is a substring match against `event_data.home_team` / `event_data.away_team` text. A real teams table (with slug, league, official ESPN/MLB ids) is its own follow-up project — useful but not on the critical path for the natural-language queries.
- **Live game enrichment.** Box-score data is pulled after games are played. Game cards always show finals, never in-progress.
- **Multi-season aggregation.** `/players/:id/stats` is `?season=N` only; there is no `/players/:id/stats?seasons=2023,2024,2025` rollup. If multi-season is wanted later, it composes from per-season responses on the consumer side (model or chart).
- **Concert / arts perspective stats.** "Most-seen artist," "longest concert streak," etc. are interesting but use a different join shape (`attended_event_performers`, not `attended_event_players`) and warrant their own project. Cross-domain artist linking via `lastfm_artist_id` is out of scope.
- **Backfilling missing box scores.** Phase 0 surfaces coverage gaps but does not fix them; gaps are disclosed in API responses (`games_with_box_score: 25, total: 30`) so consumers know when an aggregate is partial.

## Architecture

### What's already on disk

```text
attended_events            -- canonical event row, event_data JSON has home_team/away_team/scores
attended_event_players     -- many-to-many: per-game per-player batting_line / pitching_line / decision
players                    -- bio data: name, position, team, photos
attended_event_tickets     -- section / row / seat / total
venues                     -- venue catalog
```

### New surface

```text
GET /v1/attending/events?team=mariners         -- Phase 1
GET /v1/attending/players?name=julio            -- Phase 1
GET /v1/attending/players/:id/stats?season=N    -- Phase 2 (MLB-only)
GET /v1/attending/teams/:team_id/stats?season=N -- Phase 5 (gated)

ui://rewind/attended-event.html                 -- Phase 3 (game card)
ui://rewind/player-stats.html                   -- Phase 6 (gated)
ui://rewind/team-season.html                    -- Phase 6 (gated)
```

### Where each piece lives

```text
src/routes/
  attending.ts                   -- adds team query param + new endpoint handlers
src/services/attending/
  player-stats.ts                -- new: per-player aggregate from attended_event_players
  team-stats.ts                  -- new (Phase 5): per-team aggregate from event_data + attended_event_players

mcp-server/src/tools/
  attending.ts                   -- adds team filter to get_attended_events; new get_attended_player_stats tool

mcp-server/web/
  attended-event.html             -- new: game card entry
  attended-event.tsx              -- new: game card root
  components/GameCard.tsx         -- new: linescore + top performers + ticket info
  player-stats.html / .tsx        -- Phase 6 (gated)
  team-season.html / .tsx         -- Phase 6 (gated)
```

### Data flow per `/players/:id/stats?season=2025` request

1. Look up player by id; reject if not found.
2. Query `attended_event_players` joined to `attended_events`, scoped to (`player_id`, `season=2025`, `attended=1`).
3. Reduce JSON `batting_line` blobs into one summary: sum AB / H / HR / RBI / BB / K, recompute AVG / OBP / SLG. Same shape for pitchers (sum IP / H / R / ER / K / BB, recompute ERA / WHIP, count decisions).
4. Compute coverage metadata: `games_attended: 30, games_with_box_score: 25, sample_size_warning: false` (or `true` when `pa < 50` for hitters / `bf < 60` for pitchers).
5. Cache 1h.

### Data flow for the game card

1. `get_attended_event` returns text + structuredContent + image blocks (existing).
2. Tool advertises `_meta.ui.resourceUri = ui://rewind/attended-event.html`.
3. Card consumes `structuredContent.event_data` (linescore + scores), `structuredContent.players` (top performers from this user's perspective), and `structuredContent.tickets` (section / row / seat).
4. Renders inline in clients that support MCP Apps; non-Apps clients see the existing rich response unchanged.

## Decisions

These lock in the open questions raised during planning. Defaults are picked; flag during implementation if any need to change.

| Decision                                                                                  | Why                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 ships a `team` substring filter, not `team_id` integer or `team` slug             | No teams table exists today. Substring match against `event_data.home_team` / `away_team` text works for every league we have data for, costs zero schema, and matches how the user actually phrases queries ("mariners," not "team_id=136"). A real teams table is its own follow-up.                                 |
| Tier 2 endpoints are MLB-only; non-MLB returns `{ supported: false }`                     | `attended_event_players` has stat lines only for MLB games. Returning empty for NFL would silently look like "the player has zero stats" rather than "we don't have the data." Explicit `supported: false` lets the model phrase the response correctly.                                                               |
| `/players/:id/stats?season=N` is required-param, not default-current-year                 | Avoids confusion when "this year" is January and the season hasn't started. Forces the consumer (including the model) to be explicit about the window.                                                                                                                                                                 |
| "At games I attended" means `attended=1` only, not `attended=0` no-shows                  | Symmetry with the seasons endpoint's existing W/L semantics. A no-show ticket means the user didn't see the player, so it shouldn't count toward "Julio at my games." Documented explicitly in the route description so the model phrases queries correctly.                                                           |
| "Mariners HRs" means HRs hit by either team in games where Seattle was playing            | Matches the natural-language framing — when someone says "the Mariners hit 4 home runs at the games I attended," they typically mean Seattle batters. But "in games I attended" is the broader cut, useful for context. Endpoint returns both: `team_hrs`, `total_hrs_in_attended_games`. Same shape for runs, K, etc. |
| Sample-size warning fires at `pa < 50` for hitters, `bf < 60` for pitchers                | These are loose thresholds — under 50 PAs the slash line is dominated by 1-2 hot games. The endpoint returns the line regardless, but flags it so the model can say "Julio in a small 38-PA sample at games you attended" instead of presenting `.247` like it's a baseline.                                           |
| Aggregate endpoints cache 1h; box scores enrich on a cron, so 1h staleness is acceptable  | Matches other listening / running aggregates. If a box score enriches mid-cycle, the next request after cache expires picks it up.                                                                                                                                                                                     |
| Player-name search returns the top 5 matches with team + position                         | Disambiguates collisions ("Will Smith" returns the recent Cardinals catcher and the older NL West reliever; including team + position lets the model pick the right one without a follow-up turn).                                                                                                                     |
| Add a single MCP tool `get_attended_player_stats`, not a flag on `get_attended_player`    | Keeps response shapes type-stable. `get_attended_player` returns appearances; `get_attended_player_stats` returns aggregates. Models can compose them. (Open: revisit during Phase 4 checkpoint — the `include_stats=true` flag pattern may be cleaner if tool-count creep matters more than shape stability.)         |
| Game card consumes existing `get_attended_event` structuredContent unchanged              | Avoids forcing a tool-shape change just to ship the card. If the card needs additional fields (`linescore` per-inning detail, etc.), extend the API response in Phase 3 itself, not retroactively.                                                                                                                     |
| Game card is the _only_ new UI component in Phase 3 — player + team cards land in Phase 6 | The whole point of the iteration checkpoint is to learn before building two more cards. Game card has the broadest fanout (every event detail call); if it doesn't get used in real conversation, the others probably won't either.                                                                                    |

## Concerns and risks

These are the ones to keep in mind while executing — they shaped the phase ordering, but several remain open:

1. **Sample sizes might make stats read as misleading-precise.** `.247` looks like a baseline; in reality a few games can swing it. Mitigated by the sample-size warning flag, but the model still has to actually use it. Validate during Phase 4 checkpoint by checking what phrasings the model picks in real conversation.

2. **MLB-only scope on Tier 2 is a real restriction**, not a temporary state. Until ESPN box-score parsers exist, the player-stats endpoint returns nothing useful for football / basketball games attended. Worth deciding during Phase 4 whether the next move is more attending features or NFL / NBA box-score parsing parity.

3. **Coverage gaps in the existing data.** Some attended MLB games may not have box scores enriched (network failure during cron, ESPN ID resolution miss, etc.). Phase 0 audits this so we know the floor before we ship aggregates that lie silently. If coverage is below ~80% for any season, the aggregate response should expose `coverage_warning: true`.

4. **Tool-count creep.** Already 6 attending tools; this project adds 1 (player stats) and possibly a 2nd (team stats). Models keep more tools in context fine, but each new tool competes for selection. The Phase 4 checkpoint should ask whether the new tool is actually getting reached for, and if not, fold its functionality into an existing tool as a parameter.

5. **UI work is bigger than the endpoint work.** Each new MCP App = its own Vite/React entry under `mcp-server/web/`, its own bundle inlined into the Worker, CSP allowlist for image hosts (player photos, venue images), tested end-to-end against Claude Desktop. The existing season-grid took real effort; we should expect game card to take 2–4 days and validate the iteration approach before committing to two more.

6. **Iteration depth on Phase 4.** The checkpoint is only useful if the user actually uses the MCP server for ≥ 1 week between Phase 3 and Phase 5 with these queries in mind. If the user moves immediately to Phase 5, the checkpoint reduces to "everything's fine" without learning anything. Phase 4 should explicitly require ≥ 5 distinct natural-language queries logged with a screenshot or a quote, not just a thumbs-up.

7. **Compressed-column problem on the docs site (issue #76)** affects the API reference rendering, not the MCP card surface. Doesn't block this project. Mentioned because someone reading the project doc will notice the new endpoints lengthen the API ref; if column compression gets fixed first, those endpoint pages render better.

## Sequencing strategy

The big bet is the iteration checkpoint after Phase 3. Reasoning:

1. **Phase 0 (baseline)** is cheap and gives us ground truth. Skip it and aggregates will lie silently if coverage is partial.
2. **Phase 1 (filters)** is small and unblocks the highest-volume natural-language patterns ("Mariners games"). Probably the highest ROI per hour of work in the whole project.
3. **Phase 2 (one aggregate endpoint)** proves the aggregation pattern on the easiest case (per-player MLB stats) before generalizing. If Phase 2 has design issues we discover them on the simpler endpoint.
4. **Phase 3 (one UI component)** is the bigger investment per hour. Doing one card = ~3 days; doing three cards is ~7–10 days. We pause here.
5. **Phase 4 (checkpoint)** asks the question: did Phase 1+2+3 make the natural-language queries feel obviously better, or did the model still stumble? Use real conversation, ≥ 1 week, ≥ 5 distinct queries.
6. **Phase 5 (team stats endpoint)** ships only if Phase 4 says "yes, the model is reaching for the new endpoints, and team-perspective queries are missing." Otherwise, deferred.
7. **Phase 6 (more UI components)** ships only if Phase 4 says "yes, the game card got used inline." Otherwise, deferred.
8. **Phase 7 (polish)** is the close-out — covers any items that surfaced during execution.

## Open questions

These are real questions whose answers will shape later phases — call out during execution if assumptions break.

1. **Will the user actually use the MCP server enough during Phase 4 to generate useful learnings?** If not, the iteration gate is a placeholder. Phase 4 entry criteria require ≥ 5 distinct queries with real conversation transcripts.
2. **Does `attended=1` filtering on stats produce small enough samples that the warnings fire on most queries?** If 80% of "Julio at games I attended" queries return a warning, the warning is signal noise. Phase 0 audit should produce a histogram of (player × season) sample sizes to see what the floor looks like.
3. **Are there teams the user attends a non-trivial number of games at without being a "fan"?** (e.g., visiting Yankee Stadium once, Wrigley Field once.) Team-perspective stats lose meaning at low N — Phase 5 design should say what "≥ 5 attended games per team per season" floor looks like.
4. **Will players appear with multiple `team_id` values across attended games?** (Trades, free-agent moves.) If yes, team-aggregate endpoints need to handle "Adolis García: 8 PAs as a Ranger, 3 PAs as a Padre at games I attended this year." Probably OK to ignore in Phase 5 v1 and split as `appearances_by_team` instead of one aggregate.
5. **What happens with players who appear before they have an `mlb_stats_id` enrichment?** Phase 12 of the original attending project hit 99% coverage but 1% are unenriched. `/players/:id/stats` returns `{ supported: false, reason: "player not enriched" }` for those.

## Follow-up projects

These are deliberately _not_ in this project. Each is a clean follow-up:

- **NFL / NBA / WNBA box-score parsers** in `services/sports/`. Ships per-player stat lines for non-MLB games, unblocks Tier 2 endpoints for those leagues. Probably the next-largest bet after this project lands.
- **Teams table** with slugs, league, official ESPN/MLB ids. Replaces the substring filter with a `?team=mariners` slug filter and gives the team-stats endpoint a real key to join on.
- **Concert / arts deep stats** — "most-seen artist," "longest concert streak," cross-domain `lastfm_artist_id` join into listening data. Uses `attended_event_performers`, distinct shape from this project.
- **Year-in-review card UI** — interactive year recap (totals, top venues, top performers) on `get_attending_year_in_review`.
- **Portfolio site team-perspective page** — once `/teams/:team_id/stats` ships, the portfolio can render "Mariners 2025 — 30 games attended, 18-12 in person, 47 HRs in attended games."

## Documents

| File                       | Purpose               |
| -------------------------- | --------------------- |
| [TRACKER.md](./TRACKER.md) | Phased task checklist |
