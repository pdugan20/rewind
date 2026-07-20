# Places Domain Implementation Plan

> **For Claude:** execute task-by-task with review between tasks.

**Goal:** Foursquare/Swarm check-ins as the `places` domain, per `docs/plans/2026-07-21-places-domain-design.md` (read it first — schema, sync semantics, and route surface are specified there).

**House patterns to imitate (read before coding):**

- Client: `src/services/trakt/client.ts` (typed request helper, error shape, UA header — Foursquare also sits behind bot protection, send a browser-like User-Agent).
- Bounded resumable sync returning `{ synced, remaining }`: `backfillScrobbles` in `src/services/lastfm/sync.ts` (post-fix version) — same shape here, but simpler because `sort=oldestfirst&offset=` is natively resumable.
- sync_runs lifecycle + afterSync: `src/services/trakt/history-sync.ts`.
- Routes with DateFilterQuery + pagination + OpenAPI schemas: `src/routes/reading.ts` (recent/stats pattern) — places is closest to reading in shape.
- Migration: hand-written like `migrations/0042_trakt_watching.sql` via `drizzle-kit generate --custom`, then sync the meta snapshot (see how 0042 + `migrations/meta/0015_snapshot.json` were reconciled — a stale snapshot causes destructive prompts later; verify with a no-op `npx drizzle-kit generate`).

### Task A: schema + migration + client + sync (TDD)

- `src/db/schema/places.ts` per design; export from wherever schema barrel imports happen (check how other schema files are consumed by `src/db/client.ts` / drizzle config).
- Migration `0043_places_checkins.sql` + snapshot sync + `npm run db:migrate` locally.
- `src/services/foursquare/client.ts`: `FoursquareClient(accessToken)` with `getCheckins({ offset, limit })` calling v2 `users/self/checkins` (`v=20250101`, `sort=oldestfirst`), typed response (items: id, createdAt epoch seconds, shout?, venue: { id, name, categories[{name, primary}], location: { city?, state?, country?, lat?, lng? } } — venue can be MISSING on some legacy checkins; type it optional and the sync skips-and-counts those). Tests with mocked fetch per trakt client.test.ts style.
- `src/services/foursquare/sync.ts`: `syncPlaces(env, options?: { maxPages?: number })` per design — cursor = `COUNT(checkins)` for user, walk `maxPages` (default 8) pages of 250, insert with `onConflictDoNothing` on foursquare_id guarded by `meta.changes` for truthful counts (the episode-sync lesson), `remaining` from the API's total count, sync_runs domain `places` syncType `foursquare`, afterSync feed (`checkin` events, sourceId `foursquare:checkin:{id}`) + search items (entityType `venue`, dedup: only emit a search item for venues not already indexed — or accept upsert semantics if `upsertSearchIndexBatch` handles it; check it). DB-backed tests with a fake client: bounded batch, offset cursor resume, dedup idempotency, missing-venue skip, remaining math.
- Gates: fail-first, full `npm test` green (baseline 1073), tsc clean. Commit per piece or once: `feat(places): checkins schema and foursquare sync`.

### Task B: routes + wiring + docs

- `src/routes/places.ts`: GET `/recent` (DateFilterQuery + limit, newest first, standard pagination envelope) and GET `/stats` (total, unique venues, this_year, top_categories[10], top_cities[10] — live SQL aggregation). OpenAPI schemas + registration in `src/index.ts` under `/v1/places` (check how reading is registered).
- `src/routes/admin-sync.ts`: POST `/admin/sync/places` → loops? No — single call returning `{ status: 'completed', items_synced, remaining }` like listening backfill; the orchestrator loops externally.
- Cron: `0 */6 * * *` case in `src/index.ts`, guarded on `env.FOURSQUARE_ACCESS_TOKEN` (add to `src/types/env.ts` as optional string).
- Docs: CLAUDE.md domain sentence + project-structure + env table; `docs/domains/places.md` short page from the watching.md template. Regenerate OpenAPI snapshots via `npm run spec:update` (snapshot test will demand it).
- DB-backed route tests (seed checkins, hit /recent with date filter, /stats shape) following watching-shows.test.ts style.
- Gates: full suite green, tsc, spec snapshot. Commit: `feat(places): routes, cron, and docs`.

### Orchestrator-held steps (NOT for subagents)

Token capture (browser OAuth), `wrangler secret put FOURSQUARE_ACCESS_TOKEN`, remote migration, deploy, backfill loop, 1Password record.
