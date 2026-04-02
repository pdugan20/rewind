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
 * Clean an album name for search queries.
 * Strips parenthetical/bracketed suffixes (deluxe, remastered, bonus, EP, single)
 * and version suffixes that confuse search APIs without affecting matching accuracy.
 */
export function cleanAlbumName(name: string): string {
  return name
    .replace(
      /\s*[([][^)\]]*(?:deluxe|remaster|bonus|expanded|anniversary|edition|version|ep|single)[^)\]]*[)\]]/gi,
      ''
    )
    .replace(/\s*-\s*(?:EP|Single)$/i, '')
    .trim();
}

/** Map of number words to digits for title normalization. */
const NUMBER_WORDS: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
};

/**
 * Normalize a name for comparison.
 * Strips punctuation, extra whitespace, lowercases, and standardizes
 * number words and common abbreviations (pt/part, vol/volume).
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/['\u2018\u2019`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b(?:part|pt)\b/g, 'pt')
    .replace(/\b(?:volume|vol)\b/g, 'vol')
    .replace(
      /\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g,
      (m) => NUMBER_WORDS[m] ?? m
    );
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
 * Check if two normalized names match at a word boundary (one starts with the other).
 */
function wordBoundaryMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (b.startsWith(a) && (b.length === a.length || b[a.length] === ' ')) {
    return true;
  }
  if (a.startsWith(b) && (a.length === b.length || a[b.length] === ' ')) {
    return true;
  }
  return false;
}

/**
 * Check if a returned album/collection name is a reasonable match.
 * The returned name must start with the requested name (allowing
 * suffixes like "(Deluxe Edition)"). Exact word boundary required.
 * "GUTS" matches "GUTS (Deluxe)" but "Gold" does NOT match "Golden Greats".
 *
 * When artistName is provided, also tries stripping the artist name prefix
 * from the requested album. Last.fm sometimes stores albums as
 * "Beastie Boys Anthology: The Sounds of Science" while sources return
 * "Anthology: The Sounds of Science".
 */
export function albumMatches(
  requested: string,
  returned: string,
  artistName?: string
): boolean {
  const req = stripThe(normalize(requested));
  const ret = stripThe(normalize(returned));
  if (!req || !ret) return false;
  if (wordBoundaryMatch(req, ret)) return true;

  // Try stripping artist name prefix from requested album
  if (artistName) {
    const normArtist = stripThe(normalize(cleanArtistName(artistName)));
    if (normArtist && req.startsWith(normArtist + ' ')) {
      const stripped = req.slice(normArtist.length + 1);
      if (stripped && wordBoundaryMatch(stripped, ret)) return true;
    }
  }

  return false;
}
