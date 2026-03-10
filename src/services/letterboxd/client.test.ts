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
</channel>
</rss>`;

describe('parseLetterboxdRss', () => {
  it('parses diary entries from RSS feed', () => {
    const entries = parseLetterboxdRss(SAMPLE_RSS);
    expect(entries).toHaveLength(2);
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
  });
});
