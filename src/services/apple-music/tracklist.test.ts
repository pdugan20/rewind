import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import {
  lastfmAlbumTracks,
  lastfmAlbums,
  lastfmArtists,
  lastfmTracks,
} from '../../db/schema/lastfm.js';
import { setupTestDb } from '../../test-helpers.js';
import {
  fetchAlbumTracklist,
  syncAlbumTracklists,
  tracklistTitleMatches,
} from './tracklist.js';

const PREVIEW =
  'https://audio-ssl.itunes.apple.com/itunes-assets/a.plus.aac.p.m4a';

function song(id: number, trackNumber: number, extra: object = {}) {
  return {
    id: String(id),
    type: 'songs',
    attributes: {
      name: `Song ${trackNumber}`,
      artistName: 'Synthetic',
      discNumber: 1,
      trackNumber,
      durationInMillis: 180000,
      isrc: `USX${id}`,
      url: `https://music.apple.com/us/song/${id}`,
      previews: [{ url: PREVIEW }],
      ...extra,
    },
  };
}

function albumBody(
  tracks: unknown[],
  next?: string,
  attributes = { name: 'Synthetic', artistName: 'Synthetic' }
) {
  return {
    data: [
      {
        id: '101',
        type: 'albums',
        attributes,
        relationships: { tracks: { data: tracks, ...(next ? { next } : {}) } },
      },
    ],
  };
}

function reply(body: unknown, status = 200) {
  return { ok: status === 200, status, json: async () => body };
}

describe('fetchAlbumTracklist', () => {
  afterEach(() => vi.unstubAllGlobals());
  const expected = { name: 'Synthetic', artistName: 'Synthetic' };

  it('returns songs in disc/track order and drops videos and bad rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          reply(
            albumBody([
              song(3, 1, { discNumber: 2 }),
              song(2, 2),
              { id: '9', type: 'music-videos', attributes: { name: 'Video' } },
              song(1, 1),
              song(4, 0),
              song(5, 2, { previews: [{ url: 'https://evil.example/a.m4a' }] }),
            ])
          )
        )
    );
    const result = await fetchAlbumTracklist('token', 101, expected);
    expect(result.status).toBe('matched');
    if (result.status !== 'matched') return;
    expect(
      result.tracks.map((t) => [t.discNumber, t.trackNumber, t.appleMusicId])
    ).toEqual([
      [1, 1, 1],
      [1, 2, 2],
      [2, 1, 3],
    ]);
    expect(result.tracks[0]).toMatchObject({
      durationMs: 180000,
      isrc: 'USX1',
      previewUrl: PREVIEW,
      appleMusicUrl: 'https://music.apple.com/us/song/1',
    });
  });

  it('follows API-origin pagination only', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reply(
          albumBody([song(1, 1)], '/v1/catalog/us/albums/101/tracks?offset=1')
        )
      )
      .mockResolvedValueOnce(
        reply({ data: [song(2, 2)], next: 'https://evil.example/v1/more' })
      );
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchAlbumTracklist('token', 101, expected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.music.apple.com/v1/catalog/us/albums/101/tracks?offset=1'
    );
    expect(result.status === 'matched' && result.tracks.length).toBe(2);
  });

  it('rejects a different album or artist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        reply(
          albumBody([song(1, 1)], undefined, {
            name: 'Synthetic',
            artistName: 'Someone Else',
          })
        )
      )
    );
    expect((await fetchAlbumTracklist('token', 101, expected)).status).toBe(
      'no_match'
    );
  });

  it('separates removed albums from transient failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({}, 404)));
    expect((await fetchAlbumTracklist('token', 101, expected)).status).toBe(
      'no_match'
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({}, 401)));
    expect((await fetchAlbumTracklist('token', 101, expected)).status).toBe(
      'error'
    );
  });
});

describe('syncAlbumTracklists', () => {
  let db: Database;
  beforeAll(setupTestDb);
  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(lastfmAlbumTracks);
    await db.delete(lastfmAlbums);
    await db.delete(lastfmArtists);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function seed() {
    const [artist] = await db
      .insert(lastfmArtists)
      .values({ name: 'Synthetic' })
      .returning();
    const [album] = await db
      .insert(lastfmAlbums)
      .values({ name: 'Synthetic', artistId: artist.id, appleMusicId: 101 })
      .returning();
    return album;
  }

  it('replaces the stored set and stamps the album', async () => {
    const album = await seed();
    await db.insert(lastfmAlbumTracks).values({
      albumId: album.id,
      appleMusicId: 99,
      trackNumber: 7,
      name: 'Stale',
      syncedAt: '2020-01-01T00:00:00.000Z',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(reply(albumBody([song(1, 1), song(2, 2)])))
    );
    expect(await syncAlbumTracklists(db, 'token', [album.id])).toEqual({
      stored: 1,
      skipped: 0,
    });
    const rows = await db
      .select()
      .from(lastfmAlbumTracks)
      .where(eq(lastfmAlbumTracks.albumId, album.id));
    expect(rows.map((r) => r.name).sort()).toEqual(['Song 1', 'Song 2']);
    const [stamped] = await db
      .select()
      .from(lastfmAlbums)
      .where(eq(lastfmAlbums.id, album.id));
    expect(stamped.tracklistSyncedAt).toBeTruthy();

    // A fresh stamp skips the catalog until it is 90 days old.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await syncAlbumTracklists(db, 'token', [album.id]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps stored rows and retries later after a transient failure', async () => {
    const album = await seed();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({}, 503)));
    expect(await syncAlbumTracklists(db, 'token', [album.id])).toEqual({
      stored: 0,
      skipped: 1,
    });
    const [row] = await db
      .select()
      .from(lastfmAlbums)
      .where(eq(lastfmAlbums.id, album.id));
    expect(row.tracklistSyncedAt).toBeNull();
  });

  it('stores a long tracklist across several multi-row inserts', async () => {
    const album = await seed();
    const songs = Array.from({ length: 21 }, (_, i) => song(i + 1, i + 1));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(albumBody(songs))));
    expect(await syncAlbumTracklists(db, 'token', [album.id])).toEqual({
      stored: 1,
      skipped: 0,
    });
    const rows = await db
      .select()
      .from(lastfmAlbumTracks)
      .where(eq(lastfmAlbumTracks.albumId, album.id));
    expect(rows.map((r) => r.trackNumber).sort((a, b) => a - b)).toEqual(
      songs.map((_, i) => i + 1)
    );
  });

  it('stops the batch when Apple Music throttles', async () => {
    const first = await seed();
    const [second] = await db
      .insert(lastfmAlbums)
      .values({
        name: 'Other',
        artistId: first.artistId,
        appleMusicId: 102,
      })
      .returning();
    const fetchMock = vi.fn().mockResolvedValue(reply({}, 429));
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await syncAlbumTracklists(db, 'token', [first.id, second.id])
    ).toEqual({ stored: 0, skipped: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('tracklist title identity', () => {
  it.each([
    ['Midnights', 'Midnights (3am Edition)'],
    ['Midnights', 'Midnights (The Til Dawn Edition)'],
    [
      'From the Muddy Banks of the Wishkah',
      'From the Muddy Banks of the Wishkah (Live)',
    ],
    ['Pinkerton', 'Pinkerton (Deluxe Edition) [Remastered]'],
    ['Nevermind', 'Nevermind (20th Anniversary Super Deluxe Edition)'],
    ['Abbey Road', 'Abbey Road (Remastered 2019)'],
    ['Pinkerton', 'Pinkerton'],
  ])('accepts %s as catalog %s', (stored, catalog) => {
    expect(tracklistTitleMatches(stored, catalog, 'Artist')).toBe(true);
  });
  it.each([
    ['Star Wars', 'Alpha Mike Foxtrot: Rare Tracks 1994-2014'],
    ['Midnights (3am Edition)', 'Midnights'],
    ['Midnights', 'Midnights - Single'],
    ['Midnights', 'Midnights (Remixes)'],
    ['Midnights', 'Midnights Live (Edition)'],
    ['Midnights', 'Midnights (Instrumental Version)'],
    ['Midnights', 'Midnights (Remix Edition)'],
    ['Fearless', "Fearless (Taylor's Version)"],
    ['Wishkah', 'Wishkah (Live at Wembley)'],
  ])('rejects %s as catalog %s', (stored, catalog) => {
    expect(tracklistTitleMatches(stored, catalog, 'Artist')).toBe(false);
  });
  it('stores the catalog edition a played album points to', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        reply(
          albumBody([song(1, 1), song(2, 2)], undefined, {
            name: 'Synthetic (3am Edition)',
            artistName: 'Synthetic',
          })
        )
      )
    );
    const result = await fetchAlbumTracklist('token', 101, {
      name: 'Synthetic',
      artistName: 'Synthetic',
    });
    expect(result.status === 'matched' && result.tracks.length).toBe(2);
    vi.unstubAllGlobals();
  });
});

describe('recovering a stored catalog id that names another release', () => {
  let db: Database;
  beforeAll(setupTestDb);
  beforeEach(async () => {
    db = createDb(env.DB);
    await env.DB.exec(
      'DELETE FROM lastfm_album_tracks; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists;'
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  // Wilco's "Star Wars" was stored with the id of the "Alpha Mike Foxtrot" box.
  async function seed() {
    const [artist] = await db
      .insert(lastfmArtists)
      .values({ name: 'Wilco' })
      .returning();
    const [album] = await db
      .insert(lastfmAlbums)
      .values({ name: 'Star Wars', artistId: artist.id, appleMusicId: 111 })
      .returning();
    await db.insert(lastfmTracks).values({
      name: 'Random Name Generator',
      artistId: artist.id,
      albumId: album.id,
    });
    return album;
  }
  const wilco = (id: number, n: number, name: string) =>
    song(id, n, { name, artistName: 'Wilco' });
  const catalog = (search: unknown, searchStatus = 200) =>
    vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/search')) return reply(search, searchStatus);
      if (url.pathname.endsWith('/albums/111'))
        return reply({
          data: [
            {
              id: '111',
              type: 'albums',
              attributes: {
                name: 'Alpha Mike Foxtrot: Rare Tracks 1994-2014',
                artistName: 'Wilco',
              },
              relationships: { tracks: { data: [wilco(1, 1, 'Promising')] } },
            },
          ],
        });
      return reply({
        data: [
          {
            id: '222',
            type: 'albums',
            attributes: {
              name: 'Star Wars',
              artistName: 'Wilco',
              url: 'https://music.apple.com/us/album/star-wars/222',
            },
            relationships: {
              tracks: {
                data: [
                  wilco(2, 1, 'EKG'),
                  wilco(3, 2, 'More...'),
                  wilco(4, 3, 'Random Name Generator'),
                ],
              },
            },
          },
        ],
      });
    });
  const found = {
    results: {
      albums: {
        data: [
          {
            id: '222',
            type: 'albums',
            attributes: { name: 'Star Wars', artistName: 'Wilco' },
          },
        ],
      },
    },
  };

  it('stores the matching catalog album and its tracklist', async () => {
    const album = await seed();
    vi.stubGlobal('fetch', catalog(found));
    expect(await syncAlbumTracklists(db, 'token', [album.id])).toEqual({
      stored: 1,
      skipped: 0,
    });
    const [row] = await db
      .select()
      .from(lastfmAlbums)
      .where(eq(lastfmAlbums.id, album.id));
    expect(row).toMatchObject({
      appleMusicId: 222,
      appleMusicUrl: 'https://music.apple.com/us/album/star-wars/222',
    });
    expect(row.tracklistSyncedAt).toBeTruthy();
    const tracks = await db
      .select()
      .from(lastfmAlbumTracks)
      .where(eq(lastfmAlbumTracks.albumId, album.id));
    expect(tracks.map((t) => t.name).sort()).toEqual([
      'EKG',
      'More...',
      'Random Name Generator',
    ]);
  });

  it('adds the artist to the search when the album name alone is crowded out', async () => {
    const album = await seed();
    // The live search for "Star Wars" returns only John Williams scores.
    const score = (id: string) => ({
      id,
      type: 'albums',
      attributes: {
        name: 'Star Wars: A New Hope (Original Motion Picture Score)',
        artistName: 'John Williams',
        url: `https://music.apple.com/us/album/x/${id}`,
      },
    });
    const base = catalog(found);
    const crowded = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/search'))
        return url.searchParams.get('term') === 'Star Wars Wilco'
          ? reply(found)
          : reply({
              results: { albums: { data: [score('501'), score('502')] } },
            });
      const id = url.pathname.split('/').pop();
      if (id === '501' || id === '502')
        return reply({
          data: [
            {
              ...score(id),
              relationships: {
                tracks: {
                  data: [
                    song(7, 1, {
                      name: 'Main Title',
                      artistName: 'John Williams',
                    }),
                  ],
                },
              },
            },
          ],
        });
      return base(input);
    });
    vi.stubGlobal('fetch', crowded);
    expect(await syncAlbumTracklists(db, 'token', [album.id])).toEqual({
      stored: 1,
      skipped: 0,
    });
    const [row] = await db
      .select()
      .from(lastfmAlbums)
      .where(eq(lastfmAlbums.id, album.id));
    expect(row.appleMusicId).toBe(222);
    const terms = crowded.mock.calls
      .map(([input]) => new URL(input))
      .filter((url) => url.pathname.endsWith('/search'))
      .map((url) => url.searchParams.get('term'));
    expect(terms).toEqual(['Star Wars', 'Star Wars Wilco']);
  });

  it('rejects a catalog album credited to another artist', async () => {
    const album = await seed();
    const impostor = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/albums/111'))
        return reply({
          data: [
            {
              id: '111',
              type: 'albums',
              attributes: { name: 'Alpha Mike Foxtrot', artistName: 'Wilco' },
              relationships: { tracks: { data: [] } },
            },
          ],
        });
      if (url.pathname.endsWith('/search'))
        return reply({
          results: {
            albums: {
              data: [
                {
                  id: '333',
                  type: 'albums',
                  attributes: {
                    name: 'Star Wars',
                    artistName: 'A Tribute Band',
                  },
                },
              ],
            },
          },
        });
      return reply({
        data: [
          {
            id: '333',
            type: 'albums',
            attributes: {
              name: 'Star Wars',
              artistName: 'A Tribute Band',
              url: 'https://music.apple.com/us/album/x/333',
            },
            relationships: {
              tracks: {
                data: [
                  song(9, 1, {
                    name: 'Random Name Generator',
                    artistName: 'A Tribute Band',
                  }),
                ],
              },
            },
          },
        ],
      });
    });
    vi.stubGlobal('fetch', impostor);
    await syncAlbumTracklists(db, 'token', [album.id]);
    const [kept] = await db
      .select()
      .from(lastfmAlbums)
      .where(eq(lastfmAlbums.id, album.id));
    expect(kept.appleMusicId).toBe(111);
  });

  it('keeps the stored id when the search finds nothing, and retries after a failed search', async () => {
    const album = await seed();
    vi.stubGlobal('fetch', catalog({ results: {} }));
    expect(await syncAlbumTracklists(db, 'token', [album.id])).toEqual({
      stored: 0,
      skipped: 1,
    });
    const [kept] = await db
      .select()
      .from(lastfmAlbums)
      .where(eq(lastfmAlbums.id, album.id));
    expect(kept.appleMusicId).toBe(111);
    expect(kept.tracklistSyncedAt).toBeTruthy();

    await db
      .update(lastfmAlbums)
      .set({ tracklistSyncedAt: null })
      .where(eq(lastfmAlbums.id, album.id));
    vi.stubGlobal('fetch', catalog({}, 429));
    await syncAlbumTracklists(db, 'token', [album.id]);
    const [unstamped] = await db
      .select()
      .from(lastfmAlbums)
      .where(eq(lastfmAlbums.id, album.id));
    expect(unstamped.tracklistSyncedAt).toBeNull();
  });
});
