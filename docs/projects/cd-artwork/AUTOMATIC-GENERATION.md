# Automatic CD artwork delivery

Execution mode: proportional inline implementation — one backend owner, bounded independent review, existing portfolio consumer contract.

A new recorded play admits background work for its owned, unfiltered album. High-confidence identity selects approved, unambiguous retail CD scans first. Multiple pressings can supply representative artwork only within one proven logical release group; inspect at most three stable candidates and never claim an owned pressing. Missing, unsupported or low-resolution scan files fall through to verified cover selection, while transient provider failures retry. Otherwise an exact artist/album match plus an observed-track match, or an approved Front cover from a verified release, can select verified album cover art, including digital-only albums. No physical CD is required for a cover-based design. Missing or conflicting identity stays a non-paid hold; provider failures retry rather than establish absence.

Selection feeds the existing deduplicated generation Workflow and daily cap. Raw outputs stay private and survive processing failures. Automatic publication requires both deterministic geometry/integrity checks and source-to-render visual verification; retail material must also be confident. Failed or uncertain renders stay private; no owner approval is required. The local calibration revision allows one controlled regeneration of an exact source after a geometry or quality failure; two failed generations exhaust that source under the same processor. Subsequent eligible plays then try other bounded sources while retaining the accepted image or generic fallback. This revision is not yet deployed; see EVALUATION-CALIBRATION.md for the current evidence and release boundary. Publication compares current identity, expected active artwork, filters, pin and automation controls atomically. Existing retail art is reused; cover-based art can upgrade to retail after a later play and seven-day cooldown. No library sweep, historical reassignment or consumer-blocking generation is introduced.

Checkpoint order: additive migration with automatic processing disabled; source selection and queue integration; visual validation and conditional publication; synthetic retry/ownership/concurrency coverage and full repository gates; reviewed production deployment; enable existing owner cohort under existing cap; bounded real-source retail/cover checks and portfolio handoff. Only the artwork Worker and additive D1 state change; root listening notification and existing accepted-artwork response remain compatible. MCP 1.1.0 stays unchanged.

Rollback disables automatic processing first. Disabling the existing global switch stops all artwork processing. Keep new schema, private raw evidence and accepted immutable assets when rolling back code. The portfolio continues using accepted artwork and its immediate placeholder. Never claim backend publication proves the independently owned portfolio interface has deployed.

Source verification: 1,104 API tests, 105 artwork tests, seven standalone pipeline tests, 80 deployment-policy checks, type/lint/format checks and Worker dry-run builds passed. Bounded independent reviews cleared their reported source-selection and recovery issues. Actual runtime Workflows exercised generation through automatic publication. Production owner rollout used real historical source evidence without inserting scrobbles: two cover renders automatically published in 66 and 87 seconds, all nine prior accepted hashes remained intact, and the exact published MCP 1.1.0 package read the new artwork. Credentials and album mappings remain in private release evidence.

Production preflight follow-up: stored Apple bindings must agree before retail selection. An independently verified cover can generate while a retail provider is unavailable; the admitted discovery Workflow retains retail-provider-pending evidence and retries instead of declaring absence. Migration 0050 permits only one unfinished automatic job per owned album, so a recovered retail source waits for its fallback job rather than paying for two competing renders. Source-level request/raw deduplication and the global daily cap remain in place.

Retail candidate searches request CD/HDCD editions so digital releases cannot consume the three-candidate budget. Accepted cover artwork can revisit that budget on a later eligible play: retain its reviewed edition first, anchor alternatives to the same proven release group, and inspect at most three distinct IDs. New editions use medium one and are independently checked for unambiguous single-CD media. The original edition retains its recorded medium. This permits later retail upgrades without treating a digital cover edition as permanent proof that CD scans are unavailable.

## October pipeline correction

The current local repair is documented in [Automatic artwork pipeline repair](PIPELINE-REPAIR.md).
Exact-identity AudioDB disc candidates enter automatic verification without a human
review record. Metadata alone does not establish official artwork. The visual
verifier checks source support and actual printed geometry; deterministic checks
measure rim, spindle and coherent printed hub rings. The current local automatic path continuously normalizes measured physical
boundaries and applies the same narrow neutral outer band to native retail art
and generated cover art. Source-specific center print and alpha are preserved. Opaque hubs remain opaque when source
evidence supports that material. Final verification is bound to the current policy
and exact published bytes. No album-specific coordinates are used by this flow.

Earlier verification and rollout figures above describe the previous implementation;
they do not establish deployment or verification of this correction.

## Current local center handling

The unpublished v8 material stage is described in
[Pipeline repair](./PIPELINE-REPAIR.md#source-verification-checkpoint). Cover-based designs
reserve a clear hub; native retail alpha is preserved. Opaque retail scans use
measured annuli plus source material identification and final light/dark inspection.
Ink and metal stay opaque; ambiguous material stays private with existing artwork
or Sony fallback. Temporary classifier/verifier unavailability gets one delayed
recovery using the same raw bytes. This does not deploy or change production
automation, caps, accepted artwork, or the portfolio transport.

## Uncapped automatic generation

Patrick explicitly approved removal of the inherited daily generation allowance.
Submission eligibility no longer consults the legacy limit column. Daily usage
counts remain for accounting; enable toggles, one submission claim, persisted raw
recovery, source and verifier retry ceilings, and publication protections remain.
Owner control reads return `daily_limit: null`; writes reject the retired field.
No migration or usage reset was required. The current Worker release is recorded
in [Pipeline repair](./PIPELINE-REPAIR.md).
