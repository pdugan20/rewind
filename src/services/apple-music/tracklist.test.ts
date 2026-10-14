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
} from '../../db/schema/lastfm.js';
import { setupTestDb } from '../../test-helpers.js';
import { fetchAlbumTracklist, syncAlbumTracklists } from './tracklist.js';

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
});
