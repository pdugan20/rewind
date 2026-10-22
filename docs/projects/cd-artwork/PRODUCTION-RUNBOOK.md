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

`POST /jobs` accepts `album_id`, verified `release_id`, `medium_position`, `source_kind` (`auto`, `retail` or `cover`, default `auto`), optional `image_id`, `cover_url`, reviewed retail `material`, and a bounded `test_tag`. Auto prefers an unambiguous Medium image when present, otherwise selects the album Front cover. Low-resolution sources are held as `needs_better_source`; ambiguity is held for a recorded choice rather than silently selecting another edition. Explicit source kinds support bounded path testing. Stored provenance always retains the resolved retail/cover distinction. Retail material has `inner`, `outer`, `opacity` and `evidence`. Manual retail requests hold unreviewed material before generation. Automatic retail jobs obtain source-specific material evidence and verify the final derivative before publication. `POST /albums/:id/resolve` returns exact-title/artist release candidates; edition ambiguity requires a recorded selection. It does not claim an owned pressing.

Normal identical requests reuse a stored job without another source lookup or paid request. `refresh_source:true` explicitly refreshes the source; the same bytes still reuse the same job and changed bytes create a new fingerprint. Model/prompt/guide and raw generation identity are separate from processor/material identity, so an adjusted material revision can reuse previously paid raw output.

`GET /jobs` and `GET /jobs/:id` expose only the key's user's bounded job summaries, symbolic failure state and returned usage/cost. `GET /jobs/:id/candidate` provides an authenticated private image for review.

## Review and immutable revision

`POST /jobs/:id/review` takes `decision`, `activate`, and `reviewer`. Acceptance validates candidate geometry and bytes, copies only the derivative into public R2, and records the event. Activation is conditional on the album being unpinned. An active asset cannot be rejected before replacement. Manual generation and discovery never replace accepted artwork automatically. Opt-in play-triggered processing can automatically publish a verified result when the current identity and expected active artwork still match; pinned artwork and accepted retail discs are preserved. See AUTOMATIC-GENERATION.md.

`POST /jobs/:id/material` creates a new immutable revision with reviewed source-specific material and reuses raw output if available. Historical input/provenance is retained. `POST /import` takes multipart `input` JSON and `candidate` PNG for an already prepared master; it cannot trigger an automatic paid submission and still requires review/activation.

## Recovery

The Workflow claims submission and daily admission in D1 before a single OpenAI edit request. Known source/preparation errors occur before that claim. Post-submission transport/storage uncertainty is `provider_unknown`; automatic retry never pays again. Raw bytes are persisted before registration. Processor errors retain the raw object.

Known rate-limit rejections with `rate_limit_exceeded` can retry within the same
job, at most three submissions in total. The Workflow sleeps for exponential
backoff or the provider's longer `Retry-After`; the database also enforces the
due time and attempt ceiling. Quota errors, other client rejections, server
errors, and uncertain submissions do not enter that retry path. Delays longer
than a day remain held for operator attention.

Admin job summaries include `provider_error`: HTTP status, bounded code/type/
parameter symbols, request ID, attempt and next retry time. This diagnostic
field excludes provider messages, request bodies and credentials. Private job
provenance retains at most 500 characters of provider message for operator
diagnosis, with the configured key, input prompt, key-shaped strings, Bearer
values and URLs redacted; it is not returned by job summaries.
Discovery reflects generation failure, uncertainty, pending retries or review
instead of leaving a failed job marked queued. Existing stale queue statuses
are reconciled in bounded batches without submitting generation. A failed or
uncertain generation permits a new-listen status check after one hour; it does
not authorize another paid submission. Repair the cause and explicitly replay
the owned album through the existing automatic endpoint when necessary.

- `POST /jobs/:id/recover` reprocesses stored raw output. It never submits to OpenAI.
- `POST /jobs/:id/raw` uploads an existing provider-output PNG for a previously submitted uncertain job whose raw evidence was not persisted. It cannot overwrite different immutable raw bytes or an existing candidate.
- The Image API's synchronous edit response has no guaranteed recovery endpoint after a lost response. If neither provider output nor private raw bytes are recoverable, the uncertain job stays held. A new paid attempt requires a separately explicit new job; it is never an automatic timeout retry.

## Scheduling and rollback

Owner admin controls: `GET /control`, `POST /control` with `enabled` and optional `automatic_enabled`. There is no daily generation cap. `GET /control` returns `daily_limit: null`; the retired field is rejected on writes. The legacy database column is retained only for schema/rollback compatibility and is not enforced. `budget_day` and `submitted_count` track daily usage without blocking work. Disable blocks new admission/submission; an already submitted request can finish. Raw-only recovery and accepted reads remain available.

New listening events admit discovery atomically with the scrobble insert through migration 0046. For a registered CD edition without active accepted retail artwork, one pending check is admitted per user/album. The first event after rollout supersedes the old monthly eligibility date; completed checks establish a seven-day cooldown. Another play after that cooldown is required: expiry alone does not schedule a search. Unknown owner albums remain identity holds, and historical events before feature activation and filtered entities are excluded. No listening history is rewritten or scanned for enrollment.

Both cron and manual listening sync notify the artwork Worker through its internal `ArtworkDiscoveryService` binding, after newly recorded plays or partial sync failure. Successful empty syncs do not poll the artwork outbox. Notification only dispatches already admitted events, bounded to 20 per call. `CdDiscoveryWorkflow` checks the registered edition without downloading images or submitting generation. Stable per-check instance IDs deduplicate concurrent dispatch and lost create responses. Provider failures retry at most three times after the initial attempt with 1h/2h/4h exponential delays, honoring longer Retry-After values. Completion records discovery and a seven-day cooldown; current artwork and submission accounting remain untouched.

The artwork cron runs daily at 04:20 UTC solely to recover undispatched/interrupted checks and up to two explicitly queued generation jobs. It never scans due albums. Errored discovery instances get at most two recovery restarts, after which the event becomes terminal so future eligible plays cannot be blocked forever; missing instances may be recreated with the same ID. The shared atomic provider reservation still spaces MusicBrainz/CAA requests by at least 1.1 seconds. `POST /recheck` uses the same recovery-only behavior.

Before an authorized release, run `npm run test:cd-artwork`, `npm run type-check`, focused ESLint and `npm run build:cd-artwork`. Review the actual migration diff; old rollout recipes are not a request to reapply migrations. Use the trusted release workflow and its migration ledger. The October 13 source recovery adds no migration.

Rollback pauses processing and rolls back the artwork Worker version/routes while retaining additive state and immutable recovery evidence. Main API calls and old clients continue independently. D1/R2 data is not rolled back by a Worker rollback. Use the prior version recorded in the deployment evidence. Check queue state, unknown outcomes, budget count, candidate integrity and real source/cost evidence before expanding generation.

## Release integration

CI verifies the isolated artwork suite and Worker build alongside the API suite. The trusted Deploy workflow classifies API and artwork impact separately and applies D1 migrations once through the migration ledger. Artwork configuration, processor scripts, runtime code, and assets trigger artwork deployment; API-only changes do not. Shared auth, storage, image helpers, and runtime dependencies conservatively affect both. When both Workers change, artwork deploys first. A failed deployment prevents the successful checkpoint from advancing. MCP deployment and npm publication retain their existing workflow; release-please owns the final version bump.

The local test configuration uses the compatibility date supported by the pinned workerd binary. Production retains the date configured in `wrangler.cd-artwork.jsonc`; successful local tests do not replace live runtime checks.

## Reviewed master coverage

`POST /v1/admin/cd-artwork/import-reviewed` accepts multipart `input` JSON, exact `source` and `candidate` files, and optional `raw`, `patch`, `template` and `master` evidence files. It validates without mutation by default; `?apply=true` persists a private pending job. It never fetches providers, dispatches a Workflow, or claims a paid submission. The older `/import` remains available for pipeline-prepared MusicBrainz work.

The admin supplies an exact expected album title and artist, reviewed source URL, source/candidate SHA-256 hashes, material boundary evidence, original review evidence and structured processing evidence with hashes for each supplied evidence file. The backend checks user ownership, exact normalized album identity, approved public source URL shape, all file hashes and fixed candidate geometry. Original source identity and artistic review are explicit admin attestations backed by immutable evidence; this path does not claim to independently identify artwork from its pixels. MusicBrainz URLs must match the supplied release UUID. Medium selection remains an explicit reviewed admin attestation; this no-fetch path does not re-query MusicBrainz media. Discogs and album-cover sources can retain reviewed-source provenance without inventing a MusicBrainz release. Cover sources on Rewind CDN must reference the same album ID.

Reviewed-source attachments return nullable `release_id` and `medium_position` and `identity_type: reviewed_source`. Existing MusicBrainz attachments retain their IDs. Unknown identity uses the existing internal empty-release sentinel, but admin projections return null, and activating source-only artwork preserves any already verified discovery identity. Explicit review and unpinned activation remain necessary; an import does not replace an active asset by itself.

Prepare a private finite manifest with `entries`, each containing `input` and relative file paths under `files`, all contained within the manifest directory. Absolute paths, traversal and escaping symlinks are rejected. Run `REWIND_ADMIN_KEY` through the process environment, never a command argument or saved manifest. `node scripts/cd-artwork/import-reviewed.mjs --manifest .codex/reviewed-import-plan.json` validates the entire batch before any mutation. Add `--apply` to import, and `--activate --reviewer "owner approval reference"` only for an explicitly approved activation batch. The importer skips an already active exact hash, rejects pinned replacements and previously rejected job states, and reports aggregate counts only. Partial imports can be retried with the same manifest and bytes. Keep manifests, account-specific mappings and receipts private; do not commit listening history or credentials.

A successful registry import does not guarantee coverage for every recent album. Resolve unmatched identity explicitly and retain marker fallback for albums with no accepted master; new paid generation requires its own approved finite batch.

## Automatic processing

Migration 0049 starts `automatic_enabled` at zero. Owner-only `GET /control` reports the switch; `POST /control` accepts optional `automatic_enabled` alongside `enabled`. Omitting it preserves the current value. There is no daily cap; an automatic job has at most two visual-processing attempts, each with one cover judgment or two retail judgments. Expired interruption claims recover within that ceiling, without another paid image-generation request. Uncertain verdicts remain private. The owned admin `GET /jobs/:id/raw` exposes only persisted raw pixels for exception review, with no public caching; existing material revisions/import/review paths can complete a human-reviewed replacement without paying for another image generation.

`POST /albums/:id/automatic` previews source selection by default. `?apply=true` replays the automatic policy for one owned, unfiltered album with a recorded album play, requires the automation switch, and dispatches the existing generation Workflow. It never inserts listening history. For explicit replay of historical albums, legacy track associations can supply observed-track evidence; private provenance distinguishes this from explicit per-play album snapshots. Ordinary new-play admission and cover checks require the new snapshot attribution. Accepted retail assets and pins are preserved; accepted cover art is reused unless confidently matched retail art is available.

Cover-only `/jobs` requests may use `release_id: null`, `medium_position: null`, and `source_kind: cover`. That path validates provider album/artist metadata and an observed track, and selects the provider cover itself; arbitrary supplied cover URLs are rejected. The accepted response remains compatible with MCP 1.1.0: cover-only assets return nullable release fields and `identity_type: reviewed_source`, while private provenance records the exact verification evidence.

For a new rollout, review the actual migration and Worker changes before enabling automation. Preview a finite real-history sample, then apply only an explicitly authorized batch and inspect returned jobs and published bytes. Confirm all previously accepted assets retain their hashes. Pause `automatic_enabled` to stop new automatic submissions and publication; use `enabled` to stop all artwork work. Keep schema, evidence and immutable public assets on rollback.

A stored Apple binding is verified even when a retail scan is available; contradictory metadata stays a hold. Provider outages can use independently verified cover art while retail lookup remains pending with backoff. Migration 0050 enforces one unfinished automatic job per album across source transitions. The retail retry waits for the cover job to finish and then uses the accepted cover as the expected active asset for an upgrade.

Configure the existing `APPLE_MUSIC_DEVELOPER_TOKEN` as an artwork Worker secret to use authenticated Apple Music catalog search and album-owned tracks for cover verification. The public iTunes catalog remains available when that secret is absent. Both paths enforce the same exact artist/album and observed-track checks; credentials are sent only to the Apple Music API and authenticated requests never follow redirects. Renew expiring developer tokens using the existing private signing-key procedure without recording credentials in release evidence.

Automatic retail searches filter CD/HDCD releases. Later cover upgrades retain the original verified edition first and can inspect alternative CD editions within the same proven release group, capped at three distinct IDs overall. Existing retail art and pins are preserved. Album-cover generation itself never requires a CD release.

## Generic fallback publication

Album lookups may return optional `fallback_artwork` alongside accepted album artwork. It describes a reviewed generic Sony CD-R in canonical geometry, with a PNG URL and optional WebP variant. The descriptor is scoped to the authenticated owner; its public image bytes contain no listening metadata.

`POST /v1/admin/cd-artwork/fallback` validates multipart `input` and `candidate` files by default. `?apply=true` publishes a reviewed descriptor only when `expected_sha256` matches the currently selected hash, or is null for the first descriptor. Optional original source evidence must match its supplied digest. A losing conditional write must not authorize its candidate for public asset reads. Successful historical hashes remain immutable and readable after replacement. If public-read authorization fails after descriptor publication, retry the same selected hash to complete it.

## Source recovery and deployed drift

See [the October 13 reconciliation](../../maintenance/2026-10-13-cd-artwork-reconciliation.md). It distinguishes the recovered branch, the restored deployed version, and the additional local fixes. Commit and review runtime changes before publishing them; a manual deployment from dirty source can be replaced by the next automatic release from main. The [maintenance closeout](../../maintenance/2026-10-13-closeout.md) separates API/artwork deployment impact and adds source checks. Use `npm run deployment:check` to inspect the active versions and `npm run deploy:artwork` for an approved artwork release. A clean committed checkout, known production source, and full Git source tags are required. Unknown deployed source blocks replacement until it is reconciled; do not bypass the guard to clear an error.

## Automated reprocessing

Source prepared October 13; release and live reset verification are still pending.

`POST /v1/admin/cd-artwork/reprocess` accepts `album_ids` with at most20 owned
albums and `dry_run`, defaulttrue. It classifies the whole requested batch before
writing. Eligible outdated selections are withdrawn using a conditional update,
and the existing durable discovery outbox receives the album. The normal source
lookup, native-source or OpenAI rendering, finishing, final inspection and
conditional activation run afterward. The request does not import images,
accept candidates, delete immutable evidence, or insert listening events.

Pins, explicit owner review holds, current processing and already queued checks
are preserved. Current shared-policy accepted results remain selected. Successful
v8 results already passed shared-edge, source/material and final-render checks;
v9's advisory material confidence is compatible with those accepted results.
Earlier manual selections and artwork lacking that proof must be reprocessed.

Scheduled recovery also reconsiders established artwork records from older
policies in small batches. It does not scan or enroll the listening library.
A failed job from the current processor is not retried indefinitely. An explicit
finite request can enroll an existing historical album with a recorded play;
it cannot create a fake play or bypass album identity verification.

Policyv9 makes uncertain center material advisory. Ambiguous or unsafe alpha
proposals retain the source appearance and still receive final artwork grading.
Only confidently supported, unprinted plastic can have alpha reconstructed;
ink and metal stay intact. Wrong artwork, lost lettering, visible defects and
gross geometry problems remain publication failures. The separate
`no_added_rim_effects` flag rejects invented rainbow/chrome/glow details anywhere
on the final disc, including rings inside the shared neutral outer band.
