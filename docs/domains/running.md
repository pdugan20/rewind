# Running Domain

For current endpoints and response fields, use the [public running guide](../../docs-mintlify/domains/running.mdx) and generated API reference. These notes retain integration decisions and historical operational context; source files remain authoritative.

14+ years of running data since 2011. Activities with GPS routes, pace, heart rate, elevation, splits, gear tracking, and personal records.

## Data Sources

- Apple Health -- new runs since August 2026, sent by the Pulso iPhone app ([fork](https://github.com/pdugan20/pulso)). This is the live source.
- Strava -- the history through 2026-08-28, via the OAuth 2.0 API. Strava deactivated the API application on 2026-06-30 for accounts without a subscription (`403 Application Status Inactive`), so the nightly Strava cron was removed. The sync code and webhook remain for a one-off admin sync.

## Apple Health via Pulso

Pulso reads Apple Health on the phone with anchored HealthKit queries and delivers batches to `https://api.rewind.rest/v1/webhooks/apple-health` (`/health`, `/latest`, `/ingest`). The protocol is `docs/PROTOCOL.md` in the Pulso repository; the fork adds `route` and `heartRateSeries` to running workouts and syncs only workouts by default. Code: `src/services/apple-health/` and the routes at the end of `src/routes/webhooks.ts`.

- **Auth**: `APPLE_HEALTH_INGEST_TOKEN` Worker secret, entered as the token in the app's settings. It grants only this ingest. Ingest returns 503 while the secret is unset.
- **Storage**: runs share `strava_activities` and `strava_splits` with the Strava history, so every running endpoint, stat, streak, and PR covers both. `source = 'apple_health'`, `source_id` is the HealthKit uuid, and `strava_id` is a synthetic id in [2^52, 2^53) derived from that uuid (`healthActivityId`). It stays stable across re-sends and above any real Strava id; `strava_url` is null.
- **Derived fields**: distance, moving time, and calories come from the workout summary. Mile splits, elevation gain (3 m dead band, unless the workout recorded `HKElevationAscended`), max speed, best efforts, and the polyline come from the GPS route, scaled to the workout distance. Fixes worse than 50 m accuracy are dropped; gaps over 30 s count as pauses. City, cadence, and gear are not available.
- **Duplicates**: a new run starting within five minutes of an existing activity is skipped, and its heart rate fills nulls on the existing row. This covers the overlap with Nike runs that also reached Strava.
- **Personal records**: best efforts are ranked by elapsed time, like the Strava history, so a stop inside the fastest stretch counts. Moving time is kept alongside.
- **Deletions**: Pulso tombstones soft-delete Apple Health runs only, and remove any personal records those runs held. Per-run best efforts aren't stored, so the record a deleted run replaced can't be restored. That distance stays empty until another run sets it.
- **Catch-up**: `/latest` reports the end of the newest stored run; a fresh install sends runs from 72 hours before it. "Re-import Full History" in the app re-sends everything, which the duplicate check absorbs.
- **Freshness**: iOS only allows reading Health while the phone is unlocked, so runs arrive after the next unlock.
- Each batch containing a run or deletion records a `sync_runs` row with `sync_type = 'apple_health'`.

### Setup

1. Generate a token and store it: `npx wrangler secret put APPLE_HEALTH_INGEST_TOKEN`.
2. Build Pulso from the fork onto the iPhone with Xcode (team 2DS67Q47ES, bundle `me.patdugan.pulso`).
3. In Pulso settings, set the server to `https://api.rewind.rest/v1/webhooks/apple-health` and paste the token, then Test Connection.
4. Grant Health access (workouts, workout routes, heart rate) and tap Sync Now.

## Strava API

### Base Configuration

- Base URL: `https://www.strava.com/api/v3`
- Token URL: `https://www.strava.com/oauth/token`
- Auth: OAuth 2.0 Bearer token (`Authorization: Bearer {access_token}`)
- Rate limits: 200 requests per 15 minutes, 2,000 per day
- Rate limit headers: `X-RateLimit-Limit` (15min,daily), `X-RateLimit-Usage` (15min,daily)
- Pagination: `per_page` (max 200) + `page`, or `before`/`after` (epoch timestamps)

### Key Endpoints

| Method | Endpoint                 | Description                | Key Params                    |
| ------ | ------------------------ | -------------------------- | ----------------------------- |
| GET    | /athlete/activities      | List activities            | before, after, page, per_page |
| GET    | /activities/{id}         | Activity detail            | include_all_efforts=true      |
| GET    | /activities/{id}/laps    | Lap data                   | none                          |
| GET    | /activities/{id}/streams | Time-series data           | keys, key_by_type             |
| GET    | /athlete/stats           | Lifetime/YTD/recent totals | none                          |
| GET    | /gear/{id}               | Gear detail                | none                          |

### Activity Fields

- **Core**: id, name, type, sport_type, distance (meters), moving_time (seconds), elapsed_time
- **Timing**: start_date (UTC ISO 8601), start_date_local, timezone
- **Location**: start_latlng [lat,lng], city, state, country
- **Performance**: average_speed (m/s), max_speed, average_heartrate, max_heartrate, average_cadence, calories, suffer_score
- **GPS**: map.summary_polyline (Google encoded polyline)
- **Best efforts**: Array of {name, distance, elapsed_time, moving_time, start_date} for standard distances
- **Splits**: Per-km or per-mile splits with pace, elevation, heartrate
- **Gear**: gear_id (references athlete's gear list)
- **Meta**: workout_type (0=default, 1=race, 2=long_run, 3=workout), achievement_count, pr_count

## OAuth Token Rotation Flow

### One-Time Setup (Manual)

1. Register app at <https://www.strava.com/settings/api>
2. Set Authorization Callback Domain to `localhost`
3. Direct browser to:

```text
https://www.strava.com/oauth/authorize?client_id={CLIENT_ID}&response_type=code&redirect_uri=http://localhost&scope=read,activity:read_all&approval_prompt=force
```

4. After authorization, browser redirects to localhost with `?code={CODE}`
5. Exchange code for tokens:

```bash
curl -X POST https://www.strava.com/oauth/token \
  -d client_id={CLIENT_ID} \
  -d client_secret={CLIENT_SECRET} \
  -d code={CODE} \
  -d grant_type=authorization_code
```

6. Response includes: access_token, refresh_token, expires_at
7. Store refresh_token as `STRAVA_REFRESH_TOKEN` env var

### Runtime Token Refresh

```typescript
async function getAccessToken(env: Env, db: DrizzleD1): Promise<string> {
  // Check if current token is still valid
  const stored = await db.select().from(stravaTokens).limit(1);
  if (stored.length && Date.now() / 1000 < stored[0].expires_at - 300) {
    return stored[0].access_token;
  }

  // Refresh the token
  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: stored[0]?.refresh_token ?? env.STRAVA_REFRESH_TOKEN,
    }),
  });

  const data = await response.json();
  // CRITICAL: Strava may return a NEW refresh_token. Must persist it.
  await db
    .insert(stravaTokens)
    .values({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
    })
    .onConflictDoUpdate({
      target: stravaTokens.id,
      set: {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
      },
    });

  return data.access_token;
}
```

Key points:

- Access tokens expire every 6 hours
- Refresh token MAY rotate on each use -- always persist the new one
- Store tokens in D1, not just env vars (env vars can't be updated at runtime)
- Check expiry with 5-minute buffer before using cached token
- If refresh fails with 401, the refresh token is revoked -- must redo manual OAuth flow

## strava_tokens Table

```sql
CREATE TABLE strava_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Runtime token storage. The initial refresh token comes from the env var, but once rotated, new tokens are persisted here. The `getAccessToken` function reads from this table first, falling back to the env var.

## Bulk Import Strategy

Script: `scripts/imports/import-strava.ts` (runs locally via Node.js, not on Workers)

Process:

1. Authenticate with Strava OAuth
2. Fetch all activities via `GET /athlete/activities?per_page=200&page=N`
3. For each activity, fetch detail via `GET /activities/{id}?include_all_efforts=true`
4. For each activity, fetch laps via `GET /activities/{id}/laps`
5. Normalize and insert into D1 (via Drizzle HTTP driver or `wrangler d1 execute`)
6. Compute personal records from best_efforts data
7. Compute year summaries and lifetime stats

Rate limit handling:

- Parse `X-RateLimit-Usage` header after each request
- If 15-min usage > 180 (of 200 limit), sleep until next 15-min window
- If daily usage > 1800 (of 2000 limit), stop and resume next day
- Checkpoint: store last processed activity ID in a local file for resume

Estimated time: ~1800 activities needing detail fetch. At 200/15min, ~2.25 hours. With laps, double to ~4.5 hours.

## Strava Webhook Subscription

### Setup

```bash
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -d client_id={CLIENT_ID} \
  -d client_secret={CLIENT_SECRET} \
  -d callback_url=https://api.rewind.rest/webhooks/strava \
  -d verify_token={STRAVA_WEBHOOK_VERIFY_TOKEN}
```

### Validation (GET)

Strava sends a GET request to verify the callback URL:

```text
GET /webhooks/strava?hub.mode=subscribe&hub.challenge=abc123&hub.verify_token={token}
```

Must respond with:

```json
{ "hub.challenge": "abc123" }
```

### Event Payload (POST)

```json
{
  "aspect_type": "create",
  "event_time": 1709251200,
  "object_id": 12345678,
  "object_type": "activity",
  "owner_id": 98765,
  "subscription_id": 54321,
  "updates": {}
}
```

- `aspect_type`: "create" | "update" | "delete"
- `object_type`: "activity" | "athlete"

Handler logic:

- **create**: fetch full activity detail, insert into D1
- **update**: re-fetch activity detail, update in D1
- **delete**: mark activity as deleted in D1 (soft delete)
- Must respond with 200 within 2 seconds

## Sync Strategy

- **Incremental cron** (daily 4 AM): `GET /athlete/activities?after={last_activity_epoch}`
- **Webhook**: real-time create/update/delete events
- **Gear sync**: daily, fetch `GET /gear/{id}` for each gear_id in activities
- **Stats recomputation**: after each sync -- rebuild year summaries, lifetime stats, personal records, streaks, Eddington number

## Conversion Reference

| From    | To       | Formula                                                    |
| ------- | -------- | ---------------------------------------------------------- |
| meters  | miles    | m \* 0.000621371                                           |
| meters  | feet     | m \* 3.28084                                               |
| m/s     | min/mile | 26.8224 / speed_mps                                        |
| m/s     | min/km   | 16.6667 / speed_mps                                        |
| seconds | MM:SS    | Math.floor(s/60) + ":" + (s%60).toString().padStart(2,"0") |

## Strava Brand Guidelines

- Must display "Powered by Strava" compatible logo
- Must link to activity on Strava ("View on Strava")
- Cannot use "Strava" in app name
- Cannot replicate Strava's core features
- API response includes `strava_url` field for linking

## Known Issues

- Refresh token rotation: new token returned on each refresh, must persist immediately
- Heart rate data only when HR monitor worn
- Treadmill runs have no GPS data (no polyline)
- Manual entries lack GPS/HR/cadence
- Best efforts only computed for runs (not rides/swims)
- Distance/speed always metric from API -- convert to imperial in transforms
- Encoded polyline decoding needs Workers-compatible library (no Node.js @mapbox/polyline)
- Strava API agreement restricts showing data to non-authenticated users (gray area for portfolio)
