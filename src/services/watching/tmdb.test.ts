import { describe, it, expect } from 'vitest';
import { extractTmdbIdFromGuids, extractImdbIdFromGuids } from './tmdb.js';

describe('TMDB ID extraction', () => {
  it('extracts TMDB ID from Plex Guid array', () => {
    const guids = [
      { id: 'imdb://tt1375666' },
      { id: 'tmdb://27205' },
      { id: 'tvdb://12345' },
    ];

    expect(extractTmdbIdFromGuids(guids)).toBe(27205);
  });

  it('returns null when no TMDB ID found', () => {
    const guids = [{ id: 'imdb://tt1375666' }, { id: 'tvdb://12345' }];

    expect(extractTmdbIdFromGuids(guids)).toBeNull();
  });

  it('returns null for empty guid array', () => {
    expect(extractTmdbIdFromGuids([])).toBeNull();
  });

  it('handles malformed guid values', () => {
    const guids = [{ id: 'tmdb://' }, { id: 'tmdb://abc' }, { id: 'tmdb' }];

    expect(extractTmdbIdFromGuids(guids)).toBeNull();
  });
});

describe('IMDB ID extraction', () => {
  it('extracts IMDB ID from Plex Guid array', () => {
    const guids = [{ id: 'imdb://tt1375666' }, { id: 'tmdb://27205' }];

    expect(extractImdbIdFromGuids(guids)).toBe('tt1375666');
  });

  it('returns null when no IMDB ID found', () => {
    const guids = [{ id: 'tmdb://27205' }, { id: 'tvdb://12345' }];

    expect(extractImdbIdFromGuids(guids)).toBeNull();
  });

  it('returns null for empty guid array', () => {
    expect(extractImdbIdFromGuids([])).toBeNull();
  });
});
