# Prepared Lately snapshot

Execution mode: proportional inline implementation — Rewind owns the producer;
the existing portfolio chat owns rendering. The release batch covers the API producer, portfolio integration, and local
verification. Deployment and live migrations need explicit target authorization.
Release candidates are isolated from unrelated checkout changes.

## Selected behavior

Both homepage cards appear together and remain fixed throughout the visit.
Rewind prepares data in the background; a visitor never waits for Last.fm.
Music means the latest completed, admitted scrobble, not current playback.
The watercolor iPod's independent catalogue and player remain unchanged.

The one-minute refresh checks Last.fm once and reads the latest movie from
already-ingested watch history. It also rechecks image records, so artwork
completion after an ingestion hook is picked up within a subsequent tick.
This does not increase Letterboxd/Plex ingestion frequency or run the complete
listening sync every minute. Previously unknown music metadata/artwork still
depends on the existing catalogue and image ingestion pipeline.

If a new event lacks artwork and the old card has artwork, keep the old card
for at most two minutes of successful refreshes, then publish the new item with
`image: null`. The deadline does not restart for every new short song. With no
previous complete card, publish the available item immediately. An image that
arrives later updates only snapshots served to subsequent visits.

## API contract

`GET /v1/lately`, authenticated with the existing read or admin Bearer key.
The key's `user_id` scopes the snapshot lookup, including auth cache hits.
The current provider credentials belong to user 1, so only that owner has an
automatic producer. Other owners get their own stored row or a 503, never user
1's result. No user selector is accepted from the request.

The response schema is defined in `src/services/lately/schema.ts` and generated
into both OpenAPI snapshots. Stable fields:

- `schema_version`: contract version, currently 1.
- `version`: increasing publication revision per owner, including freshness-only updates.
- `as_of`: start time of the background refresh that produced this pair.
- `music_checked_at`, `movie_checked_at`: last successful source checks, nullable
  before a successful check. Provider failure preserves the previous value.
- `music`: nullable card with `event_id`, nullable `track_id`, `name`, `artist`,
  nullable `album`, `scrobbled_at`, nullable `image`.
- `movie`: nullable card with `event_id`, `movie_id`, `title`, nullable `year`,
  `directors` string array, nullable `content_rating`, nullable `runtime_minutes`,
  `watched_at`, nullable `user_rating`, nullable `image`.
- `image`: `cdn_url`, `width`, `height`, `thumbhash`, `dominant_color`,
  `accent_color`. The latter three are nullable. Music is 150×150; movie is
  150×225. Versioned direct CDN URLs support responsive display at the small
  homepage card sizes. The frontend owns `/listening` and `/watching` links.

`content_rating` is the certification label. `user_rating` is the existing
watch-history star rating. Neither is a TMDB score. Music has no `is_playing`
field: a frozen scrobble snapshot must not be labeled “Now”.

Responses use `Cache-Control: private, no-store` and `Vary: Authorization` to
prevent cross-user HTTP cache reuse. The portfolio may explicitly cache its
authenticated server-side fetch for a short interval, scoped to the owner.
Start with at most 30 seconds and account for the framework's stale-serving
semantics; do not stack the old five-minute movie cache underneath it. This is
a proposed client configuration, not a hard end-to-end freshness SLA.

Before first publication, for an unavailable/corrupt snapshot, or while the
configured exclusion policy differs from the saved one, return:

```json
{ "error": "Lately snapshot not ready", "status": 503 }
```

with `Retry-After: 60`. No synchronous provider fallback or background job is
started by GET. Failed auth remains 401 under the existing middleware.

## Publication and safety

A new `lately_snapshots` D1 row contains the complete JSON response. Publication
is one conditional UPDATE, so a read observes a coherent old or new pair.
A 45-second lease plus unique token fences overlapping jobs. Duplicate or older
scheduled minutes are ignored; an expired job cannot commit or unlock its
successor. The Last.fm fetch is limited to eight seconds. One source failure
retains its last valid card while allowing the other source to update; failure
on a cold start can use stored music without claiming a successful Last.fm check.

Canonical music filters, per-entity filter flags, and the portfolio audiobook
filename guard apply before publication, including retention during errors.
Every owner-bearing metadata/image join is explicitly scoped. The existing
portfolio movie ID exclusions are carried by `LATELY_EXCLUDED_MOVIE_IDS` in
Worker configuration. Invalid configuration fails closed. A policy change
invalidates the old response until the next successful publication.

No personal titles, raw upstream payloads, secrets, or URLs with API keys are
written to refresh logs. GET remains authenticated even though the selected
fields are suitable for the owner's public homepage. Other endpoints retain
their existing behavior.

The API refresh interval, Last.fm's own scrobble delay, optional two-minute
artwork wait, and portfolio cache age are separate. During an outage stale data
can remain available longer; `*_checked_at` reports that fact. There is no
promise of a fresh song every exactly 60 seconds.

## Frontend integration boundary

Read this endpoint directly from a server-only adapter using the existing key;
do not round-trip the portfolio's HTTP handlers. Render both cards from one
response in initial HTML, or one Lately streaming boundary on a cold miss.
Discover both artwork URLs early without requiring the downloads to complete
simultaneously. Preserve the existing layout and fallback appearance.

Pin identity, text, artwork URL, timestamp label, and destination for the visit.
No hydration fetch, 30-second polling, focus/reconnect revalidation, or
`router.refresh()` may replace displayed content. Preserve the first snapshot
on SPA away/back; a full reload starts a new visit. Formatting relative dates
must use one stable time anchor to prevent hydration mismatches. Both null and
error states need explicit treatment without waiting indefinitely for an image.

Roll out the API first. Keep the portfolio change behind its own exposure
control until this endpoint exists and is populated. Against an old API or API
rollback, use the established section fallback; never silently restore the
blocking live-fetch path. Existing consumers remain compatible because the
endpoint and table are additive.

## Verification and release gates

Local checks cover prepared responses, authenticated ownership, source errors,
malformed provider data, filtering/exclusions, metadata/image ownership,
artwork delay and later publication, duplicate ticks, and expired writers.
Real portfolio integration must additionally verify both cards in HTML, image
request start times, hydration/focus/reconnect/SPA stability, provider failure,
and cold/warm production-build latency. Local synthetic tests do not establish
production network performance.

Apply migration `0044_lately_snapshots.sql` before deploying the Worker, then
verify a successful scheduled publication before exposing the client. The SQL
was generated with drizzle-kit against the new isolated schema because the
repository's full migration snapshot history trails existing manual migrations;
no unrelated schema diff is included. Local Workers tests apply the full SQL
migration history.

Rollback: disable the frontend exposure first; roll back the additive Worker
change or remove the one-minute schedule. Keep the table so prepared data is
recoverable. No migration rollback or deletion of live data is required.

## Local batch evidence

- Release candidate rebased onto current main `30579f0`: full API suite,
  99 files and 1,066 tests passed, including all 19 focused Lately tests.
  All 77 automation-policy tests also passed.
- TypeScript, repository ESLint and Prettier, Spectral API lint,
  both OpenAPI snapshots, and the Worker dry-run build passed.
- Two independent GPT-6 Luna medium-effort reviewers checked authorization,
  privacy, concurrency, and failure behavior; one recovery follow-up was run.
  Review found corrupt-state recovery and a future artwork timestamp issue;
  both were fixed with regression coverage. Exclusion lists are bounded to
  stay below D1's parameter limit. Billing totals are not exposed by the tools.
- The isolated portfolio release candidate starts at current main `b479755`.
  All 281 tests passed; the final eager-image change and catalog prerequisite
  passed 34 focused tests, lint, TypeScript, and the enabled production build.
  Two independent frontend reviews found no actionable issues.
- Real local Worker and production-build browser verification passed in both
  checkouts: server snapshot changes did not replace the pair or labels during
  SPA away/back; a full reload used the new pair, with no browser warnings or
  errors. The current-main homepage prerenders both cards with 30-second ISR.
  Local fixtures had null artwork; eager direct image markup is covered by
  SSR/unit tests. Actual CDN timing and live latency await production rollout.
- Authenticated GET against an isolated local D1 fixture returns the prepared
  pair with `private, no-store`. No provider request runs on the read path.
- Read-only production migration inspection confirms only
  `0044_lately_snapshots.sql` is pending. The migration creates one new table;
  it does not modify existing activity records.
- No production migration, deployment, push, or PR was performed. Performance
  improvements in the live website have not yet been measured.

## Release candidate

Branch `feat/prepared-lately` starts from main `30579f0`; only the Lately
implementation and generated API descriptions are included. The portfolio
candidate lives on the same branch name in its own repository, with a separate
small catalog-sync prerequisite required by an existing CI check.

After explicit target authorization, publish scoped PRs and use the existing
CI/merge deployment paths. Rewind deploys first: production D1 `rewind-db`
migration `0044_lately_snapshots.sql`, then Worker `rewind` at `api.rewind.rest`.
Verify a scheduled snapshot before enabling and deploying the portfolio's
`LATELY_PREPARED_ENABLED=true` at `pdugan.com`. The portfolio release README
contains the coordinated sequence and local browser evidence. Neither
original exploration checkout is a deployable release source.
