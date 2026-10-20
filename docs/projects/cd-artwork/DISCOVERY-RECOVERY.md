# Artwork discovery and policy recovery

Execution mode: proportional inline implementation — Rewind discovery and recovery,
with a separate portfolio routing correction and two bounded independent reviews.

## Outcome and scope

Recent listening with usable source artwork should pass through ordinary discovery,
validation, publication and shelf rebuilding. Provider spelling differences must not
strand an album, and completed failures made under obsolete discovery logic must
be recoverable without an album-specific reset or fabricated listening event.

This change preserves the accepted-artwork shelf requirement, manual review holds,
pins, visibility decisions, ownership checks and generation deduplication. It adds
no library enrollment, history reassignment, new endpoint, schema migration or
consumer response requirement. No image generation is run during local verification.

## Identity and source selection

Artwork providers share a narrow name comparison: Unicode decomposition, combining
mark removal, punctuation normalization, case and spacing. Words, articles, guest
credits and edition qualifiers are not discarded by artist comparison. Album title,
release group, medium and observed-track checks remain separate requirements.

A stored MusicBrainz artist ID takes precedence over spelling. A different returned
ID is a hard conflict. Without that binding, the release credit or canonical name
can match; otherwise an alias must come from the exact credited MusicBrainz artist
entity. Apple cover selection still requires album-artist identity and a played
track belonging to the returned album. Contradictory stored catalog evidence cannot
be overridden by selecting a retail scan.

An unresolved MusicBrainz name can fall back to independently verified catalog
cover evidence. Provider transport failures, invalid JSON, rate limits and server
errors remain retryable, rather than being recorded as missing artwork. A failure
of the cover fallback is not retried immediately as though it were a retail failure.

For a verified single-CD release, inspect a bounded stable set of approved Medium
images, excluding contradictory medium labels and matrix images. Prefer the
largest usable scan, breaking ties by stable image ID. This selects representative
artwork for a verified medium; it never establishes ownership of a pressing. Stored
source evidence records scan selection and source attempts. A transient failure of
one scan permits another usable scan; if all retail options remain unavailable,
retain retry evidence while using a verified cover where possible.

## Recovery and idempotence

The policy identifier and recoverable error codes belong to
[`discovery-policy.ts`](../../../src/services/cd-artwork/discovery-policy.ts).
They are independent of the renderer fingerprint. Bump the discovery policy only
for a change that can resolve the listed source failures; pixel-processing changes
must not automatically replay completed catalog failures. The fingerprint split
preserves the deployed rendering identifier for the exact unchanged rendering
inputs; an integration test checks discovery edits retain it and rendering edits
invalidate it, preserving existing paid-generation deduplication.

The existing artwork scheduled handler selects only already-enrolled owner albums
with a completed relevant source failure from an older policy. Each run prioritizes the most recently checked failures and admits at
most two. Active artwork, hidden artwork, pins, review holds, identity conflicts,
filtered entities, unfinished checks and active processing jobs are excluded. The
existing outbox and unique unfinished-check index are reused. Admission and a
policy/check audit event are transactional; overlapping handlers admit one check.
A completed retry is not admitted repeatedly under the same policy, even if it fails
again. Normal listening-triggered admission retains its cooldown behavior.

Existing Workflow backoff and bounded interruption recovery remain responsible for
provider outages. This revision does not convert unresolved or conflicting catalog
identities into repeated paid image requests.

## Integration and release gates

Only the artwork Worker needs deployment for backend behavior. The root Worker and
public artwork/shelf contracts remain compatible. Accepted artwork appears on the
next ordinary root listening refresh; discovery completion alone does not prove
that the public shelf changed. The existing artwork schedule is authoritative in
[`wrangler.cd-artwork.jsonc`](../../../wrangler.cd-artwork.jsonc).

The portfolio change separately makes every Discman entry render over the homepage
and close to `/`. Removing route interception prevents the listening archive or
another originating page from becoming the background. Existing player preparation,
scroll locking, entrance and dismissal motion remain in use.

Local tests exercise real D1 triggers and scheduled admission with synthetic provider
responses, source selection, actual generation/verification Workflow methods,
conditional acceptance and public shelf projection. Repeated scheduling and another
play must create no duplicate processing or provider requests. Negative cases cover
conflicting IDs, wrong alias entities, distinct artists, media ambiguity, holds,
filters, ownership and concurrent recovery.

Source readiness is separate from rollout. Deployment, production replay and paid
provider use need Patrick's release authorization. After release, observe the normal
scheduled recovery, original provider calls, verified publication and subsequent
shelf refresh. Do not inject a source, accept an image manually, reset one album or
insert synthetic production scrobbles to make the verification pass.

Rollback the artwork Worker to stop the new policy admissions. Already-admitted
outbox work and audit evidence remain; the existing automation kill switch can stop
processing if necessary. No migration needs reversal.
