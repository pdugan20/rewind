import { describe, it, expect } from 'vitest';
import { normalizeForSearch } from './search-normalize.js';

describe('normalizeForSearch', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(normalizeForSearch(null)).toBe('');
    expect(normalizeForSearch(undefined)).toBe('');
    expect(normalizeForSearch('')).toBe('');
  });

  it('lowercases', () => {
    expect(normalizeForSearch('HELLO World')).toBe('hello world');
  });

  it('collapses dotted acronyms (S.N.L. -> snl)', () => {
    expect(normalizeForSearch('S.N.L.')).toBe('snl');
    expect(normalizeForSearch('U.S.A.')).toBe('usa');
    expect(normalizeForSearch('A.I.')).toBe('ai');
  });

  it('collapses the NYT-style title from the motivating query', () => {
    const input = "The Secret Weapon of 'S.N.L.' Finally Gets the Spotlight";
    // smart quotes would come from real NYT; the straight-quote ASCII form
    // here exercises only the acronym and lowercase rules
    expect(normalizeForSearch(input)).toBe(
      "the secret weapon of 'snl' finally gets the spotlight"
    );
  });

  it('collapses acronyms inside longer text', () => {
    expect(normalizeForSearch('What the F.B.I. knew about A.I.')).toBe(
      'what the fbi knew about ai'
    );
  });

  it('does NOT collapse normal sentence periods', () => {
    // Single trailing period, single embedded period, decimal-style
    expect(normalizeForSearch('Hello world.')).toBe('hello world.');
    expect(normalizeForSearch('version 1.2.3')).toBe('version 1.2.3');
    expect(normalizeForSearch('foo.bar.baz')).toBe('foo.bar.baz');
  });

  it('strips smart quotes', () => {
    expect(normalizeForSearch('“hello” and ‘world’')).toBe('hello and world');
  });

  it('collapses multiple whitespace and trims', () => {
    expect(normalizeForSearch('  hello   world  ')).toBe('hello world');
    expect(normalizeForSearch('line1\n\nline2')).toBe('line1 line2');
  });

  it('applies NFKC normalization', () => {
    // ﬁ ligature -> fi
    expect(normalizeForSearch('ﬁle')).toBe('file');
  });

  it('handles mixed: smart-quoted acronym with leading/trailing space', () => {
    expect(normalizeForSearch('  “S.N.L.” writer  ')).toBe('snl writer');
  });

  it('preserves non-acronym periods inside mixed text', () => {
    expect(normalizeForSearch('The S.N.L. episode aired. It was great.')).toBe(
      'the snl episode aired. it was great.'
    );
  });
});
