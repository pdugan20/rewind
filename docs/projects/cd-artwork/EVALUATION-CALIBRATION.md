# CD artwork evaluation calibration

Execution mode: proportional inline implementation — diagnose with existing private
assets, implement bounded pipeline corrections, review independently, and keep
unvalidated acceptance changes out of production.

## Outcome and boundary

Listening should automatically supply trustworthy artwork through public Rewind.
No album-by-album owner approval or coordinate exceptions are part of this work.
The portfolio player and public artwork contract remain unchanged. Patrick chose
to leave automatic generation enabled while this investigation runs.

The earlier backend release remains deployed. This calibration batch is local,
with no production writes and no portfolio deployment. The three-image UTC daily
cap was already exhausted when this batch began. Patrick explicitly authorized
three additional unpublished test generations; all three have now been used.
Production counters and the daily cap were unchanged. Further image requests
require a new allowance or the ordinary authorized production budget.

## Selected visual target and current local processing

Patrick reviewed the three-CD comparison and accepted its visual direction.
The source, saved restoration, and geometry derivative were shown separately
for Tool, Radiohead, and Wilco, including light/dark hub close-ups and rotation.
These were existing outputs, not three new generations. Tool and Radiohead's
saved restorations already contained older calibrated opacity adjustments; they
are not evidence that a model automatically reconstructed their transparency.
Wilco's source PNG already had translucent hub alpha, which its saved model
restoration lost. Geometry correction cannot recover lost material alpha.

The current local strategy now allows modest scan perspective, native hole-size
variation and variable print coverage while finishing a consistent centered
silhouette and hole. It preserves sampled source alpha rather than painting a
fixed hub, silver donut or outer margin. A native material/quality failure moves
once to the bounded restoration retry, then exhausts those exact source bytes.
Unsupported native geometry falls back through the existing paid-budget guard.

The unpublished v6 verification policy judges the exact candidate on light and
dark mattes and requires confident material preservation as well as artwork,
lettering and manufactured geometry. Printed ink and metallic areas stay opaque;
only exposed plastic should reveal the backdrop. Numeric compatibility material
fields do not select or apply an opacity patch. Uncertainty remains private and
does not request album-by-album owner approval.

Automatic restoration requests now explicitly ask for genuine alpha in exposed
plastic, the hole and exterior, while protecting opaque print and metal. They
use transparent PNG output. Manual generation retains its prior opaque settings.
Patrick authorized a second finite batch of three unpublished real-provider tests
using this revised prompt: Tool, Radiohead and Soundgarden. All three completed.
Their exterior and spindle holes are transparent, but sampled inner hub regions
remain almost opaque. The v6 verifier passed every material flag with high
confidence for all three. This reveals an acceptance blind spot; the revised
prompt and verifier do not establish the intended translucent-plastic treatment.
No production writes were made. The three-request allowance is exhausted.

The normalizer checks PNG/JPEG pixel budgets before decoding. A separate guard
bounds a measured hub anchor's center-shift derivative so the sampling map cannot
reverse radially near the hole. Severe or uncertain normalization remains held;
we do not add album-specific coordinate adjustments to make it pass.

The following sections record the earlier calibration baseline; their strict
registration limits and opaque settings describe that earlier phase.

## Findings from real assets

The first generation's hole-radius estimate was 62.88 canonical pixels against
60 ±2.5; it missed by 0.38 pixels. Other measured checks passed. This is a borderline
numerical rejection, not proof of visible failure. The cover generation failed
multiple independent measurements. Changing the brightness cutoff did not explain
either result.

The private corpus initially contained eight images and now contains eleven,
including the three controlled experiments below. It also includes the previously rejected centered-mask
import. That import passes the numerical checks because the printed hub is not
detected. It is a false accept for the numeric detector. A subsequent isolated run of the
current visual verifier also passed this known-bad final asset with high confidence
and every acceptance flag true. This establishes a blind spot in both checks; it
does not establish that the automatic pipeline published that asset. Alpha geometry
and photographed physical geometry are distinct requirements.

The initial corpus has four geometry labels and four unrated examples. Two
labelled tuning examples yield no numerical disagreements; two labelled held-out
examples include one numerical false accept. These small counts are diagnostics,
not reliability estimates. Shared artwork groups cannot span the two splits.
No thresholds were tuned on these results. Source identity and fidelity do not
inherit a positive label from a geometry judgment or a prior publication.

## Implemented local corrections

- One failed render retains its exact source for a single controlled regeneration.
  Its reason-specific prompt changes the generation fingerprint; identical retry
  requests remain idempotent. Two failed generations exhaust that source for the
  processor revision. This is retry exhaustion, not a claim the source is invalid.
- Existing daily submission limits, unknown-provider-outcome protection, source
  hashes, pending-job uniqueness and conditional publication guards still apply.
- Geometry inspection reports all measurable defects before returning a rejection,
  rather than hiding later failures behind the first one. The held job preserves
  numeric measurements, limits, policy and raw hash in private provenance.
  Unmeasurable inputs and undetected printed hubs remain explicit uncertainties.
- The visual grader checks physical disc appearance and preservation. It no longer
  has to prove official manufacturing provenance from pixels. Catalog identity
  remains a separate prerequisite.
- Generation instructions now explicitly forbid invented rainbow, iridescent or
  chrome rims and reflections absent from the source. The vague request for a
  realistic disc with subtle material was removed. The revised visual rubric
  rejected the rainbow example, but no generation with this revised prompt has
  been tested; the three tests used the baseline prompt to isolate settings.
- The policy version changes so prior visual verdicts cannot silently stand in
  for the revised rubric. Existing accepted assets are not rewritten.

At this earlier calibration checkpoint, strict geometry thresholds and opaque
generation settings remained unchanged. These corrections do not yet establish that the pipeline is reliable
enough for a new rollout.

## Reproducible offline evaluation

Use a private manifest with `id`, `group`, `path`, `stage` (`raw`, `final`, `source`),
`split` (`tuning`, `held-out`), `expectedGeometry` (`accept`, `reject`, `unrated`), and
`rationale`. Paths resolve relative to the manifest. Use public-artwork identifiers,
not listening history or private account identifiers. Keep images and results out
of version control.

```sh
npx tsx scripts/cd-artwork/evaluate.ts /private/manifest.json /private/output
```

The tool makes no network calls. It creates measurements and an HTML comparison
with unchanged originals, light/dark backdrops, center guides, quarter-turn controls
and optional rotation. White compositing occurs only in memory for measuring
existing alpha images with the current opaque detector. It does not repair or
export replacement artwork. Numeric counts describe the detector, not publication.

## Approved three-generation comparison

All requests used the pinned `gpt-image-2.5-sunburst-2026-09-08` model, original
source bytes and source-first/reference-second ordering. Original high-quality
opaque results served as baselines. Each test generated one image.

| Test         | Controlled change                                       | Result                                                                                  |
| ------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Retail xhigh | Quality only                                            | Hole ratio and printed-hub alignment failed; extra dark ring and changed hub size       |
| Cover xhigh  | Quality only                                            | Uncertain physical rim; invented rainbow outer border and regenerated cover details     |
| Retail alpha | Native transparency and matching background instruction | Enlarged transparent spindle area removed source silver hub; centering and ratio failed |

None was accepted or published. The three generation requests took approximately
61, 60 and 41 seconds. Estimated image-generation spend was $0.295 using the current
pipeline token rates; this is not a billing receipt and excludes verifier/reviewer
inference. These three samples do not justify changing quality or transparency
defaults and cannot estimate a general model failure rate.

Two isolated source-to-render verifier probes ran with the revised rim rubric.
It rejected the invented-rainbow example via `no_visible_defects=false`, but passed
the known-bad Collide final image. The rainbow probe used unregistered raw output;
neither probe was an end-to-end publication test.

An offline multi-seed ring-tracking prototype still found no dependable printed
ring on Collide and reported offsets on previously accepted examples. It is not
ready to replace the existing detector. A separate whole-image normalization of
an existing retail source preserved much better ring concentricity than its
regenerated versions, but its native hole ratio fails the canonical threshold.
That supports investigating source preservation; it is not permission to relax
thresholds or add an album-specific exception.

## Source preservation and centering follow-up

This subsequent batch made no provider calls, generated no paid images and made
no production mutations. The local verification policy is now
`whole-face-concentric-v4`.

The supplemental radial-profile detector follows coherent, lower-contrast hub
edges when stronger irregular printing defeats the original strongest-edge scan.
It measures a distinct angular contrast peak, requires 90% angular support and
refits local edge maxima. It does not override an existing measured failure or
change the geometry tolerances. Competing plausible ring centers remain uncertain;
the highest-contrast ring is not automatically assumed to be the physical hub.
Automatic retail processing now holds unmeasurable hubs before calling the visual
verifier. That hold uses the existing bounded regeneration/source-fallback path;
no owner approval queue is introduced.

The known Collide failure is now rejected at all four quarter-turn orientations.
All eleven preexisting samples have stable numeric pass/hold classifications under
these rotations. Soundgarden still passes the numeric limits but has conflicting
ring-center evidence: the new automatic retail gate would hold it. Its already
published asset is unchanged. This is a real coverage tradeoff, not evidence that
all false rejections are resolved. The fallback detector is a bounded image
heuristic, not proof of which visible ring represents physical manufacture.

All examined images are now **development data**. The separate
`development-manifest.json` moves previously held-out groups to tuning because
they informed this implementation; the historical manifest is retained only as
an earlier baseline. Four numeric labels have zero disagreements in the updated
report, but that excludes the stricter automatic retail evidence gate and is not
an independent reliability estimate. The report explicitly exposes retail gate
holds separately.

An offline source-preserving cover prototype uniformly resamples the original
cover, applies the canonical circular silhouette and hole, and uses the existing
hub material template only inside radius 88. It does not ask a model to redraw the
photo or lettering and adds no outer material rim. Its constructed alpha passes
the existing final contract. The current dark-edge-on-white registration detector
cannot reliably measure white cover artwork, demonstrating why constructed cover
geometry should not be routed through photographed-edge detection.

The prototype is not wired into generation or publication. Circular cropping can
still obscure important source content, including at the spindle. Patrick has
been asked for the one-time product choice between source-pixel cover composition
and generative cover composition; retail scans remain preferred in either case.
The prototype and source comparison are in the local diagnostic preview, not the
portfolio or public Rewind.

Tests added for a hidden eccentric hub, its centered counterpart, no coherent ring,
competing ring centers, and prevention of visual-model approval when a retail hub
is unmeasurable. 167 artwork tests and seven standalone pipeline tests passed;
TypeScript, focused ESLint and the Worker dry build passed. Two GPT-6 Luna medium
reviewers inspected the changes. The competing-ring finding was fixed. A claimed
source-fallback bug was withdrawn after verifying the earlier usability gate;
no unnecessary fallback rewrite remains. A second reproduced finding showed that a six-seed search cutoff could hide
a weaker eccentric ring. The cutoff was removed, a regression fixture was added,
and the reviewer confirmed that specific finding is resolved. The complete
radius interval still bounds the search to at most 15 separated seeds. Reviewer inference cost is not exposed.

## Remaining experiments and release gates

1. Keep current quality and background settings until representative evidence
   supports changing them. Do not spend further generation calls under this
   exhausted three-request experiment allowance.
2. Calibrate geometry requirements against visible rotation and actual source
   construction. Separate the canonical alpha mask from physical ring evidence;
   uncertain ring detection and a model's high-confidence answer cannot establish
   centering. Keep the Collide negative in the regression corpus.
3. Prototype deterministic cover composition with preserved source pixels; compare
   important-content clipping at the rim and spindle. Do not adopt a new cover
   appearance merely because it satisfies the mask contract. Narrow retail edits
   to restoration, preserving coherent whole-face transforms and lettering.
4. Resolve the known detector blind spot through improved measurements or explicit
   reliable visual verification. Never count `printedHub.detected=false` as proof
   of correct centering. Never repair the hole/rim independently to force a pass.
5. Evaluate final assembled candidates, still and rotating in the actual portfolio,
   alongside source fidelity and identity. Keep generation and publication separate
   during evaluation. Track false accepts, false rejects, uncertainty, latency and
   cost per accepted asset. A passing unit suite cannot substitute for this evidence.
6. Deploy only after the held-out results support the shared policy and the
   controlled live path is verified. Preserve current accepted artwork and fallback.
   Portfolio deployment still follows Patrick's review.

## Verification of this batch

161 artwork tests and seven standalone pipeline tests passed. TypeScript, focused
source ESLint and the Worker dry build passed. The offline evaluator ran against
eleven private assets; its browser controls and static quarter-turn views were
inspected at 160, 240 and 320-pixel canvas widths on light and dark backgrounds.
This is diagnostic-view evidence, not an actual-player acceptance pass.

Two independent GPT-6 Luna medium reviewers found no remaining P1/P2 issue in the
retry/data or inspection/evaluator changes. One initially compared against Git
HEAD rather than the archived deployed snapshot; after checking the deployed
snapshot it withdrew that false regression. Review inference cost is not exposed.
No revised policy has been deployed; production automation remains enabled as
Patrick requested. The original Collide miss is addressed locally; broader reliability, source-preserving
cover behavior and rollout validation remain unresolved.

## Local material-fidelity verification receipt

The final local checkpoint passed 187 artwork tests and seven standalone pipeline
checks. Repository TypeScript and ESLint passed before the final bounded pixel
checker change; focused rendering-test lint passed afterward. The final artwork
Worker dry build passed. Current processor hash:
`d0d7da1d5f1bd03c7c682de9467aaf7d26bab3a0540752b974a79242d6bfb70e`.

Two GPT-6 Luna reviewers at medium effort reviewed image and job-flow boundaries.
The native-object write-order finding is repaired and covered by an interrupted
storage-response test. The geometry reviewer reproduced a reachable near-hole
sampling fold; the derivative guard rejects that exact synthetic scan and has
an end-to-end regression. The one-pixel outer alpha-contour tolerance was also
reviewed. No unresolved P1/P2 findings remain in those bounded code reviews.
Exact review inference cost is unavailable. These code reviews do not validate
material reconstruction.

Rebuilding the three saved retail comparisons produced identical output hashes.
This confirms the additional geometry guard did not change those viewed examples.

## Second approved real-provider batch

All three requests used the current automatic prompt, pinned GPT Image 2.5 model,
high quality, 1024-square PNG and transparent background. Each request and grader
call has a private receipt. No generation was retried or resubmitted.

| Source                           | Image usage estimate | Raw inner hub median alpha | Final geometry | Material grader                 |
| -------------------------------- | -------------------: | -------------------------: | -------------- | ------------------------------- |
| Tool — Lateralus                 |            $0.075185 |                    253/255 | Pass           | All flags pass, high confidence |
| Radiohead — In Rainbows          |            $0.071214 |                    252/255 | Pass           | All flags pass, high confidence |
| Soundgarden — Down on the Upside |            $0.074584 |                    252/255 | Pass           | All flags pass, high confidence |

Hub samples use a fixed radius band 64–78 in the raw images for diagnosis; they
are not asserted boundaries between plastic, metal and ink. Browser light/dark
close-ups confirm the desired translucent appearance was not reconstructed.
The image-generation usage estimate totals **$0.220983**, excluding verifier
inference. This is a usage estimate, not an invoice.

Soundgarden initially failed only because the horizontal 50% alpha contour was
at x=33 instead of x=32. Hole leaks, exterior leaks, missing face and hole-edge
checks were all zero. The checker now permits exactly two crossings, each within
one pixel of its canonical position; physical clipping and all leak/face checks
remain unchanged. A one-pixel regression passes and a two-pixel regression fails.
This geometry tolerance does not resolve or relax the material requirement.

The live comparison separates source, new model output and normalized result at
`/dev/discman/artwork/tests`. All three results remain private and unpublished.
Do not deploy v6 based on its current material grader: it accepted the visible
opacity defect. A generic material-classification/reconstruction step or a
reliable measurable material check is still a design and validation gate.

## Albums without retail CD art

The currently configured pipeline uses a verified album cover for model-based
adaptation, then automated verification and conditional publication. Pending or
failed work keeps existing accepted artwork; without accepted artwork it serves
the shared Sony fallback. No album-by-album owner approval is required.

`/dev/discman/artwork/covers` compares the same saved Tycho cover three ways:
original-pixel fill, original-pixel fit, and an earlier model adaptation. Fill
crops cover corners; fit keeps them with a plain background and smaller picture.
Both procedural examples use a generic exposed hub treatment and no invented
outer rim. The older AI example's colored rim is an unwanted defect, not an
endorsed look or a fresh test of the revised prompt. Original-pixel composition
is an alternative, not yet the selected or deployed default. No new cover model
call was made in this batch.

No deployment, push, PR, live configuration change or public artwork write was
performed by this checkpoint. The earlier production automation remains enabled
as Patrick requested.

## Outer-margin cover exploration

Patrick rejected artwork flush with the physical edge and confirmed a thin plain
silver-gray exposed-disc band. He explicitly removed generation cost as the
constraint. Four new unpublished cover-based GPT Image 2.5 examples completed:
Tycho — Dive, Daft Punk — Discovery, Bon Iver — i,i and The National — High Violet.
Each used the same current automatic cover prompt with an exploration-only
margin/material amendment, high quality and transparent PNG output. The production
prompt and configuration were not changed.

All four model outputs passed normalization. The comparison holds the two
source-pixel designs constant except for print outer radii 476 and 470 against
physical radius 480, with inner print radius 88. Model designs request roughly
ten pixels of plain exposed outer material and a modest clear hub. These shared
invented-cover layout choices are not imposed on authoritative retail scans.

The raw/model layouts are not equivalent to original-pixel composition: the
Bon Iver model scales the collage to retain more of its border; the Tycho model
changes the placement of the scene. The sources and model outputs are shown
separately. Fixed-band normalized hub median alphas are 199, 240, 252 and 253
respectively; these remain diagnostic samples, not identified material regions.
Tycho shows more translucency than the other examples, but this does not establish
a general material solution. Outer-band median RGB chroma in radius 476–478 is
only 1–2; browser inspection shows neutral edges without the prior invented
rainbow rim. No artwork-fidelity or material acceptance decision was made.

Generation usage estimate totals $0.301672, with no verifier calls or resubmissions.
Exclusive receipts, actual prompts, sources and hashes, raw outputs, normalized
outputs and diagnostic reports are private in `.codex/cover-margin-batch`.
The live page `/dev/discman/artwork/covers` shows all four albums and supports
light/dark backdrops, size, rotation and selection into the existing Discman.
Desktop and 390px mobile layouts, image decoding and player loading were checked;
focused portfolio ESLint, TypeScript, formatting and whitespace checks passed.
No production artwork, daily cap, configuration, deployment, push or PR changed.

## Selected shared finish and mixed pipeline batch

Patrick selected the Small edge finish for every completed CD and requested a
mix of retail artwork and generated cover-based designs from the actual pipeline.
Execution mode: proportional inline implementation — bounded renderer/prompt
changes, independent geometry and integration review, local evidence only.

`normalizeRetail` is the shared automatic renderer for native source bytes and
model outputs. It now blends a neutral opaque band at canonical radius 470–480,
using premultiplied color and retaining physical silhouette antialiasing. Source
color and alpha are untouched inside radius 469.5; the half-pixel print-boundary
transition and outer ten-pixel band are intentional presentation changes. The
center remains source-specific: no fixed hub-opacity or material patch is added.
`RENDER_STRATEGY` is `source-preserving-shared-small-edge-v2` and verification
policy is `shared-small-edge-material-fidelity-v7`. Both automatic source kinds
receive the finish before the exact final candidate is submitted for inspection.
The verifier exception is limited to the intended neutral outer band. Existing
identity, source, candidate hash, cache, activation and publication safeguards
remain in place. No accepted retail asset is silently restyled in production.

Six private samples use the exact current automatic prompt/settings and renderer:
Wilco native retail artwork; new Tool and Radiohead restorations; and new Tycho,
Bon Iver and The National cover-based designs. Wilco did not need image generation.
All five generation requests completed once, without resubmission. All six
normalization checks pass. Each decoded finished PNG has zero mismatches across
23,872 fully covered band pixels in radius 471–479: RGB193 and alpha255. Geometry
and source/output hashes are recorded alongside renderer identity in private
`.codex/shared-finish-batch/report.json`. The shared renderer is the only edge
finishing implementation; the development page adds no album-specific styling.

Six current final-render inspections also completed with high confidence and all
required flags true. This remains insufficient evidence for clear-plastic quality:
fixed-band diagnostic hub median alpha is 253 for Tool/Radiohead, 252 for the
three generated cover designs and 117 for Wilco. A cover design can legitimately
print near its spindle; those bands are not identified material masks. The prior
retail translucency grading blind spot is unresolved. No live accepted artwork
state was created from these test receipts. The generation usage estimate is
$0.372587, excluding verifier and review inference.

The current source passed 190 artwork tests and seven standalone pipeline
checks, repository TypeScript, focused ESLint, formatting/whitespace checks and
the artwork Worker dry build. Current processor hash:
`708e628842ff7a9fa1012c718a2f3067e416963c9671022f5cd649b3526f64ca`.
Two fresh GPT-6 Luna medium reviewers inspected geometry/alpha and
pipeline/cache/publication boundaries with no P1/P2 findings. Their reviews were
read-only and did not rerun tests or inspect captures; primary-agent test and
browser evidence remain separate. Review inference cost is unavailable.

The mixed preview is `/dev/discman/artwork/pipeline`. It shows source references,
retail-versus-cover labels, both backdrops, rotation and selection into the existing
Discman. Backend publication, active assets, automatic controls and production
cap were unchanged. No deployment, push or PR was made.

## Source-shaped center material checkpoint

The current local center stage and its bounded evidence are documented in
[Pipeline repair](./PIPELINE-REPAIR.md#source-verification-checkpoint). The earlier v7
opaque-hub grader passes above are historical and do not prove correct material.
The first radius-output material probe tried to select62–190 and was held. The
replacement derives geometry in code and restricts model output to measured IDs.
Final measured Tool/Radiohead probes chose the same narrow regions after source
crop registration was corrected. Their existing restoration outputs were reused;
three cover generations are fresh under the new reserved-hub prompt. All finished
pixels, light/dark inspection views and hashes were checked before preview.

White/silver ink versus photographed clear plastic remains a semantic limitation.
Unit fixtures establish preservation for opaque treatment, protection of partially
printed native alpha, and rejection of even a single colored pixel in a proposed
clear region. They cannot establish a classifier's universal correctness. Partial
photographic printing without a complete safe annulus stays private rather than
receiving a guessed uniform hub. No owner approval is required per album.
