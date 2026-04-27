# Sports Box-Score Parity — Task Tracker

Legend: [ ] pending, [x] done, [~] in progress.

**This project is gated** on the Phase 4 checkpoint of [attending-deep-stats](../attending-deep-stats/). Do not begin until that checkpoint says go.

The TRACKER is intentionally light at this stage — task detail will be filled in once Phase 0 here surfaces real ESPN response shapes per league. Padding it with speculative tasks before reading actual API responses would be wasted spec work.

Phases are ordered by **actual attended-events volume** (confirmed during planning):

```
NCAAF 70  >>  NFL 9  >  WNBA 3  >  NCAAB 1  >  MLS 0
```

NCAAF leads by an order of magnitude (UW Husky football back to 2007). Originally I'd planned NFL first; corrected.

## Phase 0: ESPN box-score endpoint research — pending

Goal: confirm the ESPN summary endpoint shape per league, so subsequent phases parse against real responses rather than guesses. ~half a day.

- [ ] **0.1** Hit `site.api.espn.com/apis/site/v2/sports/{sport}/{league}/summary?event={espn_event_id}` for one completed game per league. Save the JSON to `docs/projects/sports-boxscore-parity/fixtures/{league}-summary.json` for parsers to test against.
- [ ] **0.2** For each league, document the per-player field shape under `boxscore.players[*].statistics[*]` (or wherever the per-player stats actually live — the schema differs per sport). Append to README's "Stat-line JSON shape per league" section with real field names, not guesses.
- [ ] **0.3** Confirm the roster endpoint shape per league: `site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams/{team_id}/roster`. Save fixtures.
- [ ] **0.4** Cross-check player-id stability across UW Husky football transfers. Pick one transferring player (in either direction) and compare ESPN ids before/after.
- [ ] **0.5** Audit current player photo coverage by league for any non-MLB players already in the `players` table. Establishes the floor before Phase 2 promises a number.

## Phase 1: NCAAF parser pilot — pending

Goal: per-player rushing / passing / receiving / defense lines for the 70 attended UW Husky football games, end-to-end. ~2–3 days (more than NFL would have been because of larger rosters and more historical games to backfill).

(Sub-tasks filled in after Phase 0 fixtures are captured. Expected shape mirrors `mlb-boxscore.ts`: client + parser + writer, with unit tests against the captured fixture.)

- [ ] **1.1** `src/services/sports/ncaaf-boxscore.ts` — fetches summary, parses per-player stats, writes `attended_event_players` rows with NCAAF `stat_line` shape.
- [ ] **1.2** Roster ingestion via `espn-roster-client.ts`. Per-team-per-season cache. Note NCAAF rosters are 100+ players per team.
- [ ] **1.3** Wire into `enrich-boxscore.ts` dispatcher: `event_type === 'ncaaf_game'` → `ncaaf-boxscore.ts`.
- [ ] **1.4** Backfill existing 70 attended NCAAF events.
- [ ] **1.5** Tests against the Phase 0 fixture.
- [ ] **1.6** Coverage audit script extended to report NCAAF alongside MLB.
- [ ] **1.7** Spec snapshot regenerated.
- [ ] **1.8** Ship — commit + push, CI green, deploy auto-triggered, verify via API.

## Phase 2: NCAAF player photo backfill — pending

Goal: best-effort silo + full-headshot coverage for the new NCAAF player rows. ~1 day.

- [ ] **2.1** Extend `enrich-player-photos.ts` to dispatch by league.
- [ ] **2.2** Extend `enrich-espn-ids.ts` similarly. NCAAF players don't have an MLB Stats id; ESPN id is the only id.
- [ ] **2.3** Backfill photos for all NCAAF players in the database.
- [ ] **2.4** Coverage report — **expect partial coverage**, not the 99% MLB hit rate. College photo gaps are systematic for non-marquee players.

## Phase 3: Pro leagues — NFL / NBA / WNBA — pending

Goal: per-player stats for the 9 attended NFL games, the 3 WNBA games, and any future NBA games. ~3 days for all three since the parsers share scaffolding within their sport pair.

- [ ] **3.1** `nfl-boxscore.ts` — passing/rushing/receiving/defense.
- [ ] **3.2** `nba-boxscore.ts` + `wnba-boxscore.ts` — same scaffolding, different league slugs.
- [ ] **3.3** Roster ingestion for each.
- [ ] **3.4** Dispatcher updates for each `event_type`.
- [ ] **3.5** Backfill — small (12 events total) so this is a single quick run.
- [ ] **3.6** Photo enrichment — pro leagues have full coverage available.
- [ ] **3.7** Tests + spec + ship.

## Phase 4: NCAAB + MLS tail — pending

Goal: ship the long tail only if usage materializes (1 NCAAB attended event at planning time, 0 MLS). ~1 day if both are needed.

- [ ] **4.1** `ncaab-boxscore.ts` — variant of NBA.
- [ ] **4.2** `mls-boxscore.ts` — goals/assists/cards/saves.
- [ ] **4.3** Roster + dispatcher + backfill + photo + tests + ship.
- [ ] **4.4** **Skip option**: if MLS attendance stays at 0 by the time this phase opens, defer indefinitely.

## Phase 5: Backfill execution + final coverage report — pending

Goal: every historical attended sports event across all leagues has player rows + photos where data exists. ~1 day.

- [ ] **5.1** Run backfill across all attended events for each league.
- [ ] **5.2** Coverage audit run end-to-end. Surface per-league `games_with_player_rows / total_attended_games` percentages.
- [ ] **5.3** Investigate any league with < 90% coverage. Document gaps.

## Phase 6: Polish + close-out — pending

- [ ] **6.1** Update root `README.md` and `docs-mintlify/domains/attending.mdx` if any user-facing endpoints changed.
- [ ] **6.2** Open the follow-up issue in attending-deep-stats to extend Tier 2 endpoints (`/players/:id/stats`, `/teams/:team_id/stats`) to non-MLB leagues now that the data exists.
- [ ] **6.3** Add a changelog entry.
- [ ] **6.4** Move project into `docs/projects/archived/` once everything is done.
