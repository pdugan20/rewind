import { describe, it, expect } from 'vitest';
import {
  deriveStatus,
  extractDomain,
  computeWordCount,
  transformBookmark,
} from './transforms.js';
import type { InstapaperBookmark } from './client.js';

describe('deriveStatus', () => {
  it('returns "finished" when progress >= 0.75', () => {
    expect(deriveStatus('unread', 0.75)).toBe('finished');
    expect(deriveStatus('unread', 0.9)).toBe('finished');
    expect(deriveStatus('archive', 1.0)).toBe('finished');
  });

  it('returns "reading" when progress > 0 in non-archive folder', () => {
    expect(deriveStatus('unread', 0.3)).toBe('reading');
    expect(deriveStatus('starred', 0.5)).toBe('reading');
  });

  it('returns "unread" when progress is 0 in non-archive folder', () => {
    expect(deriveStatus('unread', 0)).toBe('unread');
    expect(deriveStatus('starred', 0)).toBe('unread');
  });

  it('returns "skipped" when in archive with 0 progress', () => {
    expect(deriveStatus('archive', 0)).toBe('skipped');
  });

  it('returns "abandoned" when in archive with partial progress', () => {
    expect(deriveStatus('archive', 0.4)).toBe('abandoned');
    expect(deriveStatus('archive', 0.1)).toBe('abandoned');
  });
});

describe('extractDomain', () => {
  it('extracts domain from a normal URL', () => {
    expect(extractDomain('https://theatlantic.com/article/123')).toBe(
      'theatlantic.com'
    );
  });

  it('strips www prefix', () => {
    expect(extractDomain('https://www.wired.com/story/test')).toBe('wired.com');
  });

  it('returns null for invalid URL', () => {
    expect(extractDomain('not-a-url')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(extractDomain(null)).toBeNull();
  });

  it('handles URL with port and path (hostname excludes port)', () => {
    expect(extractDomain('https://www.example.com:8080/path')).toBe(
      'example.com'
    );
  });
});

describe('computeWordCount', () => {
  it('strips HTML tags and counts words', () => {
    const result = computeWordCount(
      '<p>Hello <strong>world</strong> this is a test</p>'
    );
    expect(result.wordCount).toBe(6);
  });

  it('returns 0 for empty HTML', () => {
    const result = computeWordCount('');
    expect(result.wordCount).toBe(0);
    expect(result.estimatedReadMin).toBe(0);
  });

  it('computes estimated read time using 238 wpm', () => {
    // 476 words should be 2 minutes
    const words = Array.from({ length: 476 }, () => 'word').join(' ');
    const result = computeWordCount(words);
    expect(result.wordCount).toBe(476);
    expect(result.estimatedReadMin).toBe(2);
  });

  it('rounds up read time', () => {
    // 239 words should ceil to 2 minutes (239/238 = 1.004...)
    const words = Array.from({ length: 239 }, () => 'word').join(' ');
    const result = computeWordCount(words);
    expect(result.estimatedReadMin).toBe(2);
  });

  it('collapses whitespace from HTML', () => {
    const result = computeWordCount(
      '<div>   one   </div>  <span>  two   </span>'
    );
    expect(result.wordCount).toBe(2);
  });
});

describe('transformBookmark', () => {
  const bookmark: InstapaperBookmark = {
    type: 'bookmark',
    bookmark_id: 12345,
    url: 'https://www.theatlantic.com/technology/archive/2025/01/test-article/123456/',
    title: 'Test Article Title',
    description: 'A brief description of the article.',
    time: 1704067200, // 2024-01-01T00:00:00Z
    starred: '1',
    private_source: '',
    hash: 'abc123',
    progress: 0.85,
    progress_timestamp: 1704153600, // 2024-01-02T00:00:00Z
    tags: [
      { id: 1, name: 'technology' },
      { id: 2, name: 'longread' },
    ],
  };

  it('transforms a full bookmark with all fields', () => {
    const result = transformBookmark(bookmark, 'unread');

    expect(result.itemType).toBe('article');
    expect(result.source).toBe('instapaper');
    expect(result.sourceId).toBe('12345');
    expect(result.url).toBe(bookmark.url);
    expect(result.title).toBe('Test Article Title');
    expect(result.description).toBe('A brief description of the article.');
    expect(result.domain).toBe('theatlantic.com');
    expect(result.status).toBe('finished');
    expect(result.progress).toBe(0.85);
    expect(result.starred).toBe(1);
    expect(result.folder).toBe('unread');
    expect(result.tags).toBe(JSON.stringify(['technology', 'longread']));
    expect(result.savedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(result.progressUpdatedAt).toBe('2024-01-02T00:00:00.000Z');
    expect(result.finishedAt).toBe('2024-01-02T00:00:00.000Z');
    expect(result.startedAt).toBe('2024-01-02T00:00:00.000Z');
  });

  it('handles bookmark with no tags', () => {
    const noTags: InstapaperBookmark = {
      ...bookmark,
      tags: [],
    };
    const result = transformBookmark(noTags, 'unread');
    expect(result.tags).toBeNull();
  });

  it('handles bookmark with zero progress_timestamp', () => {
    const noProgress: InstapaperBookmark = {
      ...bookmark,
      progress: 0,
      progress_timestamp: 0,
      starred: '0',
    };
    const result = transformBookmark(noProgress, 'unread');
    expect(result.progressUpdatedAt).toBeNull();
    expect(result.startedAt).toBeNull();
    expect(result.finishedAt).toBeNull();
    expect(result.starred).toBe(0);
    expect(result.status).toBe('unread');
  });

  it('sets title to "Untitled" when empty', () => {
    const noTitle: InstapaperBookmark = {
      ...bookmark,
      title: '',
    };
    const result = transformBookmark(noTitle, 'archive');
    expect(result.title).toBe('Untitled');
  });

  it('uses savedAt as finishedAt when progressUpdatedAt is null', () => {
    const finished: InstapaperBookmark = {
      ...bookmark,
      progress: 0.9,
      progress_timestamp: 0,
    };
    const result = transformBookmark(finished, 'archive');
    expect(result.status).toBe('finished');
    expect(result.finishedAt).toBe(result.savedAt);
  });
});
