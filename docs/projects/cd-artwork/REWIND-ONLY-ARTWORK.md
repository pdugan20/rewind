# Rewind-owned CD artwork — superseded

Historical handoff, not an approved implementation or publication plan. Its per-album
review and repaired-scan acceptance claims were rejected. Follow
[Automatic artwork pipeline repair](PIPELINE-REPAIR.md) instead. The private
manual release script is disabled; do not execute the old import manifests.

October 12, 2026. Patrick approved consolidating CD artwork in Rewind, removing
portfolio test imagery and overrides, and adding the AudioDB disc-art lookup.

Execution mode: coordinated agent implementation — two GPT-6 Luna medium workers
own portfolio cleanup and generic fallback storage; the parent owns source
selection, migration preparation, integration and final judgment. No expensive
worker fanout or paid image request is needed to prepare this batch.

## Contract and ownership

Rewind owns discovery, official-source review, registration, accepted image
storage, selection and the generic Sony fallback. The portfolio displays owned
accepted snapshots and uses only Rewind image URLs. It has no artist/album image
registry, bundled CD photos, comparison overrides or generated-artwork fixtures.
Device body/well assets and neutral procedural loading graphics are rendering
resources, not album artwork. Existing unrelated player-polish work is preserved.

Authenticated `/v1/listening/cd-artwork/albums` retains `data` and `withdrawals`
and adds optional `fallback_artwork`, a generic descriptor with canonical
1024/512/480/60 geometry and PNG plus optional verified WebP URLs under
`/v1/listening/cd-artwork/fallback/assets/`. Metadata is user scoped; generic
published pixels contain no user or listening metadata. Old clients ignore the
new field; new clients without it render a neutral loading disc.

AudioDB uses the verified MusicBrainz release-group identity through
`album-mb.php?i=...`, exact artist/album checks, the dedicated `strAlbumCDart`
field and a narrow image host/path allowlist. Prepared provider art is not proof
of an official design. Official-source review is bound to the user, owned album,
provider album, release group, URL and downloaded SHA-256. Changed bytes must be
reviewed again. CAA retail selection remains first; verified AudioDB retail art
is considered before album-cover generation. Provider errors remain retriable
and distinct from a miss. Fanart and automated Discogs integration are outside
this batch; any later Fanart candidate must be verified official retail art.

## Checkpoints

1. Producer: additive source/fallback routes, immutable R2 publication, ownership
   and integrity tests. No source or listening-history migration is required.
2. Migration preparation: archive reachable local CD experiments, inventory
   accepted assets and real album identities, prepare imports of repaired scans
   and the generic fallback. Reuse accepted hashes; create no fake album/history.
3. Consumer: remove runtime overrides and local CD assets, validate and consume
   the Rewind generic descriptor, preserve polling, withdrawals, audio and device
   behavior. Run focused and repository gates.
4. Integration: exercise real local Workers-backed metadata and assets against
   the consumer, including absent fallback, invalid metadata and image failures.
5. Publication: review a named production import/deployment packet, then publish
   producer and approved assets before releasing the consumer. Live data writes,
   deployment, push/PR/merge remain separate authorization boundaries.

## Acceptance and rollback

Pinkerton lookup returns its disc-face candidate using the release-group ID,
never the artist ID or release MBID. Unverified custom art cannot enter paid
retail generation. All previously accepted images and pins survive. The repaired
legacy scans retain official artwork and canonical geometry in Rewind. No local
CD image is reachable from the portfolio. The old and new backend/client
combinations remain safe. No visitor request performs generation.

Producer rollback retains accepted immutable assets and disables new source
admission if needed. Consumer rollback is a separate release; keep a recoverable
archive of removed experiments. Source readiness, local integration, deployed
infrastructure, imported accepted art and user availability are reported as
separate states.

## Prepared release packet

Implementation lives on `feat/cd-art-audiodb` in the existing Rewind artwork
checkout and `fix/discman-rewind-only` in the isolated portfolio cleanup checkout.
The unrelated `spike/discman-polish` checkout and its preview remain intact.
Recovery archives and migration packets are private ignored operator artifacts;
no credentials, album IDs or listening history are added to source control.

The finite asset packet imports repaired Nirvana, Wilco and Pierce the Veil scans,
plus Pinkerton normalized directly from the exact AudioDB disc-face PNG. All four
retain source artwork and use canonical concentric geometry. The Sony generic
fallback is separately seeded. Existing accepted Soundgarden art is reused,
along with other accepted Rewind assets. No paid image-generation request is
needed. Source photos, exact hashes and registration measurements accompany the
private packet. The three missing legacy records pass the deployed import
endpoint's validation-only mode; Pinkerton's AudioDB-specific import is validated
locally and requires the new source review/import code in production.

Publication order:

1. Publish the additive Rewind Worker implementation.
2. Verify Pinkerton's exact provider metadata and bytes, save the owner's explicit
   official-source decision, and seed the reviewed generic fallback.
3. Preflight all four imports against current owned album identity, pins and
   active state before applying any album import. Accept and activate the exact
   reviewed masters through the existing finite import operator.
4. Verify accepted snapshots, immutable assets and both light/dark renders.
5. Release the portfolio cleanup and verify its production collection and player.

No deployment, asset publication, accepted-album replacement, push or PR has been
performed during preparation. Production publication requires Patrick's explicit
release authorization under `AGENTS.md`.

## Verification evidence

Portfolio: full tests pass with 674 passing and one skipped; focused final loader
checks pass with 30 tests. Lint including asset checks, type checking, generated
asset manifests and diff checks pass. A read-only live-data preview at the active
LAN address returned accepted Rewind artwork and correctly displayed neutral
procedural discs while the backend generic descriptor was absent. Twenty-nine
bundled CD files and their registry/gallery/generation paths were removed;
body, well, controls and unrelated speaker studies remain.

Rewind: normal suite passes 1,104 tests; the CD suite passes 138 tests and seven
operator/pipeline tests. Focused owner-review/import tests cover exact identity,
user scope, official-source decisions, source hashes and zero job creation during
preview. Type checking, lint and Worker deployment dry run pass. All six prepared
PNG masters, including the unused Soundgarden migration candidate, pass canonical
geometry validation. Two independent bounded GPT-6 Luna medium reviews reported
no actionable findings. Exact cloud inference cost was not available; the batch
used two implementation workers and two review workers, with no artwork model
requests.

A private integration check also seeded the actual generic PNG in local Workers
R2, read it through the authenticated API, projected it through the portfolio's
current validator, and verified the public asset bytes against the declared
hash. That check passed without network calls or production writes. The final
AudioDB reviewed-master extension passed the 35-test owner/import suite, type
checking, lint and the updated Worker build dry run.

## Integrated review before deployment

Patrick requested a complete working review using the latest local player before
any deployment. The review stack now runs the updated Rewind Worker with isolated
local D1 and R2, automatic generation disabled and no image-model credential.
Existing accepted artwork is mirrored by exact public hash; the four corrected
masters are validated, stored, accepted and activated through the actual Rewind
admin endpoints. The generic Sony fallback is also published in this isolated
Rewind store. Production storage and services remain untouched.

The portfolio still reads the latest 30 plays from production Rewind and derives
its five most recent albums normally. Only development CD-artwork transport goes
to the isolated Rewind service, with a separate local key. Canonical Rewind asset
URLs, origin/hash validation and metadata stay unchanged. A development-only
pixel proxy checks accepted bytes, MIME, size and SHA-256; production ignores the
local transport configuration and the proxy returns 404. No portfolio-local CD
photos, artwork registry or fixture gallery is restored.

The current local player polish is integrated in the cleanup branch: physical
controls and styling, the default Soft stage presentation, the repaired shell
and the latest overlay/details layout. The shell asset exactly matches the local
`body-shell.png` candidate and regenerates through the normal image pipeline.
Escape and the close control reset the listening URL so the homepage link can
reopen the player. The unrelated source polish checkout remains intact.

Final evidence: the integrated collection returns five real recent albums;
Pinkerton uses the exact normalized AudioDB CD-art hash with retail provenance;
all four corrected masters are active; six accepted/public image hashes verify,
including the generic fallback. Desktop and compact rendering, disc exchanges,
available preview playback, unavailable-preview handling, lid controls, Escape
and reopening were exercised. An isolated withdrawal visibly selected the Sony
fallback; the corrected Nirvana master was then restored and reverified.
Private screenshots and operator receipts are retained in the ignored review
packet. The latest final suites passed 138 CD-artwork tests plus seven pipeline
checks and 678 portfolio tests with one skipped. Portfolio production build,
type checking, lint, asset checks and diff checks passed. The integrated delta
received an independent bounded GPT-6 Luna review with no actionable findings.

Review entry point is the portfolio's normal `/listening` route on port 3059.
The backend listens on loopback port 8789 and remains inaccessible as an admin
service from the LAN. Both services run in persistent detached sessions. Active
LAN addressing and HTTP 200 are verified when handing the preview to Patrick.
The remaining publication boundary is deployment and the finite production asset
packet after Patrick reviews the working preview.
