# Automatic artwork pipeline repair

The post-release audit found one remaining cover fallback whose real CD upgrade
had failed before the geometry repair. Its verified CD source existed in the job
ledger but was absent from the active cover's release binding. A later catalog
search could miss that pressing and silently reuse the cover. Source selection now
revisits remembered automatic CD candidates before searching again, scoped to the
same user and album and revalidated against current catalog and archive metadata.
Stale identities are skipped; provider failures keep their existing backoff.
This follow-up still requires live deployment and publication verification.

The existing-artwork reset was released through PR323 and admitted the requested
batch into the normal automated pipeline. It exposed two shared gaps: transparent
pale discs were measured against a white matte, and catalog formatting or stale
bindings could strand source lookup. The repair described under natural-flow
recovery below addresses those gaps and connects failed renders to automatic
source recovery. PR324 released those fixes, and all eight remaining failures
published automatically. Their public PNG/WebP downloads and digests were
verified, every PNG passed canonical geometry, and the eleven existing accepted
assets remained unchanged. Diagnostic images were never imported as replacements.

Consumer verification exposed a separate delivery problem: a five-album manifest
took about two seconds while the portfolio's artwork deadline was1.5 seconds.
Optional WebP verification could therefore hide every published PNG. The delivery
follow-up returns the authoritative D1 snapshot and bounds optional WebP and
fallback enrichment to500ms after that snapshot resolves. Late reads stop without
changing the returned entries; corrupt variants still undergo the same integrity
checks. Its deployed latency and the existing portfolio response must be verified
separately from the already completed artwork publication.

Earlier material release: the uncapped Worker with full-pixel material proposal measurement
is deployed at `2867661f-86d9-4a35-80de-ee6c43dadaa6`. Four fresh live samples
have published automatically: one native retail source, two restored retail
sources and one cover-generated design. Their public PNG/WebP hashes and exact
renderer reproduction were verified, with valid geometry and protected pixels.
The12 earlier accepted assets and original held-job history remain unchanged.
Control reads report no daily generation limit; usage accounting, enable controls,
duplicate prevention and bounded retries remain. No migration or counter reset
was required. The portfolio remains local and uses public Rewind. This live batch
replayed real recorded listening history, rather than fabricating new plays;
production's listening dispatcher binding was independently confirmed.

Execution mode: proportional inline implementation — preserve the two existing
checkouts, implement sequentially, then run independent bounded review.

## Approved cap removal follow-up

Patrick explicitly corrected the inherited three-per-day cap and approved its
removal. No daily allowance remains in submission eligibility. Daily counters
remain usage accounting only. Owner-only control reads report `daily_limit: null`;
control writes accept enable toggles and reject the retired limit field. The
legacy column remains for rollback/schema compatibility and is not enforced.
Disable and automatic-disable, catalog ownership/identity, conditional publication,
single submission claims, raw recovery, and source/validation attempt bounds are
retained. No migration or production counter reset is required. 209 artwork tests, seven standalone checks, TypeScript, focused ESLint and the
Worker dry build passed. Two focused GPT-6 Luna medium reviews found no code
defect; their runbook mismatch was corrected.
The named live sample batch has one native retail result and three queued
restoration/cover candidates. The latter must run through normal verification
and conditional public publication, with no manual material fix or acceptance.

## Live measurement follow-up

The four-sample live replay published native retail, restored retail and cover-based
artwork through the public API. A fourth retail restoration was held: sparse ray
measurement proposed an outer material feather containing28 dark face pixels.
The full-pixel guard correctly refused to alter those pixels. The shared proposal
measurement now checks every normalized pixel shell before proposing a region,
with one-pixel boundary erosion covering the renderer feather. No album-specific
coordinates, opacity, overrides or manual acceptances are introduced. The strict
pixel guard, semantic material check and final source/light/dark inspection remain.
A regression places a dark pixel between the former sampled rays and requires all
proposed material regions to pass the unchanged full-pixel guard. Two focused
GPT-6 Luna medium reviews found no introduced geometry or proof-binding defect.
The old held job is preserved. A follow-up uses normal automatic policy under the
new processor fingerprint, without resetting validation or rewriting evidence.

## Source verification checkpoint

The selected Small edge remains identical for both source kinds. A separate
material stage now runs before the final light/dark inspection. Cover generations
reserve an unprinted center from canonical radius60 to88; the finishing renderer
supplies real alpha117 there, retaining the narrow physical spindle lip. Retail
source PNG transparency is retained without a material classifier. Opaque scans
use code-measured complete neutral annuli; the material classifier may choose a
measured region ID, never coordinates. Only source-supported, unprinted,
non-metallic plastic is eligible. Color/dark/deleted pixels anywhere in the
modified region, including feathering, hold the result; protected face, hole and
outer finish remain byte-identical. Source hub crops follow measured registration,
with the whole source shown if its center cannot be measured.

Retail printed coverage can vary. Native alpha preserves irregular or partially
printed hubs. Reconstructing photographed alpha currently requires a complete
safe annulus; ambiguous or partially printed photographic regions stay private.
Neither RGB thresholds nor model confidence prove material identity. White ink
and metal can resemble clear plastic, so source classification and a separate
final source/light/dark inspection remain necessary, fallible checks. There is no
album-specific geometry or owner approval queue in this automatic path. Held
results retain accepted art or the existing Sony fallback.

Cached material proof binds the source, raw bytes, normalized base, policy and
finished material hash. Recovery reproduces the exact finished bytes; changed
masks or hashes are rejected. Temporary classifier/verifier outages now retain a
five-minute claim for one recovery attempt using saved raw bytes, then stop after
two attempts. Quality uncertainty remains a bounded quality hold.

The updated local mix has three new cover generations, earlier Tool/Radiohead
restorations passed through current measured material handling, and native Wilco.
All six geometry and protected-pixel checks pass. Actual final-render inspections
passed for all six. Tool uses measured radius63–81, Radiohead63–76; these values
are derived evidence, not album configuration. Wilco's existing alpha is retained.
The comparison shows each center on light and dark backgrounds next to its CD.
Three new image calls totaled an estimated $0.226093, excluding classifier,
verifier and review inference. Private receipts and source/output hashes are in
`.codex/hub-finish-batch` and `.codex/hub-material-batch`.

Strategy: `shared-edge-and-source-shaped-hub-v3`; material policy:
`source-shaped-clear-plastic-v1`; final policy:
`source-shaped-hub-material-fidelity-v8`. Processor hash:
`6b8d6c8836f68f8e0e9720618cbb5cbac94e367bc7a58962338b5b9b5dc55292`.
The final 205-test artwork suite and seven standalone checks passed, including
cache replay/tampering, recovery exhaustion and the refined source crop. TypeScript, focused
ESLint, format and Worker dry build passed. A prior parallel suite run hit an
existing WebP test timeout; reducing test workers to two passed without changing
its assertions or timeout. Two GPT-6 Luna medium reviewers found the outage retry
bug (fixed) and the inherent material-classification limit (recorded above);
re-review found no concrete remaining pixel/recovery defect. Exact review cost is
unavailable. This is local evidence, not production acceptance or publication.

Portfolio lint/TypeScript and desktop/390px checks passed; all images load without
overflow, Tycho reaches Spinning and lid interaction works. Sony shell hash stays
unchanged. No backend deployment, public artwork mutation, production cap change
or portfolio deployment occurred in this batch. The release boundary remains
public Rewind verification, then Patrick's portfolio review before deployment.

## Previous local checkpoint

The latest selected finish is now shared across retail artwork and cover-generated
artwork: canonical outer radius 480, hole radius 60, and a ten-pixel neutral
silver-gray outer band starting at radius 470. The existing automatic normalizer
applies it before visual verification; generated artwork receives the identical
finish as native artwork. Source-specific center print and alpha are retained.
There are no album-specific edge settings. The image model is asked to preserve
artwork and leave this outer finish to the renderer. Cache identity includes the
new renderer strategy and processor hash; the v7 verifier policy explicitly
allows only this intentional neutral outer band.

A mixed local preview at `/dev/discman/artwork/pipeline` contains three retail
sources and three cover-based designs. Wilco is normalized from its provider PNG;
Tool and Radiohead have fresh restorations; Tycho, Bon Iver and The National have
fresh cover-based generations. All six numeric geometry checks and actual outer
band pixel checks pass. Five image calls and six final-render verifier calls
completed. The grader passing all flags does not resolve its earlier plastic
translucency blind spot. No result was accepted in production or published.

The local source passed 190 artwork tests, seven standalone checks, TypeScript,
focused ESLint and the artwork Worker dry build. Two independent GPT-6 Luna
medium reviews found no P1/P2 issue in edge compositing or pipeline/cache/hash
integration. Portfolio preview lint and TypeScript passed. The existing public
backend and accepted assets are unchanged; source-level readiness of the outer
finish is separate from material quality and release authorization.

The earlier center-material investigation below remains relevant to that
unresolved release gate:

Patrick accepted the three-CD comparison's visual direction: consistent finished
geometry, source-specific print coverage and translucent exposed plastic.
The current local normalizer preserves source alpha, permits modest scan
variation and rejects excessive distortion. Final automated inspection now sees
the exact candidate over light and dark backgrounds and must confirm material
fidelity. However, the real-provider batch showed this material gate is
insufficient: it passed nearly opaque hubs with high confidence. A failed native attempt uses one budgeted restoration retry, rather
than normalizing the same failed source again. No per-album material or coordinate
patches are introduced.

The accepted comparison used existing restored assets; two had older manually
calibrated opacity. It did not exercise the revised automatic transparent-output
prompt. Patrick then approved three new unpublished tests: Tool, Radiohead and
Soundgarden. All completed and their geometry passes, but their hubs remain nearly
opaque despite the grader passing all material flags. The three-test allowance
is exhausted. Material reconstruction and trustworthy material verification are
still release gates. This checkpoint has not been deployed, and no new artwork
has been published. The earlier deployed release remains separate.

The older implementation boundaries and verification counts below are historical;
they do not describe the latest local source or certify this checkpoint.

## Outcome

New listening events flow through Rewind's existing discovery, deduplicated jobs,
automated quality verification and conditional publication. The portfolio reads
recent plays and every CD image exclusively from public Rewind. There is no
per-album approval queue, local transport override or hand-tuned album registry.

## Diagnosed failures

The prior local import packet bypassed automatic verification. Its canonical
alpha masks do not establish that photographed hub rings and printed artwork
are concentric. Normal registration also independently warps the hole and rim;
that can manufacture passing geometry while distorting the artwork. New AudioDB
selection incorrectly depends on a saved per-album human decision. Failed
source bytes can be selected again on later plays instead of trying alternatives.

## Implementation boundary

- Keep the latest portfolio player/shell and additive generic fallback contract.
- Admit exact-identity AudioDB candidates automatically, without calling them
  official merely because the provider supplies them. Automated source/render
  inspection must reject custom/unsupported retail artwork and uncertain geometry.
- Register the complete face with one uniform transform. Reject nonconcentric,
  noncircular or wrong-ratio results instead of warping independent rings.
- Make final visual checks explicitly cover actual printed hub/rim alignment and
  bind verification to the current policy and exact final bytes.
- Skip known quality-failed source bytes on subsequent eligible plays and try the
  remaining bounded sources. Provider outages must remain retriable.
- Retain current accepted artwork or a generic fallback when no candidate passes.
  No viewer request starts image generation; existing budgets and identity,
  ownership, pin, withdrawal and concurrency protections remain intact.
- Remove the portfolio development bridge. Existing production metadata without
  the generic descriptor remains supported via its neutral loading/failure disc.

## Verification and publication

Use synthetic off-center and distorted-ring regressions, provider identity and
failure tests, automatic publication/hold tests and consumer transport checks.
Inspect private real-source evidence without placing listening data in fixtures.
Run backend suites, type/lint/Worker dry build and portfolio suites/type/lint/build.
Independent reviewers inspect data/authorization and image/consumer boundaries.

The old four-album manual publication packet is superseded, including its claims
of owner approval. Do not run it. Artwork repair must use the shared processing
path. A one-time generic fallback seed is service setup, not per-album approval.

Production remains unchanged until separately authorized: deploy only the artwork
Worker changes, seed the generic fallback, verify real automatic processing and
public bytes, then verify the local portfolio against public Rewind. Portfolio
publication follows Patrick's review. No new schema is planned. Preserve D1/R2
history and immutable originals; Worker rollback and processing pause remain
independent of the portfolio release.

## Verified local result

- Backend: 1,104 API tests, 157 artwork tests and seven standalone pipeline tests
  passed. TypeScript, repository ESLint and the artwork Worker dry build passed.
- Portfolio: 676 tests passed with one existing skip; typecheck, lint and the full
  production build passed. The player body hash remains
  `e92c9169d3979462a68d4ef30ee9ee6c0dcdcd4b82c080dacf1a91b7fc7dd7f9`.
- Two GPT-6 Luna medium reviewers inspected backend/data and geometry/consumer
  boundaries. The strong-ellipse finding was repaired and retested. No unresolved
  findings remain in that bounded review. Exact inference cost is unavailable;
  no paid image-generation calls were made by this repair.
- The 3059 preview was restarted after deleting transport overrides. The local
  8789 artwork Worker was stopped. LAN HTTP and real browser loading, disc loading,
  audio transport state and lid opening worked against public Rewind. The two
  available album artwork URLs match public API responses. Public generic fallback
  is currently absent, and missing albums use the neutral procedural placeholder.
- The rejected Collide With the Sky import is not published or accepted by this
  repair. No individual album import is included in the proposed rollout.

Deterministic printed-ring inspection covers coherent high-contrast boundaries;
other artwork remains subject to conservative automated visual verification.
Synthetic verification is not proof that every real source will pass or that a
visual model cannot err. Live source processing under this corrected policy has
not run. The previous pipeline's deployment evidence is not evidence for this
version.

## Concrete next production boundary

Subject to Patrick's explicit deployment authorization, deploy the
`rewind-cd-artwork` Worker from this checkout using `wrangler.cd-artwork.jsonc`.
No root Worker deployment or D1 migration is required. Preserve current controls,
caps, accepted artwork, pins and history. Seed the existing shared Sony fallback
through its conditional admin endpoint, first preflighting the exact file and
current descriptor. The existing master hash is
`06f6b55f217ce50a4b77c4880834b752dffdc7ac5755aecc21323b03c4c07471`.
Read back and hash public bytes, then observe automatic processing under the
existing cap and verify the public-only portfolio again. No per-album owner
approval, manual coordinate overrides, import batch or historical play insertion.
Keep portfolio deployment separate for Patrick's interface review.

## Final live checkpoint

The whole-pixel proposal fix passed210 artwork tests, seven standalone checks,
TypeScript, focused ESLint, format and the Worker dry build before deployment.
The current processor hash is
`e98caff51629c23199b4040221854b4be92c69f6ba8c4e43721670de9416e16b`.
All four live canonical PNGs match their public descriptors and exact finishing
reproduction. Four public lossless WebP hashes also match their descriptors.
Source alpha remains117/255 in the native retail sample; the cover-generated
hub is117/255. The two retail restorations preserve source/model opacity after
material classification. The follow-up held-source render passed with preserve
treatment, so its publication does not prove the clear-region reconstruction ran
in production; the private same-input probe separately confirms that the new
measurement avoids the former28-pixel violation. Semantic material identification
is still a fallible visual judgment, as documented above.

Four live image requests totaled an estimated $0.293435, excluding visual
classification, verification and independent review inference. No per-album
coordinates, manual import, manual acceptance, counter reset, history insertion,
push, PR or portfolio deployment occurred. Private exact receipts and evidence are
in `.codex/hub-release`, `.codex/uncapped-release` and
`.codex/measurement-release`. The developer-only public API comparison route is
`/dev/discman/artwork/live?ids=...`; IDs are query parameters, not a shipped
per-album registry. The local comparison has light/dark center views and the
existing Discman player. Desktop/390px have no overflow; generated public art
loads and spins in the player. Sony shell SHA is unchanged.

## Existing artwork reset follow-up

October13, source preparation. Patrick explicitly requested removing outdated
CD selections from public Rewind and reprocessing them through automation.
A fresh public inventory found12 legacy selections, four current shared-policy
results, and older failed Pinkerton/Wilco jobs. The four previous live examples
were not coverage verification for those recent albums. All three saved failed
outputs now pass current geometry normalization; Pinkerton's old artistic flags
passed, with material confidence being its publication blocker. Wilco's native
retail source reproduces the exact later accepted local sample, but that sample
was not activated publicly. Nirvana and Pierce the Veil have no artwork registry
rows or jobs; ordinary new-listen enrollment is not a historical backfill.

The proposed shared correction retires outdated active selections and queues the
existing automatic discovery outbox. It preserves original job/evidence history,
identity/pin/concurrency guards, current accepted results and recorded listening
history. A bounded admin reprocessing endpoint and scheduled recovery of older
established artwork eliminate the need for per-album manual uploads or approval.
The policy now preserves ambiguous photographed center material instead of
blocking usable source-faithful artwork. Added rim effects have a distinct final
inspection flag, and remain a hard publication failure.

The previously shown rainbow Wilco cover is saved private failed-job output,
not accepted artwork. Its old geometry failure occurred before final inspection.
That diagnostic image still shows colored detail just inside the neutral band;
the whole final disc must be checked. Geometry passing alone is not publication
proof. No diagnostic PNG is imported as part of this correction.

This reset was released through committed source on main. The portfolio remains
undeployed. All further releases use the same protected source/deployment guard.

## Natural-flow recovery

Transparent images with transparent exterior and spindle are measured using their
alpha boundaries, keeping pale artwork independent of white-matte contrast.
Opaque scans retain the photographed-boundary path. Connected spindle/background
components, hidden RGB, excessive distortion and final visible defects still fail.

Stored Apple IDs are hints to verify, not permanent failures. A failed binding can
recover through a uniquely matched collection, exact album artist and observed
track. Bound MusicBrainz title, artist and release-group evidence resolves catalog
disambiguation and live labels; these labels are not stripped blindly. Song guest
credits do not invalidate album membership. A small scrobble-title variance is
allowed only with independent logical-album proof, one matching track and unchanged
version qualifiers. Ordinary checks retain recorded-album evidence; legacy evidence
is inherited only from an explicitly authorized check tied to that job.

A geometry/quality failure durably queues source selection again. The existing
source retry policy permits a corrective generation and then moves to alternatives
or stops when sources are exhausted. Repeated Workflow delivery cannot create an
unbounded generation loop. Retry admission preserves existing accepted artwork;
only an explicit outdated-artwork reset withdraws a selection. Pins, owner review,
identity changes and non-render interruptions do not enter this retry path.

Local provider spacing does not reserve unused slots under contention and uses
seconds of Workflow backoff. Real provider outages retain their Retry-After and
bounded exponential recovery. Outdated processor-tagged reset checks can be
replaced atomically without cancelling ordinary pending listening checks.
