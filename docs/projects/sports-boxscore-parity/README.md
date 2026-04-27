# Project: Sports Box-Score Parity

Bring per-player box-score parsing for NFL, NBA, WNBA, MLS, NCAAF, and NCAAB up to the same parity that MLB has today, so the **attending-deep-stats** project's Tier 2 endpoints (`/players/:id/stats`, `/teams/:team_id/stats`) work for every league we attend games in.

This project is **scoped now but execution is gated** on the Phase 4 checkpoint of [attending-deep-stats](../attending-deep-stats/). Build it now if Phase 4 reveals the user keeps asking about non-MLB games and the MLB-only restriction is the limiting factor; defer if Phase 4 shows queries are MLB-dominant or the per-player stats aren't actually getting reached for in real conversation.

## Motivation

Today's data:

- **MLB**: per-game per-player batting/pitching/fielding lines stored in `attended_event_players` via the MLB Stats API box score (`mlb-boxscore.ts`). 100% silo photo coverage, 99% ESPN full-headshot coverage. Phase 12 of the attending-domain project established this depth.
- **NFL / NBA / WNBA / MLS / NCAAF / NCAAB**: final scores in `attended_events.event_data`, but **no per-player rows in `attended_event_players`**. Players exist in `players` table when they happen to be in box scores already (e.g. via cross-references), but no game-by-game stat lines.

Concrete consequences:

1. `/v1/attending/players/:id/stats` returns `{ supported: false, reason: "league not supported" }` for any non-MLB player.
2. "How did the Seahawks do at games I attended this year" can answer wins / losses (from `event_data`) but not "how many TDs did Geno throw."
3. "How many points has Storm scored at games I attended" requires per-player NBA/WNBA scoring data that doesn't exist.
4. Player photos exist for MLB only; non-MLB game cards (when they ship) won't have headshots.

## Status

**Pending — gated on attending-deep-stats Phase 4 checkpoint.** Do not begin until Phase 4 outcomes are documented in `docs/projects/attending-deep-stats/CHECKPOINT.md` and the decision to proceed is captured there.

| Phase | Status                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------ |
| 0     | ESPN box-score endpoint research — pending                                                       |
| 1     | NCAAF parser pilot — pending (highest non-MLB attended volume: 70 games, all UW Huskies)         |
| 2     | NCAAF player photo backfill — pending (expect partial coverage; college photo gaps real)         |
| 3     | Pro leagues: NFL / NBA / WNBA — pending (lower volume but more stable rosters, photos available) |
| 4     | NCAAB + MLS tail — pending (1 + 0 attended events at planning time; ship if usage materializes)  |
| 5     | Backfill execution + photo coverage — pending                                                    |
| 6     | Polish + close-out — pending                                                                     |

## Scope

In scope:

- **ESPN box-score parser per league.** ESPN's site API returns per-player stats for completed games at `site.api.espn.com/apis/site/v2/sports/{sport}/{league}/summary?event={espn_event_id}`. The shape is per-league (NFL has passing/rushing/receiving lines; NBA has minutes/points/rebounds; etc.) but the request shape is uniform.
- **One enrichment service per league** in `src/services/sports/` that mirrors `mlb-boxscore.ts`: takes a list of attended events, fetches box scores, writes `attended_event_players` rows with league-appropriate `batting_line`-equivalent JSON (renamed appropriately — `passing_line`, `scoring_line`, etc., or generalized as `stat_line` keyed by league).
- **Player roster ingestion**. `players` table needs to gain non-MLB rows. ESPN endpoints can drive this — each league has a roster endpoint we can hit once per team per season.
- **Player photo enrichment** mirroring the existing ESPN photo path. The `enrich-player-photos.ts` and `enrich-espn-ids.ts` patterns from MLB extend to other leagues with minimal change.
- **Cron wiring**. The existing daily 4 AM Pacific cron picks up new attended events; we hook the new league enrichers into that path so backfill of new games is automatic.
- **Backfill execution** for the historical attended events that don't yet have player rows.
- **Coverage reporting**. Same audit pattern as Phase 0 of attending-deep-stats — surface per-league coverage so consumers know when an aggregate is partial.

Out of scope:

- **`stat_line` schema unification across leagues.** Each league has its own meaningful stats; trying to fit football and baseball into one shape produces a least-common-denominator that's useful for nothing. The `attended_event_players` table already stores stat lines as opaque JSON; the league-specific shape lives in the JSON, and consumers (Tier 2 endpoints) discriminate by league.
- **Tier 2 endpoint changes in `attending-deep-stats`.** Adding NFL/NBA support to `/players/:id/stats` is a **follow-up** within the deep-stats project once this one ships — not bundled here. Keeps both projects shippable independently.
- **Live game stats.** Same as MLB scope — completed games only.
- **Game-by-game lineup ingestion for non-attended games.** We only enrich games the user attended, the same shape as MLB.
- **Multi-platform fallback for ESPN outages.** If ESPN's unofficial API breaks for a league, that league's enrichment quietly stalls; we don't ship a backup data source. Documented as a known risk.

## Architecture

### What's already on disk

```text
attended_events            -- has event_data with home_team / away_team / scores for all leagues
attended_event_players     -- MLB-only today; will grow non-MLB rows
players                    -- bio data; primarily MLB today; will grow non-MLB rows
images                     -- player photos; MLB-only today
```

### What needs to be added

```text
src/services/sports/
  nfl-boxscore.ts          -- new: ESPN summary endpoint -> attended_event_players (passing/rushing/receiving)
  nba-boxscore.ts          -- new: ESPN summary -> attended_event_players (scoring/rebounds/assists)
  wnba-boxscore.ts         -- new: same shape as NBA, different league slug
  mls-boxscore.ts          -- new: ESPN summary -> attended_event_players (goals/assists/cards/saves)
  ncaaf-boxscore.ts        -- new: variant of NFL
  ncaab-boxscore.ts        -- new: variant of NBA
  espn-roster-client.ts    -- new: per-team roster ingestion (one call per team per season)
src/services/attending/
  enrich-boxscore.ts       -- already exists for MLB; extend dispatcher to call the right league client
  enrich-player-photos.ts  -- already exists for MLB; extend to other leagues' photo URLs
  enrich-espn-ids.ts       -- already exists; extend to include non-MLB players
```

### Enrichment dispatch

The existing `enrich-boxscore.ts` orchestrator is the natural extension point. Today it calls `mlb-boxscore.ts` for `event_type === 'mlb_game'`; the new shape dispatches by `event_type`:

```text
event_type           -> client
mlb_game             -> mlb-boxscore.ts          (already exists)
nfl_game             -> nfl-boxscore.ts          (Phase 1)
nba_game             -> nba-boxscore.ts          (Phase 3)
wnba_game            -> wnba-boxscore.ts         (Phase 3)
mls_game             -> mls-boxscore.ts          (Phase 5)
ncaaf_game           -> ncaaf-boxscore.ts        (Phase 4)
ncaab_game           -> ncaab-boxscore.ts        (Phase 4)
```

### Stat-line JSON shape per league

Each league stores its own per-player JSON in `attended_event_players.batting_line` (the column name stays for now; consumers discriminate by `league`). Probable shapes — locked in during each phase against actual ESPN responses, not guessed:

- **NFL**: `{ passing: { att, comp, yards, td, int, rating }, rushing: { att, yards, td }, receiving: { rec, yards, td }, defense: { tackles, sacks, int } }`
- **NBA / WNBA**: `{ minutes, points, rebounds, assists, steals, blocks, fg, threes, ft, +/- }`
- **NCAAF / NCAAB**: same shape as their pro siblings.
- **MLS**: `{ minutes, goals, assists, shots, fouls, yellow, red, saves (gks) }`

Renaming the column from `batting_line` to `stat_line` is tempting but adds a migration with no functional benefit. Leave the column name alone; the JSON content is what matters.

## Decisions

| Decision                                                                     | Why                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ESPN as the sole non-MLB box-score source                                    | Already used for scoreboard / event-summary enrichment in attending-domain Phase 4. Adding box-score parsing extends a known pattern. No new vendor dependency.                                                                              |
| One enrichment service per league rather than a single switchboard           | Each league's box-score response shape differs enough that branching inside one file would be uglier than separate clients. Pattern matches `mlb-boxscore.ts` standalone.                                                                    |
| Keep `batting_line` column name; store league-specific stats inside the JSON | Renaming is a migration with zero functional benefit. Consumers (Tier 2 endpoints) already discriminate by league, so they can switch on `league` to interpret the JSON shape.                                                               |
| Phase the leagues by user usage, not alphabetical                            | Confirmed during planning via `/v1/attending/stats`: actual non-MLB attended counts are NCAAF 70, NFL 9, WNBA 3, NCAAB 1, MLS 0. NCAAF leads by an order of magnitude (UW Husky football). Original guess had NFL first; corrected to NCAAF. |
| **Defer Tier 2 endpoint changes to attending-deep-stats follow-up work**     | This project ships the _data_; the consumer (`/players/:id/stats` returning real values for NFL players) is a follow-up in the deep-stats project. Keeps both projects independently shippable and reviewable.                               |
| Roster ingestion is per-team-per-season, not per-event                       | ESPN's roster endpoint returns the full team. One call per attended team per season covers everyone the user could plausibly have seen. Cheaper than per-game roster lookups and the data doesn't change mid-season often enough to matter.  |
| Same coverage-warning pattern as attending-deep-stats Phase 0                | Each league enrichment surfaces "X games enriched of Y attended." Consumers can decide whether to compute aggregates or warn.                                                                                                                |

## Concerns

1. **ESPN API stability.** Already a known risk in attending-domain Phase 4 — ESPN endpoints are unofficial and could break per league at any time. The single-source dependency means no failover. Mitigated by per-league enrichment isolation (NFL breakage doesn't affect NBA), but each league is a single point of failure for itself.
2. **NCAAF roster sizes.** College football rosters are 100+ players. One roster call per team per season per league means ~5 NCAAF teams × 4 seasons = 20 calls; bearable. But the `players` table will grow significantly faster for NCAAF than for pro leagues.
3. **Player ID stability across seasons.** ESPN's college-player IDs are reasonably stable but not guaranteed across program transitions. Worth checking whether a player who transferred from UW to Oregon retains the same ESPN ID. If not, dedup-by-name is the fallback (with the same multi-collision risk MLB had with "Will Smith").
4. **Photo coverage for non-MLB.** MLB had silo photos via MLB Stats API. ESPN's player photos work for NFL/NBA but college-football photo coverage is spotty — many lower-profile players have no headshot. Document the floor; don't promise 99% like MLB.
5. **Stat-line semantics across leagues are not portable.** A "good game" for an NFL QB (300 yards, 3 TDs) is a different shape from a "good game" for an NBA player (30/10/10). Tier 2 endpoint design in attending-deep-stats has to handle this branching by league; this project just makes sure the underlying data is there.
6. **Rate limits.** No documented ESPN rate limits, but heavy backfill across 6 leagues could plausibly trip throttling. Mirror the MLB pattern: rate-limit per-host, retry with exponential backoff.

## Open questions

1. **Which league second after NFL?** I defaulted NBA/WNBA in Phase 3 based on the assumption that pro-basketball attendance is non-trivial (Storm, traveling for Blazers). Reorder if NCAAF / NCAAB is actually higher volume — Phase 0 audit script can produce attended-events-by-league counts.
2. **Should the NFL roster ingestion handle practice-squad / IR players?** ESPN's roster endpoint variants differ. Default: active 53-man roster only; missing-player fallback (e.g. game-day call-up not on the active roster) just means that player has no `players` row when their game appearances try to insert. Worth deciding before Phase 1.
3. **Does the existing `enrich-boxscore.ts` orchestrator need refactoring before Phase 1?** It was built MLB-only; the dispatch shape needs `event_type` -> client routing. Cheap to refactor (10 lines) but worth confirming it doesn't have MLB-specific assumptions baked in elsewhere.
4. **Cross-league player support.** A player who's been in both MLB and NFL (rare but exists — Bo Jackson, Deion Sanders) — does the `players` table key by `(league, espn_id)` or `(global_id)`? Today it's per-league; keep it that way unless Phase 0 audit finds duplicates that hurt.

## Sequencing strategy

Phases are ordered by:

1. Likely user value (NFL Seahawks > NBA Storm > NCAAF UW > MLS).
2. Single-league pilot in Phase 1 to validate the ESPN box-score path before generalizing — saves rework if the parser shape needs to change.
3. Pro-leagues before college-leagues because pro player IDs are more stable.

The scope is deliberately one league per phase so each ship delivers visible value (NFL games attended now have player stats) rather than a six-league big-bang.

## Follow-up projects

- **attending-deep-stats Tier 2 expansion.** Once box-score data exists for non-MLB leagues, the `/players/:id/stats` and `/teams/:team_id/stats` endpoints get extended to return real values for those leagues. Probably a small follow-up (≤ 1 day) once the data shape is settled per league.
- **Cross-league player linking.** If we ever want "Deion Sanders games attended" cross-MLB-and-NFL, a global-id approach would be needed. Defer until the use case actually appears.
- **Live game integration.** Real-time score updates during games we're attending. Distinct project; uses different ESPN endpoints.
- **College sports schedule integration.** Same shape as the MLB schedule integration that the portfolio already does — fetch full season schedules from ESPN at render time, overlay attendance.

## Documents

| File                       | Purpose                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| [TRACKER.md](./TRACKER.md) | Phased task checklist (lighter — to be expanded once Phase 4 of attending-deep-stats says go) |
