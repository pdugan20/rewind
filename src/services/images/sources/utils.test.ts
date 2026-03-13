import { describe, it, expect } from 'vitest';
import { cleanArtistName, artistMatches, albumMatches } from './utils.js';

describe('cleanArtistName', () => {
  it('strips feat. suffix', () => {
    expect(cleanArtistName('Gorillaz feat. IDLES')).toBe('Gorillaz');
  });

  it('strips ft. suffix', () => {
    expect(cleanArtistName('Kendrick Lamar ft. SZA')).toBe('Kendrick Lamar');
  });

  it('strips featuring suffix', () => {
    expect(cleanArtistName('Drake featuring Future')).toBe('Drake');
  });

  it('preserves names without featured artists', () => {
    expect(cleanArtistName('The Black Keys')).toBe('The Black Keys');
  });

  it('preserves ampersand in names', () => {
    expect(cleanArtistName('Simon & Garfunkel')).toBe('Simon & Garfunkel');
  });
});

describe('artistMatches', () => {
  it('matches exact names', () => {
    expect(artistMatches('Gorillaz', 'Gorillaz')).toBe(true);
  });

  it('matches case-insensitive', () => {
    expect(artistMatches('the black keys', 'The Black Keys')).toBe(true);
  });

  it('matches when returned contains requested', () => {
    expect(artistMatches('Gorillaz', 'Gorillaz feat. IDLES')).toBe(true);
  });

  it('matches when requested contains returned', () => {
    expect(artistMatches('The Black Keys', 'Black Keys')).toBe(true);
  });

  it('rejects completely different artists', () => {
    expect(artistMatches('Gorillaz', 'The Countdown Kids')).toBe(false);
  });

  it('rejects partial word matches', () => {
    expect(artistMatches('Zero 7', 'Imagine Dragons')).toBe(false);
  });

  it('strips feat before comparing', () => {
    expect(artistMatches('Gorillaz feat. Popcaan', 'Gorillaz')).toBe(true);
  });
});

describe('albumMatches', () => {
  it('matches exact names', () => {
    expect(albumMatches('Blue', 'Blue')).toBe(true);
  });

  it('matches deluxe variants', () => {
    expect(albumMatches('GUTS', 'GUTS (Deluxe)')).toBe(true);
  });

  it('matches when returned is superset', () => {
    expect(albumMatches('The Mountain', 'The Mountain (Deluxe Edition)')).toBe(
      true
    );
  });

  it('rejects completely different albums', () => {
    expect(albumMatches('The Mountain', '30 Toddler Songs, Vol. 2')).toBe(
      false
    );
  });

  it('rejects wrong album same word', () => {
    expect(albumMatches('The Misfits', 'Famous Monsters')).toBe(false);
  });
});
