import { describe, it, expect } from 'vitest';
import { parseLetterboxdRss } from './client.js';

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:letterboxd="https://letterboxd.com"
  xmlns:tmdb="https://themoviedb.org">
<channel>
  <title>Letterboxd - patdugan</title>
  <item>
    <title>Inception, 2010 - ★★★★★</title>
    <link>https://letterboxd.com/patdugan/film/inception/</link>
    <guid isPermaLink="false">letterboxd-watch-117795457</guid>
    <pubDate>Mon, 9 Mar 2026 08:00:00 +1200</pubDate>
    <letterboxd:watchedDate>2026-03-08</letterboxd:watchedDate>
    <letterboxd:rewatch>No</letterboxd:rewatch>
    <letterboxd:filmTitle>Inception</letterboxd:filmTitle>
    <letterboxd:filmYear>2010</letterboxd:filmYear>
    <letterboxd:memberRating>5.0</letterboxd:memberRating>
    <tmdb:movieId>27205</tmdb:movieId>
  </item>
  <item>
    <title>The Dark Knight, 2008 - ★★★★½</title>
    <link>https://letterboxd.com/patdugan/film/the-dark-knight/</link>
    <guid isPermaLink="false">letterboxd-watch-117795458</guid>
    <pubDate>Sat, 7 Mar 2026 12:00:00 +1200</pubDate>
    <letterboxd:watchedDate>2026-03-07</letterboxd:watchedDate>
    <letterboxd:rewatch>Yes</letterboxd:rewatch>
    <letterboxd:filmTitle>The Dark Knight</letterboxd:filmTitle>
    <letterboxd:filmYear>2008</letterboxd:filmYear>
    <letterboxd:memberRating>4.5</letterboxd:memberRating>
    <tmdb:movieId>155</tmdb:movieId>
  </item>
  <item>
    <title>Some List Entry</title>
    <link>https://letterboxd.com/patdugan/list/my-list/</link>
    <guid isPermaLink="false">letterboxd-list-123</guid>
    <pubDate>Fri, 6 Mar 2026 12:00:00 +1200</pubDate>
  </item>
  <item>
    <title>The History of the Seattle Mariners, 2020 - ★★★★★</title>
    <link>https://letterboxd.com/patdugan/film/the-history-of-the-seattle-mariners/</link>
    <guid isPermaLink="false">letterboxd-review-1299202796</guid>
    <pubDate>Fri, 1 May 2026 12:13:14 +1200</pubDate>
    <letterboxd:watchedDate>2026-04-30</letterboxd:watchedDate>
    <letterboxd:rewatch>Yes</letterboxd:rewatch>
    <letterboxd:filmTitle>The History of the Seattle Mariners</letterboxd:filmTitle>
    <letterboxd:filmYear>2020</letterboxd:filmYear>
    <letterboxd:memberRating>5.0</letterboxd:memberRating>
    <tmdb:tvId>103643</tmdb:tvId>
  </item>
</channel>
</rss>`;

describe('parseLetterboxdRss', () => {
  it('parses diary entries from RSS feed', () => {
    const entries = parseLetterboxdRss(SAMPLE_RSS);
    // Inception, Dark Knight, Mariners — list entry skipped
    expect(entries).toHaveLength(3);
  });

  it('extracts film title and year', () => {
    const entries = parseLetterboxdRss(SAMPLE_RSS);
    expect(entries[0].filmTitle).toBe('Inception');
    expect(entries[0].filmYear).toBe(2010);
  });

  it('extracts watched date', () => {
    const entries = parseLetterboxdRss(SAMPLE_RSS);
    expect(entries[0].watchedDate).toBe('2026-03-08');
  });

  it('extracts member rating', () => {
    const entries = parseLetterboxdRss(SAMPLE_RSS);
    expect(entries[0].memberRating).toBe(5.0);
    expect(entries[1].memberRating).toBe(4.5);
  });

  it('extracts rewatch flag', () => {
    const entries = parseLetterboxdRss(SAMPLE_RSS);
    expect(entries[0].rewatch).toBe(false);
    expect(entries[1].rewatch).toBe(true);
  });

  it('extracts TMDB movie ID', () => {
    const entries = parseLetterboxdRss(SAMPLE_RSS);
    expect(entries[0].tmdbMovieId).toBe(27205);
    expect(entries[1].tmdbMovieId).toBe(155);
  });

  it('extracts TMDB tv ID for series-shaped entries', () => {
    const entries = parseLetterboxdRss(SAMPLE_RSS);
    const mariners = entries.find((e) =>
      e.filmTitle.startsWith('The History of the Seattle Mariners')
    );
    expect(mariners).toBeDefined();
    expect(mariners?.tmdbMovieId).toBeNull();
    expect(mariners?.tmdbTvId).toBe(103643);
  });

  it('leaves tmdbTvId null on movie-shaped entries', () => {
    const entries = parseLetterboxdRss(SAMPLE_RSS);
    expect(entries[0].tmdbTvId).toBeNull();
    expect(entries[1].tmdbTvId).toBeNull();
  });

  it('extracts the poster URL from the description CDATA when present', () => {
    const xml = `<?xml version="1.0"?>
<rss xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org">
<channel>
  <item>
    <title>Test Movie, 2026 - ★★★</title>
    <guid>poster-test</guid>
    <letterboxd:watchedDate>2026-01-01</letterboxd:watchedDate>
    <letterboxd:filmTitle>Test Movie</letterboxd:filmTitle>
    <letterboxd:filmYear>2026</letterboxd:filmYear>
    <description><![CDATA[ <p><img src="https://a.ltrbxd.com/resized/sm/foo.jpg?v=1"/></p> <p>Some review text.</p> ]]></description>
  </item>
</channel>
</rss>`;
    const entries = parseLetterboxdRss(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0].posterUrl).toBe(
      'https://a.ltrbxd.com/resized/sm/foo.jpg?v=1'
    );
    expect(entries[0].review).toBe('Some review text.');
  });

  it('returns null posterUrl when description has no <img>', () => {
    const xml = `<?xml version="1.0"?>
<rss xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org">
<channel>
  <item>
    <title>No Poster, 2026 - ★★★</title>
    <guid>no-poster-test</guid>
    <letterboxd:watchedDate>2026-01-01</letterboxd:watchedDate>
    <letterboxd:filmTitle>No Poster</letterboxd:filmTitle>
    <letterboxd:filmYear>2026</letterboxd:filmYear>
    <description><![CDATA[ <p>Just text, no image.</p> ]]></description>
  </item>
</channel>
</rss>`;
    const entries = parseLetterboxdRss(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0].posterUrl).toBeNull();
  });

  it('extracts guid', () => {
    const entries = parseLetterboxdRss(SAMPLE_RSS);
    expect(entries[0].guid).toBe('letterboxd-watch-117795457');
  });

  it('skips non-diary items (no watched date)', () => {
    const entries = parseLetterboxdRss(SAMPLE_RSS);
    // The third item (list entry) should be excluded
    const guids = entries.map((e) => e.guid);
    expect(guids).not.toContain('letterboxd-list-123');
  });

  it('handles empty feed', () => {
    const xml = `<?xml version="1.0"?><rss><channel></channel></rss>`;
    const entries = parseLetterboxdRss(xml);
    expect(entries).toHaveLength(0);
  });

  it('handles missing optional fields', () => {
    const xml = `<?xml version="1.0"?>
<rss xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org">
<channel>
  <item>
    <title>Test Movie</title>
    <guid>test-guid</guid>
    <letterboxd:watchedDate>2026-01-01</letterboxd:watchedDate>
    <letterboxd:filmTitle>Test Movie</letterboxd:filmTitle>
  </item>
</channel>
</rss>`;
    const entries = parseLetterboxdRss(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0].filmYear).toBeNull();
    expect(entries[0].memberRating).toBeNull();
    expect(entries[0].rewatch).toBe(false);
    expect(entries[0].tmdbMovieId).toBeNull();
    expect(entries[0].tmdbTvId).toBeNull();
    expect(entries[0].posterUrl).toBeNull();
  });
});
