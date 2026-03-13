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
 * Normalize a name for comparison.
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
 * Strip "the" prefix for comparison purposes.
 */
function stripThe(s: string): string {
  return s.replace(/^the\s+/, '');
}

/**
 * Check if a returned artist name is a reasonable match for the requested one.
 * The returned name must start with the requested name (after normalization
 * and "the" stripping). This allows "The Animals Retrospective" to match
 * "The Animals" but rejects "Glass Animals" because it doesn't start with
 * "Animals". Also rejects "Buddy" for "Buddy Holly" because "Buddy" doesn't
 * start with "Buddy Holly".
 */
export function artistMatches(requested: string, returned: string): boolean {
  const req = stripThe(normalize(cleanArtistName(requested)));
  const ret = stripThe(normalize(cleanArtistName(returned)));
  if (!req || !ret) return false;
  if (req === ret) return true;
  // Returned must start with requested at a word boundary
  // Allows "The Animals Retrospective" for "The Animals" but not "Glass Animals"
  if (
    ret.startsWith(req) &&
    (ret.length === req.length || ret[req.length] === ' ')
  ) {
    return true;
  }
  return false;
}

/**
 * Check if a returned album/collection name is a reasonable match.
 * The returned name must start with the requested name (allowing
 * suffixes like "(Deluxe Edition)"). Exact word boundary required.
 * "GUTS" matches "GUTS (Deluxe)" but "Gold" does NOT match "Golden Greats".
 */
export function albumMatches(requested: string, returned: string): boolean {
  const req = stripThe(normalize(requested));
  const ret = stripThe(normalize(returned));
  if (!req || !ret) return false;
  if (req === ret) return true;
  // Returned must start with requested at a word boundary
  if (
    ret.startsWith(req) &&
    (ret.length === req.length || ret[req.length] === ' ')
  ) {
    return true;
  }
  // Requested might have extra subtitle: "Garden State: Music from..." matches "Garden State"
  if (
    req.startsWith(ret) &&
    (req.length === ret.length || req[ret.length] === ' ')
  ) {
    return true;
  }
  return false;
}
