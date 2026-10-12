# Artwork review

The private gallery is served by the artwork Worker at
`https://api.rewind.rest/v1/admin/cd-artwork/gallery`. It lists generated jobs,
newest first, with source images, registered candidates or held raw renders,
album versions and private review history. It has flat and neutral-surface disc
previews; these are inspection views, not the portfolio's Discman renderer.

## Review behavior

- **Looks good** records feedback. It does not accept a held candidate or publish
  it. Clearing the last unresolved flag resumes automatic processing unless the
  album remains explicitly hidden.
- **Needs revision** records an optional reason and bounded note, preserves the
  active artwork, and pauses new automatic submissions and publication for that
  owned album. An in-flight verified candidate remains available for manual
  review. No paid generation is triggered by feedback.
- **Hide from player** withdraws only the selected current active version and
  pauses automatic replacements. A stale card cannot hide a newer replacement.
  Public immutable asset URLs remain valid; withdrawal affects consumer
  selection on the next successful refresh.
- **Use this artwork** validates the saved candidate and explicitly accepts and
  activates it. It resolves existing album revision flags, preserving their
  notes/history, clears the hidden marker and resumes automatic processing.
  Pin protection remains in effect. Concurrent activation conflicts leave a
  pending candidate private and preserve existing flags.

Review fields are separate from the generation state machine. Material changes
continue to create immutable revisions through the existing material API and
reuse paid raw bytes where available. A lettering/source correction requiring
new generation is a separate explicit operator action; saving a review never
starts an unbounded regeneration loop.

## Private access

Create a Cloudflare Access self-hosted application protecting the gallery path
and all its descendants, with an owner-only email policy and email one-time PIN
login. Protect the exact path as well as descendants. Do not put the entire
Bearer-authenticated admin API behind this browser policy.

Install one artwork Worker secret named `CD_GALLERY_ACCESS`, containing:

```json
{
  "issuer": "https://your-team.cloudflareaccess.com",
  "audience": "the-access-application-aud-tag",
  "users": { "owner@example.test": 1 },
  "hide_ready": false
}
```

Use lowercase email keys and positive owned Rewind user IDs. Keep real owner
identities and configuration in private account notes and Worker secrets, never
public Wrangler variables or client bundles. The issuer and audience must match
the Access application. The Worker independently validates the signed RS256
application token, issuer, audience, expiry and allowlisted email. A spoofed
email header, browser API key, or direct Workers URL cannot bypass validation.
Missing configuration returns 503 without serving the gallery or private data.
Mutations require exact same-origin `Origin`, JSON and `X-Artwork-Review: 1`.
All private responses are uncached; source URLs, prompts and provider credentials
are excluded from gallery records. Notes are rendered as plain text.

The implementation follows [Cloudflare's origin JWT validation guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

## API and consumer contract

Bearer-admin clients use `/v1/admin/cd-artwork/reviews`. The browser uses the
equivalent Access-protected `/v1/admin/cd-artwork/gallery/data` routes:

- `GET` lists generated jobs with `page`, `limit` up to 48, `filter` of `all`,
  `published`, `needs_attention` or `held`, and optional `album_id` or `job_id`.
- `GET /:id/image/source|candidate|raw` streams private saved image bytes.
- `GET /:id/history` returns the latest 30 review events without reviewer identity.
- `POST /:id/feedback` accepts `status`, optional `reason` and `note` up to 1000
  characters. Status is `good` or `needs_revision`; reasons are `lettering`,
  `wrong_artwork`, `crop_geometry`, `material`, `other` or null.
- `POST /:id/hide` accepts an empty JSON object.
- `POST /:id/activate` accepts optional `expected_active_job` as a job ID or null.
  The browser sends its snapshot's active ID to detect stale approval cards.

The read-key batch endpoint `/v1/listening/cd-artwork/albums?ids=...` keeps its
`data` array and adds `revision` to accepted attachments and an independent
`withdrawals` array of `{album_id, revision}`. The single-album response adds
`withdrawal` with the same shape or null. Revisions are positive JS-safe integers,
monotonically advanced by a D1 trigger when active/hidden selection changes.
One SQL snapshot produces the accepted and withdrawn arrays consistently.
Ordinary absence and provider failure produce neither a withdrawal nor a new
revision. Review feedback does not advance visibility revisions.

Consumers must retain the newest per-album visibility revision, suppress local
registry artwork for explicitly withdrawn albums, clear decoded textures and
invalidate pending decode work, ignore older acceptance/withdrawal responses,
and restore only newer approved artwork. Fetch artwork for pinned album IDs as
well as recent collection IDs. Missing fields from legacy responses preserve
previously observed withdrawals. Collection membership, selection and audio
playback remain unchanged by artwork decisions. Release this consumer support
before exposing the gallery's hide action. `hide_ready` defaults to false in the
Access secret: the browser hides the action and the gallery rejects withdrawals
until this is explicitly set true after the consumer release. Privileged
Bearer-admin operator actions remain separate.

## Deployment and rollback

Apply additive migration `0051_cd_artwork_feedback.sql` to production D1
`rewind-db` before deploying the artwork Worker. Existing artwork and feedback
default to unchanged visibility and unreviewed status. The gallery stays dark
until its Access application and secret are installed and authenticated browser
verification passes. MCP package publishing is not required.

Verify real owned gallery listing and source/candidate image access, unauthorized
and wrong-owner denial, same-origin feedback, and preservation of existing active
hashes. Test mutations with synthetic local fixtures first; do not fabricate
production plays or flag approved production artwork solely to test controls.

If rolling back to a Worker that predates review holds, disable automatic
processing first so it cannot ignore outstanding flags or withdrawals. Keep
the additive schema and private review records. Reapply the verified Worker or
forward-fix before resuming automation. Removing the Access secret closes the
gallery without altering existing review or publication state.
