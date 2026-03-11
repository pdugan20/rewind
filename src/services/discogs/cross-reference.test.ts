import { describe, it, expect } from 'vitest';
import {
  normalizeName,
  levenshteinDistance,
  findMatch,
  type LastfmAlbumRow,
} from './cross-reference.js';

describe('normalizeName', () => {
  it('should lowercase and trim', () => {
    expect(normalizeName('  Hello World  ')).toBe('hello world');
  });

  it('should remove leading "The "', () => {
    expect(normalizeName('The Beatles')).toBe('beatles');
  });

  it('should remove parenthetical suffixes', () => {
    expect(normalizeName('OK Computer (Reissue)')).toBe('ok computer');
    expect(normalizeName('Album (Deluxe Edition)')).toBe('album');
  });

  it('should handle multiple normalizations', () => {
    expect(normalizeName('  The Album Name (Remastered)  ')).toBe('album name');
  });

  it('should collapse multiple spaces', () => {
    expect(normalizeName('Hello   World')).toBe('hello world');
  });
});

describe('levenshteinDistance', () => {
  it('should return 0 for identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('should return string length for empty string comparison', () => {
    expect(levenshteinDistance('hello', '')).toBe(5);
    expect(levenshteinDistance('', 'hello')).toBe(5);
  });

  it('should compute correct distance', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinDistance('saturday', 'sunday')).toBe(3);
  });

  it('should return 1 for single character difference', () => {
    expect(levenshteinDistance('cat', 'bat')).toBe(1);
  });
});

describe('findMatch', () => {
  const lastfmAlbums: LastfmAlbumRow[] = [
    {
      name: 'OK Computer',
      artistName: 'Radiohead',
      playcount: 150,
      lastPlayed: '2024-01-15T10:00:00Z',
    },
    {
      name: 'Kid A',
      artistName: 'Radiohead',
      playcount: 100,
      lastPlayed: '2024-02-01T10:00:00Z',
    },
    {
      name: 'Abbey Road',
      artistName: 'The Beatles',
      playcount: 200,
      lastPlayed: '2024-03-01T10:00:00Z',
    },
    {
      name: 'Nevermind',
      artistName: 'Nirvana',
      playcount: 80,
      lastPlayed: '2024-01-20T10:00:00Z',
    },
  ];

  it('should find exact match', () => {
    const result = findMatch('OK Computer', ['Radiohead'], lastfmAlbums);
    expect(result.matchType).toBe('exact');
    expect(result.matchConfidence).toBe(1.0);
    expect(result.playCount).toBe(150);
    expect(result.lastfmAlbumName).toBe('OK Computer');
  });

  it('should find exact match with normalization (The removal)', () => {
    const result = findMatch('Abbey Road', ['The Beatles'], lastfmAlbums);
    expect(result.matchType).toBe('exact');
    expect(result.matchConfidence).toBe(1.0);
    expect(result.playCount).toBe(200);
  });

  it('should find exact match with parenthetical suffix', () => {
    const result = findMatch(
      'OK Computer (Reissue)',
      ['Radiohead'],
      lastfmAlbums
    );
    expect(result.matchType).toBe('exact');
    expect(result.matchConfidence).toBe(1.0);
  });

  it('should find fuzzy match', () => {
    const result = findMatch('OK Computr', ['Radiohead'], lastfmAlbums);
    expect(result.matchType).toBe('fuzzy');
    expect(result.matchConfidence).toBeGreaterThanOrEqual(0.7);
    expect(result.playCount).toBe(150);
  });

  it('should fall back to artist-only match', () => {
    const result = findMatch('Amnesiac', ['Radiohead'], lastfmAlbums);
    expect(result.matchType).toBe('artist_only');
    expect(result.matchConfidence).toBe(0.5);
    // Should aggregate play counts across all Radiohead albums
    expect(result.playCount).toBe(250); // 150 + 100
  });

  it('should return no match for unknown artist and album', () => {
    const result = findMatch('Unknown Album', ['Unknown Artist'], lastfmAlbums);
    expect(result.matchType).toBe('none');
    expect(result.matchConfidence).toBe(0);
    expect(result.playCount).toBe(0);
  });

  it('should handle multiple artists on a release', () => {
    const result = findMatch(
      'Nevermind',
      ['Some Artist', 'Nirvana'],
      lastfmAlbums
    );
    expect(result.matchType).toBe('exact');
    expect(result.playCount).toBe(80);
  });
});
