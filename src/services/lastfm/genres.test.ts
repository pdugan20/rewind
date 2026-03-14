import { describe, it, expect } from 'vitest';
import { resolveGenre, GENRE_MAP } from './genres.js';

describe('resolveGenre', () => {
  it('returns the highest-weighted allowlisted tag as primary genre', () => {
    const result = resolveGenre([
      { name: 'Grunge', count: 100 },
      { name: 'rock', count: 49 },
      { name: 'alternative rock', count: 26 },
    ]);
    expect(result.genre).toBe('Grunge');
    expect(result.normalizedTags).toEqual([
      { name: 'Grunge', count: 100 },
      { name: 'Rock', count: 49 },
      { name: 'Alternative', count: 26 },
    ]);
  });

  it('normalizes synonyms to canonical names', () => {
    const result = resolveGenre([
      { name: 'Hip-Hop', count: 100 },
      { name: 'rap', count: 50 },
      { name: 'hip hop', count: 24 },
    ]);
    // All three map to "Hip-Hop", so only one entry
    expect(result.genre).toBe('Hip-Hop');
    expect(result.normalizedTags).toEqual([{ name: 'Hip-Hop', count: 100 }]);
  });

  it('filters out junk tags not in the allowlist', () => {
    const result = resolveGenre([
      { name: 'seen live', count: 100 },
      { name: 'female vocalists', count: 80 },
      { name: 'favorites', count: 60 },
      { name: 'indie', count: 40 },
      { name: '90s', count: 20 },
    ]);
    expect(result.genre).toBe('Indie');
    expect(result.normalizedTags).toEqual([{ name: 'Indie', count: 40 }]);
  });

  it('returns null genre for empty input', () => {
    const result = resolveGenre([]);
    expect(result.genre).toBeNull();
    expect(result.normalizedTags).toEqual([]);
  });

  it('returns null genre when no tags match the allowlist', () => {
    const result = resolveGenre([
      { name: 'seen live', count: 100 },
      { name: 'under 2000 listeners', count: 50 },
      { name: 'my favorite', count: 25 },
    ]);
    expect(result.genre).toBeNull();
    expect(result.normalizedTags).toEqual([]);
  });

  it('is case-insensitive for matching', () => {
    const result = resolveGenre([
      { name: 'ROCK', count: 100 },
      { name: 'Hip-Hop', count: 80 },
    ]);
    expect(result.genre).toBe('Rock');
    expect(result.normalizedTags).toHaveLength(2);
  });

  it('deduplicates canonical names keeping highest weight', () => {
    const result = resolveGenre([
      { name: 'alternative rock', count: 90 },
      { name: 'alternative', count: 70 },
      { name: 'rock', count: 50 },
    ]);
    // Both "alternative rock" and "alternative" map to "Alternative"
    expect(result.normalizedTags[0]).toEqual({
      name: 'Alternative',
      count: 90,
    });
    expect(result.normalizedTags[1]).toEqual({ name: 'Rock', count: 50 });
    expect(result.normalizedTags).toHaveLength(2);
  });

  it('handles real-world Last.fm response for The Beatles', () => {
    const result = resolveGenre([
      { name: 'classic rock', count: 100 },
      { name: 'rock', count: 79 },
      { name: 'british', count: 45 },
      { name: '60s', count: 43 },
      { name: 'pop', count: 14 },
      { name: 'Psychedelic Rock', count: 4 },
      { name: 'psychedelic', count: 3 },
      { name: 'pop rock', count: 1 },
      { name: 'The Beatles', count: 1 },
      { name: 'british invasion', count: 1 },
    ]);
    expect(result.genre).toBe('Classic Rock');
    // "british", "60s", "The Beatles", "british invasion" filtered out
    expect(result.normalizedTags.map((t) => t.name)).toEqual([
      'Classic Rock',
      'Rock',
      'Pop',
      'Psychedelic Rock',
      'Psychedelic',
      'Pop Rock',
    ]);
  });
});

describe('GENRE_MAP', () => {
  it('contains expected core genres', () => {
    expect(GENRE_MAP['rock']).toBe('Rock');
    expect(GENRE_MAP['hip-hop']).toBe('Hip-Hop');
    expect(GENRE_MAP['electronic']).toBe('Electronic');
    expect(GENRE_MAP['jazz']).toBe('Jazz');
    expect(GENRE_MAP['country']).toBe('Country');
    expect(GENRE_MAP['folk']).toBe('Folk');
    expect(GENRE_MAP['classical']).toBe('Classical');
    expect(GENRE_MAP['metal']).toBe('Metal');
  });

  it('maps synonyms to the same canonical name', () => {
    expect(GENRE_MAP['hip-hop']).toBe(GENRE_MAP['hip hop']);
    expect(GENRE_MAP['hip-hop']).toBe(GENRE_MAP['rap']);
    expect(GENRE_MAP['alternative']).toBe(GENRE_MAP['alternative rock']);
    expect(GENRE_MAP['synthpop']).toBe(GENRE_MAP['synth-pop']);
    expect(GENRE_MAP['drum and bass']).toBe(GENRE_MAP['dnb']);
  });
});
