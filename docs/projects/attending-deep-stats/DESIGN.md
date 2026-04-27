# Attending Deep Stats — Design Notes

Source of truth for data shapes, response shapes, and aggregation gotchas. Ground-truth captured by hitting the prod read API directly during planning, not assumed from the schema.

## What `event_data` actually looks like

`home_team` and `away_team` are **objects**, not strings. Schema (consistent across MLB / NCAAF / WNBA — non-MLB also carries `abbreviation`):

```json
{
  "league": "mlb",
  "season": 2026,
  "game_type": "R",
  "home_team": { "id": 136, "name": "Seattle Mariners" },
  "away_team": { "id": 140, "name": "Texas Rangers" },
  "home_score": 5,
  "away_score": 2,
  "my_team": "home",
  "my_team_won": true,
  "my_team_score": 5,
  "opponent_score": 2,
  "attendance": 35474,
  "weather": {
    "condition": "Partly Cloudy",
    "temp": "66",
    "wind": "7 mph, L To R"
  },
  "duration_minutes": 149,
  "first_pitch": "2026-04-19T20:12:00.000Z",
  "linescore": [
    {
      "inning": 1,
      "home_runs": 1,
      "away_runs": 0,
      "home_hits": 1,
      "away_hits": 1,
      "home_errors": 0,
      "away_errors": 0
    }
  ]
}
```

Non-MLB (NCAAF / WNBA) drops the MLB-specific fields (`linescore`, `attendance`, `weather`, `first_pitch`, `duration_minutes`, `game_type`) but keeps the team objects + scores + `my_team_*` fields.

**Implication for Phase 1 team filter**: substring match must dereference the object — `json_extract(event_data, '$.home_team.name')` and `$.away_team.name`. Not `$.home_team` (which serializes as `{"id":136,"name":"..."}` and matches any team containing those substrings).

**Implication for Phase 5 team-stats endpoint**: team identity has a real integer id (`event_data.home_team.id`) — that's what you key on, not the string name. Even without a teams table, the integer id is a stable join key for "all attended games where team_id = 136 was playing." This is significantly cleaner than I'd assumed.

**Implication for the game card**: linescore is already on disk for MLB. Card can render the per-inning grid with no additional API work.

## What `batting_line` and `pitching_line` actually look like

Confirmed from a real attended event:

```json
batting_line: {
  "ab": 4, "r": 0, "h": 1, "rbi": 0, "bb": 0, "k": 1, "hr": 0,
  "doubles": 0, "triples": 0, "sb": 0, "hbp": 0,
  "pa": 4, "total_bases": 1, "left_on_base": 3,
  "summary": "1-4 | K"
}

pitching_line: {
  "ip": "7.0", "h": 4, "r": 2, "er": 2, "bb": 1, "k": 6, "hr": 0,
  "pitches": 85, "strikes": 54,
  "era": null, "batters_faced": 26,
  "summary": "7.0 IP, 2 ER, 6 K, BB"
}
```

Field-by-field for Phase 2 aggregation:

| Stat                                       | Available?                                | Notes                                                                                                                                                                                                              |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| AVG (`h/ab`)                               | Yes                                       | Straightforward sum-then-divide.                                                                                                                                                                                   |
| SLG (`tb/ab`)                              | Yes — `total_bases` is stored             | Sum total_bases / sum ab.                                                                                                                                                                                          |
| OBP                                        | **No (approximate only)**                 | OBP = (h + bb + hbp) / (ab + bb + hbp + sf). **`sf` (sacrifice flies) is not stored.** Either omit OBP or document it as approximate (slightly higher than true OBP because we're missing SFs in the denominator). |
| HR / RBI / R / BB / K / SB / HBP / 2B / 3B | Yes                                       | All summable directly.                                                                                                                                                                                             |
| `pa`                                       | Yes — sample-size threshold works         | Sum across appearances. Threshold for `sample_size_warning` confirmed practical.                                                                                                                                   |
| Pitching `ip`                              | Yes — but **stored as string "6.2"**      | "6.2" means 6 innings + 2 outs = 20 outs total. Aggregation must convert to outs (`floor*3 + frac`), sum, then convert back (`floor(outs/3) + (outs%3)/10`). Not a sum-of-decimals operation.                      |
| Pitching ERA                               | Per-game value stored, **often null**     | Recompute aggregate ERA from `(total_er * 9) / (total_outs / 3)`, not by averaging per-game ERAs.                                                                                                                  |
| Pitching WHIP                              | Yes — `(h + bb) / ip_in_innings`          | Same outs-math as ERA.                                                                                                                                                                                             |
| `batters_faced` (BF)                       | Yes                                       | Sum across appearances. Threshold for pitcher `sample_size_warning` confirmed practical.                                                                                                                           |
| Pitches / strikes                          | Yes                                       | Summable.                                                                                                                                                                                                          |
| Decisions (`W`/`L`/`SV`/`HLD`/`BS`)        | Yes — single-character `decision` field   | Count by value across appearances.                                                                                                                                                                                 |
| `summary`                                  | Yes — pre-formatted human string per game | Pre-formatted ("1-4                                                                                                                                                                                                | K", "7.0 IP, 2 ER, 6 K, BB"). Useful for the game card top-performers panel without computing anything. |

## What `get_attended_event` returns today

Top-level keys: `id, category, event_type, event_date, event_datetime, title, subtitle, series_id, external_id, external_source, event_data, notes, attended, venue, tickets, players`.

`venue`: `{ id, name, city, state, country, latitude, longitude, capacity }`.

`tickets`: array of `{ id, vendor, order_id, section, row, seat, quantity, total_price_cents, currency, purchased_at }`.

`players`: array of `{ player: {...full player bio + photo_silo + photo_full}, team_id, is_home, batting_line, pitching_line, fielding_line, decision, notable }`.

For example MLB game id=57 (Texas at Mariners): 51 player rows (both teams), 21 with `batting_line`, 8 with `pitching_line`, 7 marked `notable`. So a game card has plenty of structured data already — no API additions needed for Phase 3.

## What `players` list returns today

`{ data: [...], pagination: { page, limit, total: 839, total_pages: 280 } }`.

Each player: `{ id, league, mlb_stats_id, espn_id, full_name, primary_position, primary_number, birth_date, birth_country, bats, throws, primary_team_id, debut_date, photo_silo, photo_full }`.

Total players: **839** (matches Phase 12 of attending-domain). Pagination already exists; Phase 1 `name` filter just adds a WHERE clause.

## Coverage as of planning

From `/v1/attending/stats`:

```
total_events: 263  (100% attended — no no-shows in DB)

by_event_type:
  concert        135
  ncaaf_game      70   <-- highest non-MLB
  mlb_game        45
  nfl_game         9
  wnba_game        3
  ncaab_game       1

by_year (selected):
  2025  37
  2024  23
  2023  19
  2022  21
  2017  27
  ... 2007 7
```

**Implication for sports-boxscore-parity sequencing**: the original ordering (NFL → NBA/WNBA → NCAAF) was driven by guess. By volume, NCAAF (70 attended) >> NFL (9). Sibling project's Phase 1 should ship NCAAF box-score parsing first.

**Implication for Phase 0 audit**: the 51 player rows on game id=57 means the typical attended MLB game produces ~50 `attended_event_players` rows. 45 attended MLB games × ~50 = expected ~2,250 rows. Phase 12 reported 1,977 actual — implies ~88% coverage if the per-game count is roughly constant. That's below the 80% threshold I set for `coverage_warning`, so the warning will fire on aggregates often. Phase 0.1 audit should produce the actual per-season breakdown.

## Player photo CDN

Confirmed from a real player row — photos served from `cdn.rewind.rest`:

```
photo_silo:  https://cdn.rewind.rest/attending/player_silo/121/original.png?...
photo_full:  https://cdn.rewind.rest/attending/player_full/121/original.png?...
```

Each photo block carries `{ cdn_url, thumbhash, dominant_color, accent_color }`. Same pattern as listening / watching domain images, so the existing `<PosterCard>` thumbhash-then-fade pattern from `mcp-server/web/components/` ports directly to the game card.

CSP allowlist for the game-card UI resource: `cdn.rewind.rest` (image-src + connect-src for the lazy-loaded photos).

## Open design questions, now with informed answers

These were the design questions from the planning back-and-forth. Now that the data shapes are real:

1. **`season` required vs default-current-year on `/players/:id/stats`** — keep required. The model can default to "current calendar year" in its own logic; the API stays explicit.
2. **Non-MLB players: include `event_data` summary in `supported: false` response?** Yes — append `appearances` with each entry containing `event_id`, `event_date`, `event_data` summary (just `home_team`, `away_team`, scores, `my_team_won`). Cheap and useful.
3. **Team filter for concerts** — match anywhere; substring is short enough that band-name false positives are rare in practice. If a real collision shows up, can scope by `category=sports` later.
4. **Sample-size thresholds** — defer locking until Phase 0.2 produces the actual histogram. Defaults of `pa<50` / `bf<60` are placeholders.
5. **MCP tool naming** — `get_attended_player_stats`. Symmetric with existing `get_attended_event` / `get_attended_player`.
6. **One tool vs flag on existing** — separate tool. Shape stability wins over tool-count creep concerns; revisit at Phase 4 if real usage shows the model defaulting to the wrong tool.

## Aggregation reference: pitching IP math

Worth spelling out once because it's the only non-obvious math in Phase 2:

```
parse_ip("6.2") = 6 * 3 + 2 = 20 outs
parse_ip("7.0") = 7 * 3 + 0 = 21 outs

sum across appearances → total_outs

format_ip(total_outs) =
    floor(total_outs / 3) + "." + (total_outs % 3)
    // 65 outs → "21.2"
    // 60 outs → "20.0"

aggregate_era = (total_er * 27) / total_outs        // 9 IP * 3 outs = 27
aggregate_whip = (total_h + total_bb) / (total_outs / 3)
```

Test fixtures should include at least one pitcher with non-zero fractional IP across multiple appearances (e.g. 6.2 + 0.1 = 7.0) so the modulo wraparound is exercised.
