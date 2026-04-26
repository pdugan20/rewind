# Attending Domain — Next Steps

Snapshot at the close of the 2026-04-26 build session: **263 attended events live in prod**, full per-game player stats + photos for MLB games, MCP tools + season-grid card UI shipped, activity feed integrated. What's left is data curation by you and a couple of follow-up projects (separate design docs).

## State as of 2026-04-26

```
Total events: 263
  concert       : 135   (135 incl. arts events misclassified as concert)
  ncaaf_game    :  70
  mlb_game      :  45
  nfl_game      :   9
  wnba_game     :   3
  ncaab_game    :   1

Mariners by year:
  2014: 2   2017: 2   2019: 1   2022: 4
  2023: 9   2024: 9   2025: 14  2026: 4
  (gap years: 2018, 2020, 2021)

UW football by season:
  2007–2010: ~6 home games each (Block A undergrad)
  2013: ~7 home games (grad year)
  2022, 2023, 2025: ~6 home games each (return-to-Seattle)
  Block B (Cal/Stanford road games 2011–2016): not yet curated

Per-game player data (MLB):
  839 unique players seen
  1,977 game appearances with batting/pitching/fielding lines
  100% silo photos (839/839)
   60% full ESPN photos (499/839 — relief pitchers / bench guys
                          rarely appear in ESPN summaries)

Activity feed: 263 attending rows in /v1/feed
MCP tools:
  get_attended_events, get_attended_event, get_attended_season,
  get_attended_player, get_attending_stats
  + interactive season-grid card in MCP Apps clients
```

## Things you do (priority order)

### 1. Curate Mariners coverage — `scripts/data/manual-attending-mariners.json`

Empty scaffold. Email recovery got us 45 Mariners games; gap years are 2018 / 2020 / 2021. Two options documented in the file's `_notes`:

- **Per-game entries** for specific games you remember outside the email trail. Most realistic for the gap years (friend-tickets path).
- **Season-shorthand `all_home`** — only if you attended overwhelmingly. Probably not the right fit unless any season was a season-ticket year.

Run:

```bash
REWIND_ADMIN_KEY=$ADMIN_KEY npx tsx scripts/tools/import-manual-attending.ts \
  scripts/data/manual-attending-mariners.json --remote
```

### 2. Curate UW football Block B — `scripts/data/manual-attending-uw-football.json`

Already loaded with 8 season-shorthand rows (Block A: 2007–2010 + 2013, return-to-Seattle: 2022/2023/2025) → 56 events. Still missing:

- **Block B per-game rows** for SF-decade away games at Cal/Stanford 2011–2016. Wikipedia "YYYY Washington Huskies football team" pages give the schedule — pick the Bay Area road game per year. ~5 entries.
- **Optional: 2024 Apple Cup correction**. Currently 5-1 attended record assumes you went; you mentioned you DID go to the Lumen Field game so the data is correct as-is. Skip.
- **Optional: 2021** — UW's pandemic-affected season. Add or skip per recall.

Same import command as above with the UW filename.

### 3. Confirm cron tick (any morning)

```bash
curl https://api.rewind.rest/v1/health/sync -H "Authorization: Bearer $API_KEY" \
  | jq '.domains.attending'
```

Expect `last_sync` after 4 AM PT and `status: completed`. Cron has been firing daily without issues — this is just a sanity check whenever you remember.

### 4. Optional: review pending source rows

665 source rows still pending. Most are subject-rejected marketing or non-confirmation noise. The deep-sweep + game-scoped reprocess work this session moved the real ones into canonical events; what remains is mostly long-tail noise.

```bash
curl 'https://api.rewind.rest/v1/admin/attending/pending?limit=50' \
  -H "Authorization: Bearer $API_KEY"
```

For real missed events: `POST /v1/admin/attending/sources/:id/promote` with optional overrides, or `/reject` for confirmed noise.

## Things on you in other repos

- **Portfolio site Mariners 2024 page** — the original motivation. Use `GET /v1/attending/seasons/mlb/2024` to drive a season-grid view; the API responds with attended games + W/L + per-game player photos. Lives in `pat-portfolio` (separate repo).
- **Rotate the leaked admin key** — `rw_admin_4a70c8d41d5f0688e1a26d07b8425bbf` is committed in 6 pre-existing main commits (`318df90`, `7e7b8e3`, `11e8929`, `4ee9b89`, `9f9e2bb`, `1d97102`). Worth rotating; details in repo issues.

## Things that wait (follow-up projects, see open GitHub issues)

| Project                                                                     | Priority | Effort        | Value                                            |
| --------------------------------------------------------------------------- | -------- | ------------- | ------------------------------------------------ |
| **Year-in-review for attending** (`/v1/attending/year/{year}`)              | Low      | ~half evening | Annual recap. Mirrors listening/running pattern. |
| **NFL/NBA/WNBA box scores** (extend the MLB enrichment to other leagues)    | Med      | ~2 evenings   | Per-game player stats for the 13 non-MLB games.  |
| **Concert performer photos** (cross-link `lastfm_artist_id` to image)       | Med      | ~half evening | Concert detail responses gain artist photos.     |
| **Improve concert event_data** (setlists, opener vs headliner discovery)    | Low      | ~1 evening    | Setlist.fm enrichment beyond what shipped in v1. |
| **Backfill ESPN photos for unmatched players** (~340 mostly-relief pitcher) | Low      | unclear       | Marginal — ESPN summaries don't include them.    |

## Risks worth watching

- **OAuth refresh token revocation**: unverified-app status means Google could flag the app for review. Mitigation: re-run `setup-google.ts --remote` when needed, ~5 min.
- **ESPN endpoint stability**: unofficial, could disappear. Detection: cron metrics show drop in parsed/fetched ratio. Fallback path: TheSportsDB or paid alternative, ~half evening to swap.
- **MLB Stats API stability**: same caveat — undocumented but stable since ~2018. Used by community libraries (pybaseball, etc.).
- **Cron failure cascading**: if 4 AM cron fails for a transient reason, `shouldRetry()` retries up to 2x. After that it stops; `/v1/health/sync` shows the failed state. Manual recovery: `POST /v1/admin/sync/attending` with `mode=incremental`.
- **D1 parameter cap**: ~100 in practice. The chunked feed insert handles it. Future bulk admin endpoints should chunk similarly — this caught us twice during the activity-feed integration.

## Out of scope for v1 (deferred indefinitely)

- Per-vendor parsers for low-volume sources: drafthouse.com (overlap with watching domain), regaltickets.com, cityboxoffice.com, sffilm.org, sfsketchfest.com, ticketfly.com (deprecated). Reprocess endpoint can pick them up later if a parser ships.
- UW Athletics direct ticketing (`gohuskies.com` / `fan-one.com`) — turned out to be marketing/gameday newsletters, not purchase confirmations. UW sales route through Ticketmaster.
- Multi-account Google OAuth (work + personal Gmail).
- Resale/refund modeling (the `attended` boolean is enough for "did I go").

## How to get help if something's broken

Health check is the first stop:

```bash
curl https://api.rewind.rest/v1/health/sync -H "Authorization: Bearer $API_KEY"
```

If `attending.status === 'failed'`, the `error` field has the message. Common breakages and fixes:

| Symptom                             | Likely cause                        | Fix                                                                                      |
| ----------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `Google token refresh failed (401)` | Refresh token revoked               | `npx tsx scripts/tools/setup-google.ts --remote`                                         |
| `Calendar events.list 410`          | syncToken expired (>30 days unused) | Self-heals — next cron picks up via range fallback                                       |
| `ESPN ... 4xx/5xx`                  | ESPN flake                          | Try/catch already swallows; sports games for that day load without scores. Re-run later. |
| `MLB Stats API 5xx`                 | API outage                          | Same — try/catch logs and continues.                                                     |
| Many parser failures                | Vendor template change              | Re-fetch a sample body, update parser, deploy, run reprocess.                            |
