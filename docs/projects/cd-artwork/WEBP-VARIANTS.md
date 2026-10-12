# Accepted artwork WebP variants

Accepted 1024×1024 PNG artwork remains the canonical asset. A variant is
optional metadata stored in private R2 beside a separate, hash-addressed
`image/webp` object. The producer uses libwebp's lossless and exact modes, then
decodes the output and compares every RGBA byte with the accepted PNG before
publishing the descriptor. Alpha and RGB values under transparent pixels are
included in that comparison. Preparation has fixed 8 MiB source/output bounds.
The descriptor is omitted when the verified WebP is not smaller than its PNG.

Manual acceptance dispatches a variant-only execution of the existing artwork
Workflow using the deterministic ID `webp-v1-<canonical-sha256>`. The automatic
publication path adds a separately checkpointed step to its existing Workflow.
Each step has one retry; repeated approvals reuse the same Workflow ID, and
terminal executions are not restarted. A later approval may create one fixed
recovery Workflow only after the base instance is confirmed errored. Running,
completed, and unknown statuses do not start another instance; repeated
recovery requests deduplicate on the same ID. A dispatch or encoding failure
leaves the accepted PNG and its normal URL available. No paid image generation
is called. Variant URLs are served only when their private index links them to
a currently accepted canonical hash. The PNG route keeps its prior approval
checks and cache behavior.

For each unique accepted hash, the manual path creates at most two variant
Workflow instances total: the initial instance and one recovery after a
confirmed error. Each has at most two encoder attempts. An attempt reads one
canonical PNG, writes and checks one immutable WebP, and may write two small
private descriptor objects; a partial failure can leave an unadvertised R2
object. Each snapshot descriptor reads the private descriptor and hash index,
then checks WebP size, MIME, and ETag. A cold or ETag-changed object also gets
one bounded read and SHA-256 verification. A positive 60-second per-isolate
cache holds only the verified ETag and is capped at 64 hashes; it never stores
image bytes or acceptance/withdrawal state. At most two descriptors are
validated concurrently, even for a 20-album request. Warm validation is three
R2 operations per variant; cold validation is four. Direct WebP delivery checks
both descriptors and accepted-job state and hashes the bounded response body
before returning it. Actual billing depends on the account's Cloudflare plan
and usage; this change makes no dollar estimate.

## Local fixture procedure

This procedure is bounded to one synthetic 1024×1024 fixture in the local
Workers test runtime. It never connects to or writes to production:

```bash
node scripts/cd-artwork/export-discman-fixture.mjs
npx vitest run -c vitest.cd-artwork.config.ts \
  src/services/cd-artwork/artwork.test.ts \
  -t 'advertises and serves only the verified optional WebP'
npx vitest run -c vitest.cd-artwork.config.ts \
  src/services/cd-artwork/webp-variant.test.ts
```

The exporter runs that Worker test against local Workerd and writes its actual
revision-1 PNG-only response, revision-2 response with variants, and exact
canonical PNG/WebP route bytes under the ignored
`.codex/discman-delivery-integration/` directory. Both revisions use synthetic
album 1; the fixture contains only public response fields. The test also checks
approved-only serving, descriptor agreement, object digest, and unchanged PNG
identity. The codec test compares every RGBA byte (including hidden RGB under
transparent pixels), rejects 16-bit PNGs rather than truncating them, and
exercises the fixed input bounds. Local R2 state lives only in the test runtime.

## Source verification

On 2026-10-12, the focused artwork command passed 125 Vitest tests and 7 Node
pipeline tests, including the bounded backfill endpoint. After adding the
16-bit boundary regression, the focused codec file passed all 3 tests. The
broader `npm test` passed 103 files and 1,104 tests before that isolated codec
case was added.
`npm run type-check`, focused ESLint, Prettier, and `git diff --check` passed.
The final artwork Worker dry-run built at 1,956.28 KiB (608.93 KiB gzip); the root
`npm run build` dry-run built at 2,257.69 KiB (402.16 KiB gzip). Local test runs
emit the existing Vectorize local-development warning; it did not fail tests.
These checks establish source behavior only. Deployment verification and the
separately approved bounded live backfill are recorded as release operations;
this feature does not invoke paid image generation.

## Existing accepted images and rollout

No automatic R2 listing or live backfill is performed. After the producer is
deployed, an owner can preview an explicit set of up to 20 album IDs through
the admin endpoint. The body defaults to dry run when `dry_run` is omitted:

```bash
curl --fail-with-body -X POST "$REWIND_API_BASE/v1/admin/cd-artwork/webp-backfill" \
  -H "Authorization: Bearer $REWIND_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"album_ids":[1],"dry_run":true}'
```

The endpoint rejects IDs not owned by the admin key's account, deduplicates
repeated IDs and canonical hashes, and selects only the account-scoped active
accepted snapshot. Hidden, withdrawn, rejected, and inactive assets are
excluded; an owned album without active accepted art appears in
`skipped_album_ids`. The response reports per-hash status and counts. Review the
preview, then obtain separate owner approval for live writes before repeating
the same finite body with `"dry_run":false`. This dispatches only the selected
variant-only workflows; it never calls paid image generation. Split larger
sets into reviewed batches of at most 20 IDs. Each unique hash has at most one
base and one error-only recovery workflow, and repeated requests reuse those
IDs. `already_prepared`, `created`, `already_active`, `already_complete`,
`base_status_unknown`, `recovery_created`, `recovery_exists`,
`recovery_status_unknown`, and `not_accepted` distinguish outcomes without
claiming unavailable variants succeeded. Confirm public snapshots contain
verified descriptors and compare byte counts after each batch; failed or
unknown outcomes stay PNG-only and need a separately bounded retry decision.

Deploy the producer before enabling a consumer that prefers variants. Rollback
by disabling the consumer preference or reverting the producer code; clients
continue to receive the canonical PNG. Existing immutable variants can remain
unreferenced in R2 until ordinary retention policy removes them. Production
deployment and any live backfill are separate release actions.
