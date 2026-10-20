import { foldAccents } from '../images/sources/utils.js';

/** Artwork identity comparison, shared by independently verified providers.
 * Typography is not identity evidence by itself: callers also verify the
 * album, release group or observed track. Do not strip edition qualifiers,
 * articles, guest credits or words, and never override conflicting IDs.
 * Stricter than artistIdentityMatches in images/sources/utils.ts, which
 * drops articles and guest credits for Apple Music matching; both fold
 * accents the same way. */
export function artworkName(value: string): string {
  return foldAccents(value)
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function artworkArtistMatches(a: string, b: string): boolean {
  const name = artworkName(a);
  return !!name && name === artworkName(b);
}
