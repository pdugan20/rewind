# Places Domain

Foursquare/Swarm check-in history synced via the Foursquare v2 API. Each check-in stores the venue, its primary category, location (city/state/country + coordinates), the check-in timestamp, and any shout.

## Data Sources

- Foursquare/Swarm -- the user's full check-in history via `GET /v2/users/self/checkins`.

## Foursquare API

### Base Configuration

- Base URL: `https://api.foursquare.com`
- Auth: `oauth_token` query parameter (v2 user token, does not expire)
- Versioning: `v=20250101` frozen version date, bumped deliberately after verifying response shapes
- User-Agent: browser-like UA required -- Foursquare's bot protection rejects programmatic UAs
- Rate limit: 429s honored via `Retry-After` with a 10s fallback

### Key Endpoints

| Method | Endpoint                | Description                  |
| ------ | ----------------------- | ---------------------------- |
| GET    | /v2/users/self/checkins | Check-in history (paginated) |

Query params: `oauth_token`, `v`, `sort=oldestfirst`, `limit` (max 250), `offset`.

### Auth

The v2 user token is obtained once via the browser OAuth flow and stored as the Worker secret `FOURSQUARE_ACCESS_TOKEN`. Foursquare v2 user tokens do not expire, so there is no token table and no refresh service.

## Sync Strategy

- `sort=oldestfirst` + `offset` gives a natively resumable oldest-first walk: the cursor is simply the local `COUNT(checkins)` for the user.
- Bounded batches: `syncPlaces(env, { maxPages })` walks up to 8 pages of 250 per run and returns `{ synced, remaining }`; the admin route's caller loops until `remaining: 0`.
- Dedup: unique `foursquare_id` index + `onConflictDoNothing`, with `meta.changes` guarding counts so overlap re-fetches report as skipped, not synced.
- Legacy check-ins with no venue are skipped and counted; the resulting slight cursor lag causes a harmless deduplicated overlap on the next run.
- sync_runs domain `places`, syncType `foursquare`.
- afterSync: feed items (`checkin` events, sourceId `foursquare:checkin:{id}`) and search items (entityType `venue`).
- Cron: every 6 hours, guarded on `env.FOURSQUARE_ACCESS_TOKEN`.

## Endpoints

All endpoints require `Authorization: Bearer rw_...` header.

| Method | Path                  | Description                    | Cache | Query Params                     |
| ------ | --------------------- | ------------------------------ | ----- | -------------------------------- |
| GET    | /v1/places/recent     | Recent check-ins, newest first | 60s   | page, limit, date, from, to      |
| GET    | /v1/places/stats      | Aggregate check-in statistics  | 3600s | none                             |
| POST   | /v1/admin/sync/places | Trigger one bounded sync batch | --    | none (re-run until remaining: 0) |

All tables include `user_id` for multi-user support (default 1).

## Response Types

```typescript
interface Checkin {
  id: number;
  venue_id: string | null;
  venue_name: string;
  venue_category: string | null;
  venue_city: string | null;
  venue_state: string | null;
  venue_country: string | null;
  lat: number | null;
  lng: number | null;
  checked_in_at: string;
  shout: string | null;
}

interface PlacesStats {
  total: number;
  unique_venues: number;
  this_year: number;
  top_categories: Array<{ category: string; count: number }>;
  top_cities: Array<{ city: string; count: number }>;
}
```

## Environment Variables

| Variable                | Description                                         |
| ----------------------- | --------------------------------------------------- |
| FOURSQUARE_ACCESS_TOKEN | Foursquare/Swarm OAuth user token (does not expire) |

## Known Issues

- Some legacy check-ins have no venue attached -- the sync skips and counts them, so the local count can lag the API total slightly.
- The v2 API is legacy but remains the only surface exposing personal Swarm check-in history; the frozen `v=` date pins response shapes.
- Venue photos, maps, and category normalization are out of scope for now.
