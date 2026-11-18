import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppleMusicClient } from './apple-music.js';
import { DeezerClient } from './deezer.js';
import { ITunesClient } from './itunes.js';
import { albumMatches } from './utils.js';

// A prefix match once attached Led Zeppelin II's Deezer cover to the debut.
// Search rank and a matching artist must never erase a numbered album title.
const params = {
  domain: 'listening',
  entityType: 'albums',
  entityId: 'test-album',
  artistName: 'Led Zeppelin',
  albumName: 'Led Zeppelin',
};

const providers = [
  {
    name: 'Deezer',
    client: () => new DeezerClient(),
    response: (titles: string[]) => ({
      data: titles.map((title, index) => ({
        title,
        artist: { name: params.artistName },
        cover_xl: `https://example.com/cover-${index}/1000x1000.jpg`,
      })),
    }),
  },
  {
    name: 'Apple Music',
    client: () => new AppleMusicClient('test-token'),
    response: (titles: string[]) => ({
      results: {
        albums: {
          data: titles.map((name, index) => ({
            attributes: {
              name,
              artistName: params.artistName,
              artwork: {
                url: `https://example.com/cover-${index}/{w}x{h}.jpg`,
              },
            },
          })),
        },
      },
    }),
  },
  {
    name: 'iTunes',
    client: () => new ITunesClient(),
    response: (titles: string[]) => ({
      resultCount: titles.length,
      results: titles.map((collectionName, index) => ({
        collectionName,
        artistName: params.artistName,
        artworkUrl100: `https://example.com/cover-${index}/100x100bb.jpg`,
      })),
    }),
  },
];

afterEach(() => vi.unstubAllGlobals());

describe('numbered album artwork identity', () => {
  it.each(['II', 'III', 'IV'])('keeps the debut separate from %s', (number) => {
    const numbered = `Led Zeppelin ${number}`;
    expect(albumMatches(params.albumName, numbered, params.artistName)).toBe(
      false
    );
    expect(albumMatches(numbered, params.albumName, params.artistName)).toBe(
      false
    );
    expect(
      albumMatches(numbered, `${numbered} (Remastered)`, params.artistName)
    ).toBe(true);
  });

  describe.each(providers)('$name', ({ client, response }) => {
    it('leaves the album unmatched when only a numbered release is returned', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => response(['Led Zeppelin II (Remastered)']),
        })
      );

      expect(await client().search(params)).toEqual([]);
    });

    it('skips a higher-ranked numbered release and selects the debut', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () =>
            response([
              'Led Zeppelin II (Remastered)',
              'Led Zeppelin (Remastered)',
            ]),
        })
      );

      const results = await client().search(params);
      expect(results).toHaveLength(1);
      expect(results[0].url).toContain('/cover-1/');
    });
  });
});
