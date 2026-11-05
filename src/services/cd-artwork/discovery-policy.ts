/** Change only when source/identity selection improves. Independent of pixel
 * processing: a renderer change must not retry completed catalog failures. */
export const DISCOVERY_POLICY = 'corroborated-album-identity-v3';

/** SQL fragment shared by post-enrichment admission and scheduled recovery.
 * Callers bind c/a/r to the owned artwork, album and artist rows. Old failures
 * without a snapshot are handled by policy recovery, never guessed changed. */
export const CATALOG_EVIDENCE_CHANGED = `json_type(c.discovery_evidence,'$.catalog_identity')='object'
  AND (a.name IS NOT json_extract(c.discovery_evidence,'$.catalog_identity.name')
    OR r.name IS NOT json_extract(c.discovery_evidence,'$.catalog_identity.artist')
    OR a.mbid IS NOT json_extract(c.discovery_evidence,'$.catalog_identity.mbid')
    OR r.mbid IS NOT json_extract(c.discovery_evidence,'$.catalog_identity.artist_mbid')
    OR a.apple_music_id IS NOT json_extract(c.discovery_evidence,'$.catalog_identity.apple_music_id'))`;

/** Only these older source-discovery failures benefit from this revision.
 * Render failures, manual decisions and unknown failures are not replayed. */
export const RECOVERABLE_DISCOVERY_CODES = [
  'catalog_identity_unresolved',
  'cover_not_found',
  'cover_identity_unverified',
  'cover_identity_ambiguous',
  'cover_track_mismatch',
  'edition_medium_ambiguous',
] as const;
