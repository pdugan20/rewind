/**
 * Shared utilities for image source clients.
 */

/**
 * Strip featured artist suffixes from artist names for cleaner search results.
 * Last.fm creates separate entries like "Kendrick Lamar feat. DODY6" or
 * "Gorillaz feat. IDLES" which fail to match on iTunes/Apple Music.
 *
 * Only strips feat/ft/featuring -- NOT "&" or "and", which are part of
 * legitimate artist names (e.g., "Simon & Garfunkel", "Tom Petty and The Heartbreakers").
 */
export function cleanArtistName(name: string): string {
  return name.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0].trim();
}

/**
 * Normalize a name for fuzzy comparison.
 * Strips punctuation, extra whitespace, and lowercases.
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if a returned artist name is a reasonable match for the requested one.
 * Uses normalized containment -- either name contains the other.
 * This catches "Gorillaz" matching "Gorillaz feat. IDLES" and
 * "The Black Keys" matching "Black Keys".
 */
export function artistMatches(requested: string, returned: string): boolean {
  const req = normalize(cleanArtistName(requested));
  const ret = normalize(cleanArtistName(returned));
  if (!req || !ret) return false;
  return req === ret || ret.includes(req) || req.includes(ret);
}

/**
 * Check if a returned album/collection name is a reasonable match.
 * More lenient than artist matching -- allows subtitle differences
 * like "Album (Deluxe)" matching "Album".
 */
export function albumMatches(requested: string, returned: string): boolean {
  const req = normalize(requested);
  const ret = normalize(returned);
  if (!req || !ret) return false;
  return req === ret || ret.includes(req) || req.includes(ret);
}
