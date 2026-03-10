import { describe, it, expect } from 'vitest';
import { normalizeScrobble, normalizeScrobbles } from './transforms.js';
import type { LastfmRecentTrack } from './client.js';

function makeTrack(overrides?: Partial<LastfmRecentTrack>): LastfmRecentTrack {
  return {
    artist: { mbid: 'artist-mbid', '#text': 'Radiohead' },
    name: 'Paranoid Android',
    mbid: 'track-mbid',
    album: { mbid: 'album-mbid', '#text': 'OK Computer' },
    url: 'https://last.fm/track',
    date: { uts: '1700000000', '#text': '14 Nov 2023, 22:13' },
    image: [],
    ...overrides,
  };
}

describe('normalizeScrobble', () => {
  it('normalizes a standard scrobble', () => {
    const result = normalizeScrobble(makeTrack());
    expect(result.artistName).toBe('Radiohead');
    expect(result.artistMbid).toBe('artist-mbid');
    expect(result.albumName).toBe('OK Computer');
    expect(result.trackName).toBe('Paranoid Android');
    expect(result.isNowPlaying).toBe(false);
    expect(result.scrobbledAt).toBeTruthy();
  });

  it('detects now playing tracks', () => {
    const result = normalizeScrobble(
      makeTrack({
        '@attr': { nowplaying: 'true' },
        date: undefined,
      })
    );
    expect(result.isNowPlaying).toBe(true);
    expect(result.scrobbledAt).toBeNull();
  });

  it('handles empty mbid', () => {
    const result = normalizeScrobble(
      makeTrack({
        artist: { mbid: '', '#text': 'Test' },
        mbid: '',
        album: { mbid: '', '#text': 'Album' },
      })
    );
    expect(result.artistMbid).toBeNull();
    expect(result.trackMbid).toBeNull();
    expect(result.albumMbid).toBeNull();
  });
});

describe('normalizeScrobbles', () => {
  it('normalizes an array of tracks', () => {
    const results = normalizeScrobbles([makeTrack(), makeTrack()]);
    expect(results).toHaveLength(2);
  });
});
