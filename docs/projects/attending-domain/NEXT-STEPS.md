# Attending Domain — Next Steps

Snapshot at the close of the build session: **193 events live in prod**, infrastructure complete, PR #43 merged to main, daily cron scheduled. What's left is data curation by you and (optionally) a few follow-up projects.

## State as of 2026-04-25

```
Total events: 193
  concert       : 128
  mlb_game      :  37
  ncaaf_game    :  15
  nfl_game      :   9
  wnba_game     :   3
  ncaab_game    :   1

Year distribution (full): 2016:2, 2017:8, 2018:5, 2019:11,
                         2021:?, 2022:?, 2023:?, 2024:21,
                         2025:31, 2026:6  (etc.)

Mariners by year: 2017:2, 2022:4, 2023:8, 2024:8, 2025:13, 2026:2

Pending source rows (mostly notifications, not real gaps): 663
```

## Things you do (priority order)

### 1. Tomorrow morning: confirm cron tick

```bash
curl https://api.rewind.rest/v1/health/sync \
  -H "Authorization: Bearer rw_..." | jq '.domains.attending'
```

Expect `last_sync` after 4 AM PT and `status: completed`. If `status: failed`, re-run admin sync manually and check `error` field.

### 2. Curate UW football coverage — `scripts/data/manual-attending-uw-football.json`

Already scaffolded with 8 starter rows (2007–2010 + 2013 + 2022/2023/2025 all-home shorthand). To complete:

- **Add Block B per-game rows** for SF-decade away games at Cal/Stanford 2010–2016 (one per year, alternating). Wikipedia "YYYY Washington Huskies football team" pages give the schedule — pick the Bay Area road game per year. ~5–7 entries.
- **Optional: per-season exceptions.** Edit `exceptions: ["YYYY-MM-DD"]` for any home game you actually missed (sick, traveling). Server flips `attended=0`.
- **Optional: 2024 Apple Cup**. Currently shows W=5 L=1 because the calendar entry loaded as attended=1. Add `{ event_type: 'ncaaf_game', team_id: 264, season: 2024, attendance: 'all_home', exceptions: ['2024-09-14'] }` to flip it (or use the review-surface promote endpoint with `attended: 0`).
- **Optional: 2021** — UW's pandemic-affected season. Add or skip per your recall.

To run:

```bash
REWIND_ADMIN_KEY=rw_admin_... npx tsx scripts/tools/import-manual-attending.ts \
  scripts/data/manual-attending-uw-football.json --remote
```

Server expands season-shorthand rows to ~40 events (one per home game per season).

### 3. Curate Mariners coverage — `scripts/data/manual-attending-mariners.json`

Already scaffolded but empty. Email recovery got us 37 Mariners games; gaps are uneven (2021 is 0). Two options documented in the file's `_notes`:

- **Per-game entries** for specific games you remember outside the email trail.
- **Season-shorthand `all_home`** — only if you attended overwhelmingly (most of 81 home games), since you'd have to list misses.

Most likely the gaps are individual purchases via the friend-tickets path — per-game is the realistic option.

### 4. Optional: review pending source rows

663 source rows still pending. Most are subject-rejected (marketing, transfers) or non-confirmation types. To browse:

```bash
curl 'https://api.rewind.rest/v1/admin/attending/pending?limit=50' \
  -H "Authorization: Bearer rw_..."
```

For each that's a real missed event, either:

- `POST /v1/admin/attending/sources/:id/promote` with optional `{ event_date, location, ... }` overrides
- `POST /v1/admin/attending/sources/:id/reject` to hard-delete the row

Skip this entirely if you don't care about the long tail.

## Things that wait (follow-up projects, separate design docs)

| Project                                                                                                                        | Priority | Effort                        | Value                                                           |
| ------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------- | --------------------------------------------------------------- |
| **MCP tools for attending** (`get_attended_events`, `get_attended_season`, `get_attending_stats`)                              | High     | ~1 evening                    | "What Mariners games did I attend in 2023?" via Claude Desktop. |
| **Activity feed integration** — surface attended events in `/v1/feed` alongside scrobbles/runs/watches                         | Med      | ~2 hours                      | Cross-domain unified timeline.                                  |
| **Image enrichment** — team logos (TheSportsDB), venue photos (Google Places), performer photos (cross-link to lastfm_artists) | Med      | ~1 evening                    | Visual layer for portfolio.                                     |
| **Portfolio site Mariners 2024 page**                                                                                          | High     | ~1 evening (in pat-portfolio) | The original motivation.                                        |
| **Year-in-review for attending**                                                                                               | Low      | ~half evening                 | Annual recap.                                                   |

## Risks worth watching

- **OAuth refresh token revocation**: unverified-app status means Google could flag the app for review. Mitigation: re-run `setup-google.ts --remote` when needed, ~5 min.
- **ESPN endpoint stability**: unsupported, could disappear. Detection: cron metrics show drop in `parsed/fetched` ratio. Switch to TheSportsDB or paid alternative would take ~half evening.
- **Cron failure cascading**: if 4 AM cron fails for a transient reason, `shouldRetry()` retries up to 2x. After that it stops; `/v1/health/sync` shows the failed state. Manual recovery: `POST /v1/admin/sync/attending` with mode=incremental.

## Things explicitly out of scope for v1 (deferred indefinitely)

- Per-vendor parsers for: drafthouse.com (movie tickets — overlap with watching domain), regaltickets.com, cityboxoffice.com, sffilm.org, sfsketchfest.com, ticketfly.com (deprecated). All low-volume in your inbox; reprocess endpoint can pick them up later if a parser ships.
- UW Athletics direct ticketing (`gohuskies.com` / `fan-one.com`) — these turned out to be marketing/gameday newsletters, not purchase confirmations. UW routes sales through Ticketmaster.
- Multi-account Google OAuth (work + personal Gmail).
- Resale/refund modeling (the `attended` boolean is enough for "did I go").

## How to get help if something's broken

Health check is the first stop:

```bash
curl https://api.rewind.rest/v1/health/sync -H "Authorization: Bearer rw_..."
```

If `attending.status === 'failed'`, the `error` field has the message. Common breakages and fixes:

| Symptom                             | Likely cause                        | Fix                                                                                      |
| ----------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `Google token refresh failed (401)` | Refresh token revoked               | `npx tsx scripts/tools/setup-google.ts --remote`                                         |
| `Calendar events.list 410`          | syncToken expired (>30 days unused) | Self-heals — next cron picks up via range fallback                                       |
| `ESPN ... 4xx/5xx`                  | ESPN flake                          | Try/catch already swallows; sports games for that day load without scores. Re-run later. |
| `MLB Stats API 5xx`                 | API outage                          | Same — try/catch logs and continues.                                                     |
| Many parser failures                | Vendor template change              | Re-fetch a sample body, update parser, deploy, run reprocess.                            |
