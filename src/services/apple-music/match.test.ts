import { describe, expect, it } from 'vitest';
import {
  releaseMatchRank,
  releaseTitleMatches,
  songTitleMatches,
} from './match.js';

describe('songTitleMatches', () => {
  it('accepts a small spelling difference in a long title', () => {
    expect(songTitleMatches('A Match In Water', 'A Match Into Water')).toBe(
      true
    );
  });

  it('keeps exact matching for short titles', () => {
    expect(songTitleMatches('Diving', 'Driving')).toBe(false);
    expect(songTitleMatches('EKG', 'EKG')).toBe(true);
  });

  it('never matches across numbers or recording variants', () => {
    expect(songTitleMatches('Symphony No. 5', 'Symphony No. 6')).toBe(false);
    expect(
      songTitleMatches('Random Name Generator', 'Random Name Generator (Live)')
    ).toBe(false);
    expect(
      songTitleMatches('another good start', 'another good start (edit)')
    ).toBe(false);
  });

  it('rejects titles that differ by more than a couple of letters', () => {
    expect(songTitleMatches('Taste the Ceiling', 'Taste the Sunlight')).toBe(
      false
    );
  });
});

describe('releaseTitleMatches', () => {
  it('drops a store format suffix on either side', () => {
    expect(
      releaseTitleMatches('Sisteron', 'Sisteron - Single', 'Kiasmos')
    ).toBe(true);
    expect(
      releaseTitleMatches('Sisteron - Single', 'Sisteron', 'Kiasmos')
    ).toBe(true);
  });

  it('drops a soundtrack descriptor but keeps the title before it', () => {
    expect(
      releaseTitleMatches(
        'Reservoir Dogs',
        'Reservoir Dogs (Original Motion Picture Soundtrack)',
        'Stealers Wheel'
      )
    ).toBe(true);
    expect(
      releaseTitleMatches(
        'Star Wars',
        'Star Wars: A New Hope (Original Motion Picture Score)',
        'Wilco'
      )
    ).toBe(false);
  });

  it('still separates different releases', () => {
    expect(
      releaseTitleMatches('Pinkerton', 'Weezer (Blue Album)', 'Weezer')
    ).toBe(false);
    expect(
      releaseTitleMatches(
        'Midnights',
        'Midnights (3am Edition)',
        'Taylor Swift'
      )
    ).toBe(true);
  });
});

describe('releaseMatchRank', () => {
  it('ranks an exact title above an edition above a format difference', () => {
    expect(releaseMatchRank('Star Wars', 'Star Wars', 'Wilco')).toBe(3);
    expect(
      releaseMatchRank('Midnights', 'Midnights (3am Edition)', 'Taylor Swift')
    ).toBe(2);
    expect(releaseMatchRank('Sisteron', 'Sisteron - Single', 'Kiasmos')).toBe(
      1
    );
    expect(releaseMatchRank('Star Wars', 'Sun Sun Sun', 'Wilco')).toBe(0);
  });
});
