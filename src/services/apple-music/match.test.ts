import { describe, expect, it } from 'vitest';
import {
  releaseMatchRank,
  albumSongMatches,
  recordingCreditsMatch,
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

describe('recording metadata variants', () => {
  it.each([
    ['Horizon', 'Horizon (feat. Guest Artist)', true],
    ['Horizon ft. Guest Artist', 'Horizon', true],
    ['Horizon (feat. Guest A)', 'Horizon (feat. Guest B)', false],
    ['Horizon (Remix)', 'Horizon', false],
    ['Horizon (Instrumental)', 'Horizon', false],
    ['Horizon 2', 'Horizon', false],
  ])(
    'compares %s with %s without losing recording identity',
    (a, b, expected) => {
      expect(songTitleMatches(a, b)).toBe(expected);
    }
  );
  it.each([
    ['Concert Session (Live)', 'Horizon', 'Horizon (Live at the Hall)', true],
    ['MTV Unplugged', 'Horizon', 'Horizon (Live MTV Unplugged)', true],
    ['Studio Session', 'Horizon', 'Horizon (Live at the Hall)', false],
    ['Live Through This', 'Horizon', 'Horizon (Live)', false],
    [
      'Concert Session (Live)',
      'Horizon (Live at Venue A)',
      'Horizon (Live at Venue B)',
      false,
    ],
    ['Concert Session (Live)', 'Horizon', 'Horizon (Live Remix)', false],
    ['Concert Session (Live)', 'Horizon (Remix)', 'Horizon (Live)', false],
  ])(
    'uses verified album context %s for track confirmation',
    (album, a, b, expected) => {
      expect(albumSongMatches(a, b, album)).toBe(expected);
    }
  );
  it.each([
    ['Ada and Ben Vale', 'Ada Vale & Ben Vale', true],
    ['Ada and Ben Vale', 'Ada Smith & Ben Vale', false],
    ['Ensemble A', 'Ensemble A & Ensemble B', true],
    ['Ensemble A & Ensemble B', 'Ensemble A', false],
    ['Unknown', 'Known Artist', false],
  ])('checks complete recording credit participants', (a, b, expected) => {
    expect(recordingCreditsMatch(a, b)).toBe(expected);
  });
});

it.each(['Live', 'Remix', 'Instrumental'])(
  'retains a %s qualifier after an inline featured credit',
  (qualifier) => {
    expect(
      songTitleMatches(
        `Distant Horizon feat. Guest (${qualifier})`,
        'Distant Horizon'
      )
    ).toBe(false);
    expect(
      songTitleMatches(
        `Distant Horizon feat. Guest - ${qualifier}`,
        'Distant Horizon'
      )
    ).toBe(false);
    expect(
      songTitleMatches(
        `Distant Horizon (feat. Guest) (${qualifier})`,
        `Distant Horizon (${qualifier})`
      )
    ).toBe(true);
  }
);

it('compares live performance qualifiers after removing a trailing feature credit', () => {
  expect(
    songTitleMatches(
      'Distant Horizon (Live at Venue A) feat. Guest',
      'Distant Horizon (Live at Venue B)'
    )
  ).toBe(false);
  expect(
    songTitleMatches(
      'Distant Horizon (Live at Venue A) feat. Guest',
      'Distant Horizon (Live at Venue A)'
    )
  ).toBe(true);
});
