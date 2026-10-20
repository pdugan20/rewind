/**
 * Shared utilities for image source clients.
 */

/**
 * Substitute `&` with `and` for friendlier upstream search behavior.
 * Apple Music / iTunes / Deezer free-text search occasionally tokenizes `&`
 * oddly, and most catalogs index "Matt & Kim" alongside the spelled-out form.
 */
function substituteAmpersand(name: string): string {
  return name.replace(/\s*&\s*/g, ' and ').replace(/\s+/g, ' ');
}

/**
 * Strip featured artist suffixes from artist names for cleaner search results.
 * Last.fm creates separate entries like "Kendrick Lamar feat. DODY6" or
 * "Gorillaz feat. IDLES" which fail to match on iTunes/Apple Music.
 *
 * Also rewrites `&` to `and` so artists like "Matt & Kim" or "Simon &
 * Garfunkel" match the spelled-out form returned by upstream catalogs.
 */
export function cleanArtistName(name: string): string {
  const stripped = name.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0].trim();
  return substituteAmpersand(stripped);
}

/**
 * Clean an album name for search queries.
 * Removes recognized edition labels and store format suffixes for search.
 * Significant qualifiers remain part of the title used for matching.
 * Also rewrites `&` to `and` for the same reason as cleanArtistName.
 */
export function cleanAlbumName(name: string): string {
  const stripped = stripEditionLabels(name)
    .replace(/\s*-\s*(?:EP|Single)$/i, '')
    .trim();
  return substituteAmpersand(stripped);
}

/** Remove recognized edition labels while retaining title disambiguators. */
function stripEditionLabels(name: string): string {
  const edition = (s: string) =>
    /^(?:(?:\d{4}|\d+(?:st|nd|rd|th))\s+)?(?:(?:deluxe|expanded)(?:\s+(?:edition|version))?|(?:special|bonus|anniversary)\s+(?:edition|version|tracks?)|remaster(?:ed)?)(?:\s+\d{4})?$/i.test(
      s.trim()
    );
  return name
    .replace(
      /\s*([([])([^)\]]+)([)\]])/g,
      (_all, open, body: string, close) => {
        const parts = body.split(/\s*[/\u2013\u2014]\s*|\s+-\s+/);
        while (parts.length && edition(parts[parts.length - 1])) parts.pop();
        return parts.length ? ` ${open}${parts.join(' - ')}${close}` : '';
      }
    )
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
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['\u2018\u2019`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
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
 * Removes combining accents. Catalogs stylize names that Last.fm stores
 * plainly: Apple credits JAY-Z as "JAŸ-Z". Every artist identity check, for
 * Apple Music matching and for disc artwork, folds accents with this.
 */
export function foldAccents(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '');
}

/** An artist name as the Apple Music and iTunes checks compare it. */
function artistKey(name: string): string {
  return stripThe(normalize(foldAccents(cleanArtistName(name))));
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
  const req = artistKey(requested);
  const ret = artistKey(returned);
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

/** Provider catalog writes require equal artist identity, not a prefix match. */
export function artistIdentityMatches(
  requested: string,
  returned: string
): boolean {
  const req = artistKey(requested);
  const ret = artistKey(returned);
  return !!req && req === ret;
}

/**
 * Compare song identity without accepting arbitrary title extensions or live versions.
 */
export function trackMatches(requested: string, returned: string): boolean {
  const req = normalize(stripEditionLabels(requested));
  const ret = normalize(stripEditionLabels(returned));
  return !!req && !!ret && req === ret;
}

/** A title as trackMatches compares it: edition labels removed, normalized. */
export function comparableTitle(name: string): string {
  return normalize(stripEditionLabels(name));
}

/**
 * Check if a returned album/collection name is a reasonable match.
 * Titles must be equal after removing recognized edition labels. Distinct
 * qualifiers, live versions, and Single/EP types cannot match a bare title.
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
  const req = stripThe(normalize(stripEditionLabels(requested)));
  const ret = stripThe(normalize(stripEditionLabels(returned)));
  if (!req || !ret) return false;
  if (req === ret) return true;

  // Try stripping artist name prefix from requested album
  if (artistName) {
    const normArtist = stripThe(normalize(cleanArtistName(artistName)));
    if (normArtist && req.startsWith(normArtist + ' ')) {
      const stripped = req.slice(normArtist.length + 1);
      if (stripped && stripped === ret) return true;
    }
  }

  return false;
}
