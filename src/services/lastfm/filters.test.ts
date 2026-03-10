import { describe, it, expect } from 'vitest';
import {
  isHolidayMusic,
  isAudiobook,
  isFiltered,
  filterAndRerank,
} from './filters.js';

describe('isHolidayMusic', () => {
  it('detects holiday album patterns', () => {
    expect(
      isHolidayMusic({
        artistName: 'Any',
        albumName: 'A Charlie Brown Christmas',
      })
    ).toBe(true);
    expect(
      isHolidayMusic({ artistName: 'Any', albumName: 'Merry Christmas Baby' })
    ).toBe(true);
    expect(
      isHolidayMusic({ artistName: 'Any', albumName: 'Holiday Hits' })
    ).toBe(true);
  });

  it('detects holiday track patterns', () => {
    expect(
      isHolidayMusic({ artistName: 'Any', trackName: 'Jingle Bell Rock' })
    ).toBe(true);
    expect(
      isHolidayMusic({ artistName: 'Any', trackName: 'Silent Night' })
    ).toBe(true);
    expect(
      isHolidayMusic({ artistName: 'Any', trackName: 'Last Christmas' })
    ).toBe(true);
  });

  it('detects Vince Guaraldi artist-scoped tracks', () => {
    expect(
      isHolidayMusic({
        artistName: 'Vince Guaraldi Trio',
        trackName: 'skating',
      })
    ).toBe(true);
    expect(
      isHolidayMusic({
        artistName: 'Vince Guaraldi',
        trackName: 'linus and lucy',
      })
    ).toBe(true);
  });

  it('does not flag non-holiday music', () => {
    expect(
      isHolidayMusic({
        artistName: 'Radiohead',
        albumName: 'OK Computer',
        trackName: 'Paranoid Android',
      })
    ).toBe(false);
  });
});

describe('isAudiobook', () => {
  it('detects audiobook artists', () => {
    expect(isAudiobook({ artistName: 'Stephen King' })).toBe(true);
    expect(isAudiobook({ artistName: 'Andy Weir' })).toBe(true);
  });

  it('detects Libby tracks', () => {
    expect(
      isAudiobook({ artistName: 'Unknown', trackName: 'libby--open-chapter1' })
    ).toBe(true);
  });

  it('detects audiobook regex patterns', () => {
    expect(
      isAudiobook({ artistName: 'Unknown', trackName: 'Chapter 1 - Part 3' })
    ).toBe(true);
    expect(
      isAudiobook({ artistName: 'Unknown', trackName: 'Chapter - Track 12' })
    ).toBe(true);
    expect(
      isAudiobook({ artistName: 'Unknown', trackName: 'Chapter - 42' })
    ).toBe(true);
    expect(
      isAudiobook({ artistName: 'Unknown', trackName: 'Something (12)' })
    ).toBe(true);
  });

  it('does not flag regular music', () => {
    expect(
      isAudiobook({
        artistName: 'Radiohead',
        trackName: 'Paranoid Android',
      })
    ).toBe(false);
  });
});

describe('isFiltered', () => {
  it('returns true for holiday music', () => {
    expect(
      isFiltered({
        artistName: 'Any',
        albumName: 'Merry Christmas',
        trackName: 'test',
      })
    ).toBe(true);
  });

  it('returns true for audiobooks', () => {
    expect(isFiltered({ artistName: 'Stephen King' })).toBe(true);
  });

  it('returns false for regular music', () => {
    expect(
      isFiltered({
        artistName: 'Radiohead',
        albumName: 'OK Computer',
        trackName: 'Paranoid Android',
      })
    ).toBe(false);
  });
});

describe('filterAndRerank', () => {
  it('filters out items and returns requested limit', () => {
    const items = [
      { artistName: 'Radiohead', trackName: 'Creep' },
      { artistName: 'Stephen King', trackName: 'Chapter 1' },
      { artistName: 'Tool', trackName: 'Lateralus' },
      {
        artistName: 'Any',
        albumName: 'Merry Christmas',
        trackName: 'Song',
      },
      { artistName: 'Pink Floyd', trackName: 'Comfortably Numb' },
    ];

    const result = filterAndRerank(items, 3);
    expect(result).toHaveLength(3);
    expect(result[0].artistName).toBe('Radiohead');
    expect(result[1].artistName).toBe('Tool');
    expect(result[2].artistName).toBe('Pink Floyd');
  });

  it('returns fewer items if not enough pass filter', () => {
    const items = [
      { artistName: 'Stephen King', trackName: 'Chapter 1' },
      { artistName: 'Radiohead', trackName: 'Creep' },
    ];

    const result = filterAndRerank(items, 5);
    expect(result).toHaveLength(1);
    expect(result[0].artistName).toBe('Radiohead');
  });
});
