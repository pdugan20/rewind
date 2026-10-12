# Album identity preservation

Execution mode: proportional inline execution — one repository, synthetic regression coverage, followed by two independent reviewers for data and sync behavior.

## Delivery contract

Prevent provider metadata and new plays from silently replacing established album identity. This is a shared rule for all artists; no artist or album exceptions are introduced.

The finite implementation covers catalog metadata validation, immutable established identifiers, per-event album snapshots, album aggregates and the play-triggered artwork admission path. Existing accepted artwork, public response shapes and MCP package versions remain compatible. No additional history audit, image batch or paid generation is included.

## Behavior

Catalog album metadata must match the requested ID, artist and complete logical title before dates or track counts are saved. Recognized edition labels may normalize; significant qualifiers remain distinct. Missing identity and transient provider failures preserve existing values. Confirmed catalog no-matches receive the existing cooldown; transient failures do not consume it. Writes check the user and selected catalog binding again after network requests.

An established album MBID is not replaced by a later same-name observation. A differing ID marks an identity conflict; automatic CD admission and source preparation hold that album for resolution. Different release IDs may belong to the same logical album, so a conflict is uncertainty, not proof of an incorrect source. Existing accepted masters remain readable. Paid job claiming and budget reservation run in one transaction, so a sync cannot add a conflict between those operations. Artist MBIDs and established default track album associations are likewise not overwritten. Artist ID conflicts also hold enrichment and automatic artwork processing; the unique name model does not split ambiguous artist records.

New scrobbles store the reported album separately from their shared song record. An explicit absence stays absent. Both ordinary sync and backfill populate the snapshot; duplicate events retain their earlier snapshot. Event-based album aggregates, recent history, sparklines, collection cross-reference and artwork checks use it. Song summaries use the most recent owned event for their single album slot, falling back to the default only when there are no events.

The additive migration does not guess original albums for existing events. Legacy rows retain their previous association as a compatibility fallback. This prevents future retargeting, but does not establish or repair the original attribution of older plays. Such a repair requires source event evidence and a separately approved finite data action.

## Release gates

Synthetic cases cover the same song on two releases, replay deduplication, explicit missing albums, legacy compatibility, conflicting identifiers, shared title qualifiers, a wrong catalog artist/title, transient failure, binding changes during fetch, user scope and admission against the reported album. Run focused suites, the complete API and artwork suites, type/lint/format checks, build and independent review before the authorized merge/deployment. Verify production health and original accepted master hashes afterward. The MCP version remains unchanged until final release confidence is established.
