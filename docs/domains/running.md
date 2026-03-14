# Running Domain

14+ years of Strava running data since 2011. Activities with GPS routes, pace, heart rate, elevation, splits, gear tracking, and personal records. OAuth 2.0 with refresh token rotation.

## Data Source

- Strava -- all running activities via OAuth 2.0 API. App registered at <https://www.strava.com/settings/api>

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

## Endpoints

All endpoints require `Authorization: Bearer rw_...` header.

| Method | Path                              | Description                   | Cache  | Query Params                                                          |
| ------ | --------------------------------- | ----------------------------- | ------ | --------------------------------------------------------------------- |
| GET    | /v1/running/stats                 | Lifetime running statistics   | 3600s  | none                                                                  |
| GET    | /v1/running/stats/years           | All year summaries            | 3600s  | none                                                                  |
| GET    | /v1/running/stats/years/:year     | Single year detail            | 3600s  | none                                                                  |
| GET    | /v1/running/prs                   | Personal records per distance | 86400s | none                                                                  |
| GET    | /v1/running/recent                | Last N activities             | 60s    | limit, date, from, to                                                 |
| GET    | /v1/running/activities            | Paginated activity list       | 3600s  | page, limit, year, date, from, to, type, city, min/max_distance, sort |
| GET    | /v1/running/activities/:id        | Single activity detail        | 86400s | none                                                                  |
| GET    | /v1/running/activities/:id/splits | Per-mile splits               | 86400s | none                                                                  |
| GET    | /v1/running/gear                  | Gear/shoe data                | 86400s | none                                                                  |
| GET    | /v1/running/calendar              | Daily activity heatmap        | 3600s  | year                                                                  |
| GET    | /v1/running/charts/cumulative     | Year-over-year distance       | 3600s  | years, unit (mi/km)                                                   |
| GET    | /v1/running/charts/pace-trend     | Pace over time                | 3600s  | window (7/30/90), from, to                                            |
| GET    | /v1/running/charts/time-of-day    | Run frequency by hour         | 86400s | year                                                                  |
| GET    | /v1/running/charts/elevation      | Elevation data                | 86400s | year                                                                  |
| GET    | /v1/running/cities                | Cities where runs occurred    | 86400s | none                                                                  |
| GET    | /v1/running/streaks               | Current/longest streaks       | 3600s  | none                                                                  |
| GET    | /v1/running/races                 | Race activities               | 86400s | distance                                                              |
| GET    | /v1/running/eddington             | Eddington number              | 86400s | none                                                                  |

All tables include `user_id` for multi-user support (default 1).

## Response Types

```typescript
interface RunningStats {
  total_runs: number;
  total_distance_mi: number;
  total_elevation_ft: number;
  total_duration: string; // "1423:45:30"
  avg_pace: string; // "8:22/mi"
  years_active: number;
  first_run: string;
  eddington_number: number;
}

interface YearSummary {
  year: number;
  total_runs: number;
  total_distance_mi: number;
  total_elevation_ft: number;
  total_duration_s: number;
  avg_pace: string;
  longest_run_mi: number;
  race_count: number;
}

interface PersonalRecord {
  distance: string; // "mile", "5k", "10k", "half_marathon", "marathon"
  distance_label: string; // "Mile", "5K", etc.
  time: string; // "22:15"
  time_s: number;
  pace: string; // "7:10/mi"
  date: string;
  activity_id: number;
  activity_name: string;
}

interface Activity {
  id: number;
  strava_id: number;
  name: string;
  date: string;
  distance_mi: number;
  duration: string; // "42:30"
  pace: string; // "8:10/mi"
  elevation_ft: number;
  heartrate_avg: number | null;
  city: string | null;
  polyline: string | null;
  is_race: boolean;
  workout_type: string;
}

interface EddingtonResponse {
  number: number;
  explanation: string;
  progress: { target: number; days_completed: number; runs_needed: number };
}
```

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

## Environment Variables

| Variable                    | Description                                              |
| --------------------------- | -------------------------------------------------------- |
| STRAVA_CLIENT_ID            | OAuth app client ID                                      |
| STRAVA_CLIENT_SECRET        | OAuth app client secret                                  |
| STRAVA_REFRESH_TOKEN        | Initial refresh token (rotates at runtime, stored in D1) |
| STRAVA_WEBHOOK_VERIFY_TOKEN | Webhook validation token                                 |

## Known Issues

- Refresh token rotation: new token returned on each refresh, must persist immediately
- Heart rate data only when HR monitor worn
- Treadmill runs have no GPS data (no polyline)
- Manual entries lack GPS/HR/cadence
- Best efforts only computed for runs (not rides/swims)
- Distance/speed always metric from API -- convert to imperial in transforms
- Encoded polyline decoding needs Workers-compatible library (no Node.js @mapbox/polyline)
- Strava API agreement restricts showing data to non-authenticated users (gray area for portfolio)
