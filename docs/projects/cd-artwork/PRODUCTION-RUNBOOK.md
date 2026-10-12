# CD artwork operations

The artwork service deploys independently with `wrangler.cd-artwork.jsonc`. Its two route prefixes share the existing Rewind origin and authenticated API keys. It uses `rewind-db`, `rewind-images` for accepted derivative images, and private `rewind-cd-artwork-private` for source/raw/candidate evidence. The main API and MCP versions can roll independently.

## Read and serve

- `GET /v1/listening/cd-artwork/albums?ids=1,2` returns accepted artwork attachments for the read key's user, at most 20 requested albums.
- `GET /v1/listening/cd-artwork/albums/:id` returns `{album_id, artwork}` and checks album ownership.
- `GET /v1/listening/cd-artwork/assets/:sha256.png` serves only accepted, content-addressed PNG bytes. This public response contains no listening metadata or user identifiers. Source/raw/pending files have no public bucket/domain.
- `GET /v1/listening/cd-artwork/health` requires a read key.

Attachments retain source kind, representative release identity, exact asset hash, geometry, material alpha, ThumbHash and dominant/accent colors. The portfolio server performs a bounded optional batch lookup and preserves existing fallback when unavailable. No API key reaches the browser.

## Enqueue and inspect

Admin routes are under `/v1/admin/cd-artwork`.

`POST /jobs` accepts `album_id`, verified `release_id`, `medium_position`, `source_kind` (`auto`, `retail` or `cover`, default `auto`), optional `image_id`, `cover_url`, reviewed retail `material`, and a bounded `test_tag`. Auto prefers an unambiguous Medium image when present, otherwise selects the album Front cover. Low-resolution sources are held as `needs_better_source`; ambiguity is held for a recorded choice rather than silently selecting another edition. Explicit source kinds support bounded path testing. Stored provenance always retains the resolved retail/cover distinction. Retail material has `inner`, `outer`, `opacity` and `evidence`. Unreviewed material is held before generation. `POST /albums/:id/resolve` returns exact-title/artist release candidates; edition ambiguity requires a recorded selection. It does not claim an owned pressing.

Normal identical requests reuse a stored job without another source lookup or paid request. `refresh_source:true` explicitly refreshes the source; the same bytes still reuse the same job and changed bytes create a new fingerprint. Model/prompt/guide and raw generation identity are separate from processor/material identity, so an adjusted material revision can reuse previously paid raw output.

`GET /jobs` and `GET /jobs/:id` expose only the key's user's bounded job summaries, symbolic failure state and returned usage/cost. `GET /jobs/:id/candidate` provides an authenticated private image for review.

## Review and immutable revision

`POST /jobs/:id/review` takes `decision`, `activate`, and `reviewer`. Acceptance validates candidate geometry and bytes, copies only the derivative into public R2, and records the event. Activation is conditional on the album being unpinned. An active asset cannot be rejected before replacement. New generation or discovery never replaces accepted artwork automatically.

`POST /jobs/:id/material` creates a new immutable revision with reviewed source-specific material and reuses raw output if available. Historical input/provenance is retained. `POST /import` takes multipart `input` JSON and `candidate` PNG for an already prepared master; it cannot trigger an automatic paid submission and still requires review/activation.

## Recovery

The Workflow claims submission and daily admission in D1 before a single OpenAI edit request. Known source/preparation errors occur before that claim. Post-submission transport/storage uncertainty is `provider_unknown`; automatic retry never pays again. Raw bytes are persisted before registration. Processor errors retain the raw object.

- `POST /jobs/:id/recover` reprocesses stored raw output. It never submits to OpenAI.
- `POST /jobs/:id/raw` uploads an existing provider-output PNG for a previously submitted uncertain job whose raw evidence was not persisted. It cannot overwrite different immutable raw bytes or an existing candidate.
- The Image API's synchronous edit response has no guaranteed recovery endpoint after a lost response. If neither provider output nor private raw bytes are recoverable, the uncertain job stays held. A new paid attempt requires a separately explicit new job; it is never an automatic timeout retry.

## Budget, scheduling and rollback

Owner admin controls: `GET /control`, `POST /control` with `enabled` and `daily_limit` (0–10). Default maximum is three submissions per UTC day. Disable blocks new admission/submission; an already submitted request can finish. Raw-only recovery and accepted reads remain available.

Hourly scheduling registers at most three newly scrobbled owner albums since feature activation into an identity hold, using existing Last.fm scrobble timestamps. It does not backfill the old library or mutate scrobbles. `GET /identities` shows the authenticated user’s registered choices/holds. The scheduler dispatches at most two explicitly queued jobs and rechecks at most three registered album identities with a resolved release ID. Unresolved identity holds do not consume those recheck slots. One shared D1 lease prevents overlap, and a shared atomic provider reservation preserves at least 1.1 seconds between MusicBrainz/CAA requests across isolates. Ordinary eligibility is 30 days plus deterministic jitter; transient errors wait at least an hour and honor Retry-After. No library-wide paid backfill is inferred.

Before deployment, run `npm run test:cd-artwork`, `npm run type-check`, focused ESLint and `npm run build:cd-artwork`. Deploy only the separate artwork Worker and the additive `0045_cd_artwork.sql` migration. The production migration is idempotent and does not change listening history.

Rollback pauses processing and rolls back the artwork Worker version/routes while retaining additive state and immutable recovery evidence. Main API calls and old clients continue independently. D1/R2 data is not rolled back by a Worker rollback. Use the prior version recorded in the deployment evidence. Check queue state, unknown outcomes, budget count, candidate integrity and real source/cost evidence before expanding generation.

## Release integration

CI verifies the isolated artwork suite and Worker build alongside the API suite. The existing trusted Deploy workflow applies D1 migrations once through the migration ledger, then deploys the main and independent artwork Workers in its serial deployment batch. Artwork config and processor script changes count as runtime deployment impact. A failure in either deployment prevents the successful deployment checkpoint from advancing. MCP deployment and npm publication retain their existing workflow; release-please owns the final version bump.

The local test configuration uses the compatibility date supported by the pinned workerd binary. Production retains the date configured in `wrangler.cd-artwork.jsonc`; successful local tests do not replace live runtime checks.
