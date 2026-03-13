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
