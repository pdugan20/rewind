/** Change only when source/identity selection improves. Independent of pixel
 * processing: a renderer change must not retry completed catalog failures. */
export const DISCOVERY_POLICY = 'provider-identity-and-source-fallback-v2';

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
