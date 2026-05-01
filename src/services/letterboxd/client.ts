/**
 * Letterboxd RSS feed parser.
 * Parses the public RSS feed with Letterboxd custom namespace extensions.
 */

export interface LetterboxdEntry {
  guid: string;
  title: string;
  link: string;
  pubDate: string;
  filmTitle: string;
  filmYear: number | null;
  watchedDate: string | null;
  memberRating: number | null;
  rewatch: boolean;
  review: string | null;
  tmdbMovieId: number | null;
  /**
   * Letterboxd marks some entries as TV series (e.g. multi-part docs like
   * "The History of the Seattle Mariners"). The RSS uses tmdb:tvId
   * instead of tmdb:movieId for these. Only ever set when tmdbMovieId
   * is null. Treated as movie-equivalent in the watching pipeline since
   * RSS gives series-level watches without episode info.
   */
  tmdbTvId: number | null;
  /**
   * Poster URL embedded in the entry's <description> CDATA. Letterboxd
   * always includes a poster <img> as the first child of the description.
   * Used as a fallback when TMDB doesn't have the title (e.g. TMDB-orphan
   * TV docs) so the watch still renders with a thumbnail.
   */
  posterUrl: string | null;
}

/**
 * Fetch and parse the Letterboxd RSS feed for a user.
 */
export async function fetchLetterboxdFeed(
  username: string
): Promise<LetterboxdEntry[]> {
  const feedUrl = `https://letterboxd.com/${username}/rss/`;

  const response = await fetch(feedUrl, {
    headers: {
      Accept: 'application/rss+xml, application/xml, text/xml',
      'User-Agent': 'RewindAPI/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(
      `[ERROR] Letterboxd feed fetch failed: ${response.status} ${response.statusText}`
    );
  }

  const xml = await response.text();
  return parseLetterboxdRss(xml);
}

/**
 * Parse Letterboxd RSS XML into structured entries.
 * Uses regex-based parsing since Workers don't have a built-in XML parser.
 */
export function parseLetterboxdRss(xml: string): LetterboxdEntry[] {
  const entries: LetterboxdEntry[] = [];

  // Extract all <item> blocks
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let itemMatch;

  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const itemXml = itemMatch[1];

    const guid = extractTag(itemXml, 'guid') || '';
    const title = extractTag(itemXml, 'title') || '';
    const link = extractTag(itemXml, 'link') || '';
    const pubDate = extractTag(itemXml, 'pubDate') || '';

    // Letterboxd namespace extensions
    const filmTitle = extractTag(itemXml, 'letterboxd:filmTitle') || title;
    const filmYearStr = extractTag(itemXml, 'letterboxd:filmYear');
    const watchedDate = extractTag(itemXml, 'letterboxd:watchedDate');
    const memberRatingStr = extractTag(itemXml, 'letterboxd:memberRating');
    const rewatchStr = extractTag(itemXml, 'letterboxd:rewatch');
    const tmdbMovieIdStr = extractTag(itemXml, 'tmdb:movieId');
    const tmdbTvIdStr = extractTag(itemXml, 'tmdb:tvId');

    // Only include diary entries (those with a watched date)
    // Items without watchedDate are reviews or list entries
    if (!watchedDate) continue;

    // Extract review text + poster URL from <description> CDATA
    // Format: <p><img src="...poster..."/></p> <p>Review text here.</p>
    const description = extractTag(itemXml, 'description');
    const review = extractReviewTextFromDescription(description);
    const posterUrl = extractPosterUrlFromDescription(description);

    entries.push({
      guid,
      title,
      link,
      pubDate,
      filmTitle,
      filmYear: filmYearStr ? parseInt(filmYearStr, 10) : null,
      watchedDate: watchedDate || null,
      memberRating: memberRatingStr ? parseFloat(memberRatingStr) : null,
      rewatch: rewatchStr === 'Yes',
      review,
      tmdbMovieId: tmdbMovieIdStr ? parseInt(tmdbMovieIdStr, 10) : null,
      tmdbTvId: tmdbTvIdStr ? parseInt(tmdbTvIdStr, 10) : null,
      posterUrl,
    });
  }

  return entries;
}

/**
 * Extract review text from the RSS <description> CDATA block.
 * The description contains an optional poster image followed by review paragraphs.
 * Returns null if only a poster image is present (no actual review text).
 */
function extractReviewTextFromDescription(
  description: string | null
): string | null {
  if (!description) return null;

  // Remove all HTML tags
  const text = description
    .replace(/<[^>]+>/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  // If empty after stripping tags (poster-only entries), return null
  return text.length > 0 ? text : null;
}

/**
 * Extract the poster image URL from the RSS <description> CDATA block.
 * Letterboxd embeds the poster as the first <img src="..."> in description.
 * Used as a TMDB-poster fallback when TMDB doesn't carry the title.
 */
function extractPosterUrlFromDescription(
  description: string | null
): string | null {
  if (!description) return null;
  const match = description.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  return match?.[1] ?? null;
}

/**
 * Extract the text content of an XML tag.
 */
function extractTag(xml: string, tagName: string): string | null {
  // Handle CDATA and regular content
  const regex = new RegExp(
    `<${tagName}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${tagName}>`,
    'i'
  );
  const match = regex.exec(xml);
  if (!match) return null;
  return (match[1] || match[2] || '').trim();
}
