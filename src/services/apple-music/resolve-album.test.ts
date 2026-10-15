import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCatalogAlbum } from './resolve-album.js';

function reply(body: unknown, status = 200) {
  return { ok: status === 200, status, json: async () => body };
}

const album = (id: string, name: string, artistName: string) => ({
  id,
  type: 'albums',
  attributes: {
    name,
    artistName,
    url: `https://music.apple.com/us/album/x/${id}`,
  },
});

const song = (
  id: string,
  name: string,
  artistName: string,
  albumName: string,
  isrc: string,
  albums: unknown[] = []
) => ({
  id,
  type: 'songs',
  attributes: { name, artistName, albumName, isrc },
  relationships: { albums: { data: albums } },
});

/**
 * A fake catalog: song searches answer by term, the songs endpoint returns
 * each listed song with its album, ISRC lookups return every holder.
 */
function catalog(options: {
  songSearch?: Record<string, ReturnType<typeof song>[]>;
  songs?: ReturnType<typeof song>[];
  albumSearch?: unknown[];
  status?: number;
}) {
  return vi.fn(async (input: string) => {
    const url = new URL(input);
    if (options.status) return reply({}, options.status);
    if (url.pathname.endsWith('/search')) {
      const term = url.searchParams.get('term') ?? '';
      return url.searchParams.get('types') === 'songs'
        ? reply({
            results: { songs: { data: options.songSearch?.[term] ?? [] } },
          })
        : reply({ results: { albums: { data: options.albumSearch ?? [] } } });
    }
    if (url.pathname.endsWith('/songs')) {
      const isrc = url.searchParams.get('filter[isrc]');
      const ids = url.searchParams.get('ids')?.split(',') ?? [];
      return reply({
        data: (options.songs ?? []).filter((s) =>
          isrc ? s.attributes.isrc === isrc : ids.includes(s.id)
        ),
      });
    }
    return reply({ errors: [] }, 404);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('resolveCatalogAlbum', () => {
  it('finds the album from the played song despite a misspelled title', async () => {
    const collide = album(
      '1440941951',
      'Collide With The Sky',
      'Pierce the Veil'
    );
    const played = song(
      '1',
      'A Match Into Water',
      'Pierce the Veil',
      'Collide With The Sky',
      'US1',
      [collide]
    );
    vi.stubGlobal(
      'fetch',
      catalog({
        songSearch: {
          'A Match In Water Pierce the Veil': [
            played,
            song('2', 'Dive In', 'Pierce the Veil', 'Misadventures', 'US2'),
          ],
        },
        songs: [played],
      })
    );
    expect(
      await resolveCatalogAlbum('token', {
        album: 'Collide With the Sky',
        track: 'A Match In Water',
        artist: 'Pierce the Veil',
      })
    ).toEqual({
      status: 'found',
      album: {
        id: 1440941951,
        name: 'Collide With The Sky',
        artistName: 'Pierce the Veil',
        url: 'https://music.apple.com/us/album/x/1440941951',
      },
    });
  });

  it('adds the album name to the search to reach a soundtrack', async () => {
    const own = album('10', 'Stealers Wheel', 'Stealers Wheel');
    const soundtrack = album(
      '1440847276',
      'Reservoir Dogs (Original Motion Picture Soundtrack)',
      'Various Artists'
    );
    const onOwn = song(
      '11',
      'Stuck In the Middle With You',
      'Stealers Wheel',
      'Stealers Wheel',
      'GB1',
      [own]
    );
    const onSoundtrack = song(
      '12',
      'Stuck in the Middle with You',
      'Stealers Wheel',
      'Reservoir Dogs (Original Motion Picture Soundtrack)',
      'GB1',
      [soundtrack]
    );
    const fetch = catalog({
      songSearch: {
        'Stuck in the Middle With You Stealers Wheel': [onOwn],
        'Stuck in the Middle With You Stealers Wheel Reservoir Dogs Original Motion Picture Soundtrack':
          [onSoundtrack, onOwn],
      },
      songs: [onOwn, onSoundtrack],
    });
    vi.stubGlobal('fetch', fetch);
    const result = await resolveCatalogAlbum('token', {
      album: 'Reservoir Dogs: Original Motion Picture Soundtrack',
      track: 'Stuck in the Middle With You',
      artist: 'Stealers Wheel',
    });
    expect(result.status === 'found' && result.album).toMatchObject({
      id: 1440847276,
      artistName: 'Various Artists',
    });
  });

  it('lists releases by ISRC when the search shows only other releases', async () => {
    const ep = album(
      '1825905541',
      'On A Clear Day, You Can See Forever - EP',
      'Catching Flies & Parra for Cuva'
    );
    const other = album('1830987684', 'Beats & Pieces II', 'Catching Flies');
    const track = 'On A Clear Day, You Can See Forever (Edit)';
    const artist = 'Catching Flies & Parra for Cuva';
    const onOther = song('21', track, artist, 'Beats & Pieces II', 'FRX1', [
      other,
    ]);
    const onEp = song(
      '22',
      track,
      artist,
      'On A Clear Day, You Can See Forever - EP',
      'FRX1',
      [ep]
    );
    vi.stubGlobal(
      'fetch',
      catalog({
        songSearch: {
          [`${track} Catching Flies and Parra for Cuva`]: [onOther],
        },
        songs: [onOther, onEp],
      })
    );
    const result = await resolveCatalogAlbum('token', {
      album: 'On A Clear Day, You Can See Forever - EP',
      track,
      artist: 'Catching Flies and Parra for Cuva',
    });
    expect(result.status === 'found' && result.album.id).toBe(1825905541);
  });

  it('decides nothing when the closest titles name different releases', async () => {
    const single = album('31', 'Hits - Single', 'Band');
    const soundtrack = album('32', 'Hits (Original Soundtrack)', 'Band');
    const a = song('33', 'Hit Song', 'Band', 'Hits - Single', 'US3', [single]);
    const b = song(
      '34',
      'Hit Song',
      'Band',
      'Hits (Original Soundtrack)',
      'US3',
      [soundtrack]
    );
    vi.stubGlobal(
      'fetch',
      catalog({ songSearch: { 'Hit Song Band': [a, b] }, songs: [a, b] })
    );
    expect(
      await resolveCatalogAlbum('token', {
        album: 'Hits',
        track: 'Hit Song',
        artist: 'Band',
      })
    ).toEqual({ status: 'no_match' });
  });

  it('prefers the edition credited to the played artist among same-named releases', async () => {
    const tribute = album('41', 'Greatest Hits', 'Various Artists');
    const own = album('42', 'Greatest Hits', 'Band');
    const a = song('43', 'Hit Song', 'Band', 'Greatest Hits', 'US4', [tribute]);
    const b = song('44', 'Hit Song', 'Band', 'Greatest Hits', 'US4', [own]);
    vi.stubGlobal(
      'fetch',
      catalog({ songSearch: { 'Hit Song Band': [a, b] }, songs: [a, b] })
    );
    const result = await resolveCatalogAlbum('token', {
      album: 'Greatest Hits',
      track: 'Hit Song',
      artist: 'Band',
    });
    expect(result.status === 'found' && result.album.id).toBe(42);
  });

  it('falls back to the album search when no song is credited to the played artist', async () => {
    const soundtrack = album('51', 'Reservoir Dogs', 'Various Artists');
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/search'))
        return url.searchParams.get('types') === 'albums'
          ? reply({ results: { albums: { data: [soundtrack] } } })
          : reply({ results: { songs: { data: [] } } });
      return reply({
        data: [
          {
            ...soundtrack,
            relationships: {
              tracks: {
                data: [
                  {
                    attributes: {
                      name: 'Madonna Speech',
                      artistName: 'Quentin Tarantino',
                    },
                  },
                ],
              },
            },
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await resolveCatalogAlbum('token', {
      album: 'Reservoir Dogs',
      track: 'Madonna Speech',
      artist: 'Mr. Brown',
    });
    expect(result.status === 'found' && result.album.id).toBe(51);
  });

  it('reports a rate limit', async () => {
    vi.stubGlobal('fetch', catalog({ status: 429 }));
    expect(
      await resolveCatalogAlbum('token', {
        album: 'X',
        track: 'Y',
        artist: 'Z',
      })
    ).toEqual({ status: 'rate_limited' });
  });
});
