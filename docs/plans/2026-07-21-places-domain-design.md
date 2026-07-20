# Places domain: Foursquare/Swarm check-ins

**Date:** 2026-07-21
**Status:** Approved (user-directed; autonomous defaults)

## Goal

A new `places` domain syncing the user's full Swarm check-in history via the
Foursquare v2 API, served through the standard Rewind route/feed/search
surface.

## Auth

Foursquare v2 user tokens do not expire. The token is obtained once via the
browser OAuth flow (registered app `myactivities`, custom-scheme redirect;
code captured from the 302 Location header) and stored as a Worker secret
`FOURSQUARE_ACCESS_TOKEN`. No token table, no refresh service — deliberate
simplification vs Trakt/Strava.

## Schema

`checkins` table (`src/db/schema/places.ts`):
id, user_id (default 1), foursquare_id (text, unique — dedup key),
venue_id (text), venue_name (text not null), venue_category (text),
venue_city, venue_state, venue_country, lat (real), lng (real),
checked_in_at (text ISO not null, indexed), shout (text),
created_at. Indexes: user_id, checked_in_at, (user_id, checked_in_at),
unique foursquare_id, venue_id.

## Sync

`src/services/foursquare/` — `client.ts` + `sync.ts`.

- v2 `GET /v2/users/self/checkins?oauth_token=…&v=20250101&limit=250&
offset=N&sort=oldestfirst`. `sort=oldestfirst` + offset = naturally
  resumable oldest-first walk (the lesson from Trakt/Strava/Last.fm baked in
  from the start): cursor is simply `COUNT(checkins)` locally; an interrupted
  batch resumes exactly where it stopped; `foursquare_id` unique index makes
  overlap idempotent.
- `syncPlaces(env, { maxPages = 8 })` → `{ synced, remaining }` where
  remaining derives from `response.checkins.count - (offset + fetched)`.
  Bounded batches; the admin route loops until remaining 0.
- sync_runs domain `places`, syncType `foursquare`.
- afterSync: feed items (`checkin` events, title "Checked in at {venue}",
  sourceId `foursquare:checkin:{foursquare_id}`) and search items
  (entityType `venue`).
- Cron: 6-hour slot, guarded on `env.FOURSQUARE_ACCESS_TOKEN`.

## Routes

`src/routes/places.ts`, registered at `/v1/places`:

- `GET /v1/places/recent?limit&date/from/to` — recent check-ins.
- `GET /v1/places/stats` — total check-ins, unique venues, this-year count,
  top 10 categories, top 10 cities (live aggregation; no stats table).
- Admin: `POST /v1/admin/sync/places` (admin-sync.ts) returning
  `{ status, items_synced, remaining }`.

Both read endpoints follow house conventions (DateFilterQuery, pagination
envelope, cache headers matching listening/recent).

## Docs

CLAUDE.md domain list + env table gain the places domain and
`FOURSQUARE_ACCESS_TOKEN`; `docs/domains/places.md` written from the
watching.md template.

## Out of scope

Venue photos/images pipeline, maps, a website page, category normalization,
stats tables. All deferrable.
