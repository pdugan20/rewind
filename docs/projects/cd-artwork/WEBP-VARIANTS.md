# Accepted artwork WebP variants

## Delivery variants — version 2

Version 2 replaces the lossless variant as the one the producer prepares.
The lossless files were still about 0.6–0.8 MB per disc, and most discs had
none, so the Discman downloaded 1.3–1.6 MB PNGs and its side discs arrived
after the player. A version 2 variant is lossy WebP at quality 95 with a
lossless alpha plane (`alpha_quality` 100, `exact`, sharp YUV). After
encoding, the producer decodes it, requires every alpha byte to match the
PNG, and requires visible RGB (weighted by alpha) to stay at or above 40 dB
PSNR; real disc art measured about 43.5 dB. Below the floor it uses the exact
lossless encode instead, and it keeps whichever verified encode is smaller,
so flat or graphic art is never larger than before. On the current
collection that is about 130–200 KB per disc, roughly a tenth of the PNG. At
the Discman's 2× display size, rendered discs were indistinguishable from the
PNG, including fine rim lettering.

Each version has its own descriptor and index keys
(`cd-artwork-variants/v2/<canonical>.json` and
`cd-artwork-variants/by-hash/v2/<variant>.json`); the WebP object stays keyed
by its own hash, so identical bytes are shared. Snapshots advertise the
version 2 variant when it verifies and otherwise the earlier lossless one, so
albums keep a WebP during the rollout. The asset route accepts either.
Version 2 Workflows use `webp-v2-<canonical>` and `webp-v2-r1-<canonical>`,
so albums with a completed version 1 Workflow can be prepared again. The
backfill reports `already_prepared` only for version 2, and otherwise follows
the procedure below. Consumers need no change: the descriptor fields and URL
shape are the same.

The rest of this page describes version 1, the lossless variant. Its
fidelity statements apply to version 1 files only.

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
then checks WebP size, MIME, and ETag. Once a variant's bytes have been hashed,
D1 table `cd_artwork_variant_checks` (migration 0054) records the object ETag
and byte count they were hashed under. While the stored object still has that
ETag, later snapshots advertise the variant without downloading it again; a
missing record or a changed ETag gets one bounded read and SHA-256 verification
before the variant is advertised, so replaced or corrupt bytes are never
trusted. A positive 60-second per-isolate cache also holds only the verified
ETag and is capped at 64 hashes; neither store holds image bytes or
acceptance/withdrawal state. A request validates all of its descriptors (at most 20) in parallel within a 500 ms budget. Lookups that miss the budget are left
out of that response and finish in the background, recording their ETag so the
next snapshot can advertise them. Warm or recorded validation is three R2
operations and one D1 read per variant, issued in two parallel rounds (the
descriptor with its D1 records, then the index with the object's headers);
cold validation adds one R2 read and one D1 write. Direct WebP delivery checks
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
final broader `npm test` passed 103 files and 1,104 tests after that regression.
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

## Production verification

PR [#315](https://github.com/pdugan20/rewind/pull/315) merged on 2026-10-12 as
`25e9125ee6ac4ddb60fd1a8cd9e4d00ae821484a`. Its [protected CI run](https://github.com/pdugan20/rewind/actions/runs/38295289225)
passed. The [main CI run](https://github.com/pdugan20/rewind/actions/runs/38295712990)
and [automatic Deploy run](https://github.com/pdugan20/rewind/actions/runs/38296207560)
also passed. Deployment published artwork Worker version
`5b329225-7149-4f0c-b196-358a43825618` at `https://api.rewind.rest`; no D1
migration was needed.

The bounded owner backfill requested five explicit album IDs. Two had active
accepted artwork and produced two variant-only Workflow instances; three had
no active accepted snapshot and were skipped. The resulting public snapshot
advertised two variants. Production PNG and WebP responses both matched their
SHA-256 descriptors, decoded to 1024×1024, and had identical RGBA pixels. The
two PNGs totaled 3,334,727 bytes and the WebPs 1,743,746 bytes, saving
1,590,981 bytes (47.7%). No paid image API or listening-history write occurred.
