/**
 * Shared utilities for image source clients.
 */

/**
 * Strip collaborator suffixes from artist names for cleaner search results.
 * Last.fm creates separate entries like "Kendrick Lamar feat. DODY6" or
 * "Beyoncé & Willie Jones" which fail to match on iTunes/Apple Music.
 */
export function cleanArtistName(name: string): string {
  return name.split(/\s+(?:feat\.?|ft\.?|featuring|&|and)\s+/i)[0].trim();
}
