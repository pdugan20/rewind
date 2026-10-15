/**
 * Name comparison for matching Last.fm plays to Apple Music catalog releases.
 *
 * Last.fm names come from whatever the scrobbler sent, so they differ from the
 * catalog in small ways: "A Match In Water" for "A Match Into Water",
 * "Reservoir Dogs" for "Reservoir Dogs (Original Motion Picture Soundtrack)",
 * "Sisteron" for "Sisteron - Single". These rules accept those differences
 * while keeping anything that names a different recording or release apart:
 * numbers, live and remix variants, and distinct subtitles.
 */

import {
  albumMatches,
  comparableTitle,
  trackMatches,
} from '../images/sources/utils.js';

// Words that name a packaging of the same recordings. Recording variants such
// as instrumental, acoustic, remix, sped-up or re-recorded ("Taylor's
// Version") are deliberately absent.
const EDITION_WORDS =
  "(?:\\d+\\s*am|til dawn|(?:super )?deluxe|expanded|(?:\\d+(?:st|nd|rd|th) )?anniversary|special|bonus(?: tracks?)?|collector'?s|complete|platinum|international|tour|\\d{4})";
// A whole trailing bracket: "(Live)", "(3am Edition)", "(The Til Dawn
// Edition)", "(Deluxe)" or "(Remastered 2011)". Never "(Live at Wembley)".
const EDITION_QUALIFIER = new RegExp(
  `\\s*[([](?:live|(?:the )?(?:${EDITION_WORDS} )*(?:edition|version)|(?:\\d{4} )?remaster(?:ed)?(?: \\d{4})?|(?:super )?deluxe|expanded)[)\\]]\\s*$`,
  'i'
);

/**
 * The stored catalog id was chosen from the songs actually played, so the
 * catalog may name that edition: "Midnights (3am Edition)" or
 * "From the Muddy Banks of the Wishkah (Live)" for a bare stored title.
 * Only the catalog side drops such qualifiers; a different title, or a
 * stored qualifier the catalog lacks, still fails.
 */
export function tracklistTitleMatches(
  stored: string,
  catalog: string,
  artistName: string
): boolean {
  if (albumMatches(stored, catalog, artistName)) return true;
  let bare = catalog;
  while (EDITION_QUALIFIER.test(bare))
    bare = bare.replace(EDITION_QUALIFIER, '');
  return bare !== catalog && albumMatches(stored, bare, artistName);
}

// A store format suffix: "Sisteron - Single", "Hummingbird - EP".
const FORMAT_SUFFIX = /\s+-\s+(?:single|ep)\s*$/i;
// A trailing descriptor naming the release a soundtrack: "(Original Motion
// Picture Soundtrack)", ": Original Score", "- Music From the Film". The
// title before it stays, so "Star Wars: A New Hope (Original Score)" still
// differs from "Star Wars".
const SOUNDTRACK_BRACKET =
  /\s*[([][^)\]]*\b(?:soundtrack|score|cast recording|music from)\b[^)\]]*[)\]]\s*$/i;
const SOUNDTRACK_SUFFIX =
  /\s*(?::|\s-|\u2013|\u2014)\s*[^:\u2013\u2014]*\b(?:soundtrack|score|cast recording|music from)\b[^:\u2013\u2014]*$/i;

function bareRelease(title: string): string {
  return title
    .replace(FORMAT_SUFFIX, '')
    .replace(SOUNDTRACK_BRACKET, '')
    .replace(SOUNDTRACK_SUFFIX, '')
    .trim();
}

/**
 * Whether a catalog release title names the stored album. Accepts edition
 * qualifiers on the catalog side (tracklistTitleMatches), store format
 * suffixes and soundtrack descriptors on either side.
 */
export function releaseTitleMatches(
  stored: string,
  catalog: string,
  artistName: string
): boolean {
  if (tracklistTitleMatches(stored, catalog, artistName)) return true;
  const bareStored = bareRelease(stored);
  const bareCatalog = bareRelease(catalog);
  if (!bareStored || !bareCatalog) return false;
  if (bareStored === stored && bareCatalog === catalog) return false;
  return tracklistTitleMatches(bareStored, bareCatalog, artistName);
}

/** How closely a release title matches: 3 exact, 2 edition, 1 format, 0 none. */
export function releaseMatchRank(
  stored: string,
  catalog: string,
  artistName: string
): number {
  if (albumMatches(stored, catalog, artistName)) return 3;
  if (tracklistTitleMatches(stored, catalog, artistName)) return 2;
  return releaseTitleMatches(stored, catalog, artistName) ? 1 : 0;
}

// Words that make a different recording of the same song.
const VARIANT_WORDS = new Set([
  'live',
  'remix',
  'mix',
  'acoustic',
  'demo',
  'instrumental',
  'karaoke',
  'edit',
  'reprise',
  'version',
  'rerecorded',
  'sped',
  'slowed',
  'mono',
  'stereo',
  'cover',
  'interlude',
]);
// Shorter titles must match exactly: one letter is a different song.
const FUZZY_MIN_LENGTH = 8;

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    previous = current;
  }
  return previous[b.length];
}

const words = (title: string) => title.split(' ').filter(Boolean);
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((word) => b.includes(word));

/**
 * Whether a catalog song title names the played song. Exact after
 * normalization, or within two edits (three for long titles) when both
 * titles carry the same numbers and the same variant words.
 */
export function songTitleMatches(played: string, catalog: string): boolean {
  if (trackMatches(played, catalog)) return true;
  const a = comparableTitle(played);
  const b = comparableTitle(catalog);
  if (Math.min(a.length, b.length) < FUZZY_MIN_LENGTH) return false;
  const numbers = (t: string) => words(t).filter((w) => /\d/.test(w));
  const variants = (t: string) => words(t).filter((w) => VARIANT_WORDS.has(w));
  if (!sameSet(numbers(a), numbers(b)) || !sameSet(variants(a), variants(b)))
    return false;
  const allowed = Math.min(a.length, b.length) >= 20 ? 3 : 2;
  return editDistance(a, b) <= allowed;
}
