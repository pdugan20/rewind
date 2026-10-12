# Album identity audit

Execution mode: proportional inline implementation — one backend repository, two independent GPT-6 Luna reviews, and root judgment.

## Contract and boundary

Continue the existing finite matching audit, with a maximum of 200 distinct history-derived records. Fix reusable enrichment and source-selection defects, retain existing accepted artwork, and prepare a verified reviewed-master action for the Blue Album. Do not infer catalog splits, rewrite listening history, generate new paid images, or activate contradicted identities. Catalog repairs and new activation require the applicable owner authorization; prepare exact preconditions and rollback first.

## Evidence and denominators

The frozen cohort contains the current nine-album window, 37 history-derived Weezer records, the original 100-record sample through overlap, and selected older edition/self-title/shared-title cases. It contains exactly 200 distinct records, not 200 new records added to the previous samples. Existing bounded provider evidence is reused for 168 records. The original snapshot cutoff is 2026-10-11T09:44:58Z; the older expansion precedes 2026-06-24T15:52:18Z.

Fourteen distinct frozen release groups, absent from the current/Weezer/original regression groups, were held out by a deterministic seed before matcher changes. Private evidence retains user-scoped ID maps, hashes, snapshots and all per-record decisions; none of those maps belong in committed fixtures.

| Classification                                 | Records |
| ---------------------------------------------- | ------: |
| Confirmed incorrect binding                    |       1 |
| Safe missed attachment                         |       1 |
| Unresolved or ambiguous                        |     117 |
| Source missing in the bounded checked evidence |      49 |
| Transient provider failure                     |       2 |
| Matching identity or candidate evidence        |      30 |
| Total                                          |     200 |

There are 49 verified current MusicBrainz IDs, all resolving as releases; 151 records lack a usable ID. Existing canonical identities did not change against frozen evidence. Apple metadata covers 124 records through 114 distinct returned catalog objects. Six records are filtered and retain their filtering.

The classification-phase metadata API traffic was 65 requests: 37 MusicBrainz and 28 Apple Music requests, including the Blue source verification. The Apple credential check was one separate request. TheAudioDB's supplied Blue page was also inspected independently. Classification-phase history and catalog access was two API reads and five bounded, read-only D1 queries; no new history crawl, catalog write or paid image request occurred.

These are classifications of a deliberately selected sample, not estimates of precision, recall or catalog-wide error rate. One incorrect Apple binding is established. No missing accepted attachment was positively established; that does not prove there are no false negatives elsewhere. The earlier Blue verification procedure inspected the wrong record, but the correct binding already existed. Other rejected title pairs remain holds rather than newly declared false positives. Incomplete mutable track associations do not establish original per-event attribution, a full tracklist, or an owned pressing.

## Confirmed cases

The original exact-title search found the proper **Weezer (Blue Album)** record. Its follow-up script instead inspected the separate generic **Weezer** record. That explains the incorrect hold rationale. All ten distinct normalized current associations on the correct record match standard Blue CD release `51d34c4e-312e-4462-b754-9c0dc482002a`, group `c7b245c9-8099-32ea-af95-893acedde2cf`; all ten also occur in the independently fetched Apple deluxe tracklist. The supplied TheAudioDB 1994 album has the same standard ten tracks. The already accepted retail master is appropriate representative Blue artwork; no pressing ownership is inferred. Production verification found it already active on this exact record among the nine accepted targets. The finite reviewed-master action returned one validated, one already active, zero applied and zero activated. No source or candidate bytes changed. The earlier description of a missing backend Blue attachment was incorrect.

**Weezer (White Album - Deluxe Edition)** has a stored Apple binding that independently resolves to **Weezer (Green Album)**. That is a confirmed title conflict. The finite repair proposal clears the five contradicted enrichment fields, with exact precondition and rollback checks, rather than assigning an unverified replacement. It does not alter history, identity, images or artwork.

The generic **Weezer** record has a Red Album MusicBrainz identity and Black Album Apple binding. It remains ambiguous. No alias, reassignment or split is authorized merely by observing that disagreement. Current mutable associations cannot prove how earlier events were originally attributed.

## Shared corrections

Track enrichment now requires both artist and song identity, and assigns an album binding only after collection-title validation. Unqualified self-titled albums remain unresolved through song enrichment. Reads and writes respect the associated user's identity.

The shared title matcher removes recognized edition labels while retaining meaningful qualifiers, Single/EP types, live versions and non-Latin titles. A word-boundary prefix is no longer sufficient to match two albums. Search cleanup retains a significant qualifier beside a deluxe label and no longer drops arbitrary parentheticals containing substrings such as `ep`.

CD selection compares known MusicBrainz artist and logical group IDs. A stored release ID is resolved as a release; only a 404 permits checking the release-group namespace. Provider failures retain retry timing instead of triggering fuzzy fallback. Known group IDs constrain candidate searches. Discovery holds unresolved identities. The enqueue reuse key includes the current catalog identity so changed identity cannot bypass validation through an old cached request.

The album browse endpoint used for identity lookup now scopes both rows and pagination to the authenticated user and excludes filtered artists as well as albums. Its image metadata is also scoped to the authenticated user.

## Validation and practical limits

Synthetic regressions cover wrong song, wrong collection, bare self-titles, distinct qualifiers, edition labels, missing provider names, non-Latin identity, cross-user writes, immutable existing enrichment, same-name/different-group CD sources, different MusicBrainz artist IDs, release/group namespaces, provider backoff, unidentified edition choices, cache identity changes, and browse ownership.

The frozen evaluation contains 218 provider-title pairs across the cohort. The fourteen held-out records supply 25 pairs: the old prefix matcher accepted all 25, while the stricter matcher accepts 12 and holds 13. Those additional holds preserve type/title ambiguity; they are not all established correct rejections. Across the cohort, 45 previously accepted pairs become holds and two title pairs newly match recognized edition labels. The matcher was not tuned against individual held-out titles. This conservative policy can reduce artwork lookup coverage until stronger identity evidence is supplied.

The known ingestion model can overwrite album MBIDs and retarget a shared track's album association. This audit found no canonical-ID drift within the frozen comparison and does not claim those code paths caused every observed mismatch. A history/catalog repair requires original event evidence and a separate finite plan; it must not be inferred from the present associations.

Release validation includes the complete API and artwork suites, type/lint/format checks, both Worker builds, independent reviews and protected CI. Production verification must confirm deployment versions, unchanged accepted bytes and generation controls. Reviewed-master preflight is separate from activation.

## Production verification

PR #304 merged as `f684a576a173797db59c2d810ebb05f97e445f82`. Protected PR/main CI and deployment passed. Both deployed Worker version IDs match the exact deployment logs. All nine accepted image hashes, generation controls and existing job IDs remain unchanged. Blue's existing accepted binding passed independent source verification, current catalog preconditions and idempotent reviewed-master validation.

A live wrong-group prepared-import probe returned `discovery_provider_error` with HTTP 503 before identity comparison. It created no job and made no paid submission. The identical source URL returned HTTP 200 from the Mac, with the expected group and CD medium; this does not establish why the Worker request failed. Wrong-group rejection is verified in CI; the live comparison remains deferred. Do not label that specific live comparison successful or turn provider failure into a missing identity.

Release verification added one direct metadata request and one bounded D1 precondition read. There were 66 direct metadata API requests in total; the production probe could make at most two upstream metadata requests before failing. Even that upper bound is below the 80-request cap. No new generation, catalog repair or artwork activation occurred.

The local Tool/Lateralus study is outside the nine verified accepted API bindings. The earlier exact-title/artist lookup did not establish an owned catalog target for it. This audit does not create a record or fabricate history to force an attachment, and it does not add a new audit/image batch. A future binding requires positive target evidence.
