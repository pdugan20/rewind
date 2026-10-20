/** Artwork identity comparison, shared by independently verified providers.
 * Typography is not identity evidence by itself: callers also verify the
 * album, release group or observed track. Do not strip edition qualifiers,
 * articles, guest credits or words, and never override conflicting IDs. */
export function artworkName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function artworkArtistMatches(a: string, b: string): boolean {
  const name = artworkName(a);
  return !!name && name === artworkName(b);
}
