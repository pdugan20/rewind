# Play-triggered CD artwork discovery

Execution mode: proportional inline implementation — one backend repository, two bounded independent reviews and root judgment.

## Delivery contract

A new persisted listening event admits one background metadata check for a known CD edition lacking approved retail disc artwork when its cooldown expires. Listening sync must not wait for artwork providers. Duplicate plays, overlapping dispatch and lost responses must not duplicate work. Cooldown expiry alone must not independently schedule another check. The policy-recovery revision may reconsider a completed source failure once after relevant discovery logic changes; see [Artwork discovery and policy recovery](./DISCOVERY-RECOVERY.md). Pending work must survive partial sync failure and permit bounded recovery.

Unknown editions remain identity holds. In the original discovery-only mode, discovery never generates, accepts or activates artwork, changes history, or publishes an npm version. Migration 0049 adds opt-in automatic processing as described in AUTOMATIC-GENERATION.md; the discovery-only behavior remains available when that switch is off. Existing artwork APIs and the portfolio integration remain compatible.

## Boundaries and rollout

Migration 0046 adds a private discovery outbox and an admission trigger; it does not copy or scan existing history. The index enforces one unfinished check per user/album. Provider work runs in the separate artwork Worker. Deploy migration, then artwork Worker with its new Workflow and named internal service, then root Worker with that service binding. Older root code can continue recording plays; the outbox survives until notification or recovery becomes available.

Rollback root and artwork code together if necessary. To suspend admission and processing, use the existing owner-only artwork kill switch. Preserve outbox state and migration so interruption does not erase recorded events. Rolling back to the previous artwork Worker also restores its old hourly/monthly behavior; disable artwork before such a rollback.

## Verification

Verify atomic admission, duplicate and cooldown behavior, user ownership and filtering, active retail exclusion, actual incremental/partially failed sync, provider backoff, stable workflow IDs, interrupted delivery recovery, and notification isolation. Run the complete API and artwork suites, type/lint/build checks and deployment policy checks. Production checks use actual listening state and accepted artwork; no fabricated history or new paid image calls.
