import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
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
import { syncAlbumTracklists } from '../apple-music/tracklist.js';
import {
  linkShelfAlbums,
  pinCatalogAlbum,
  unresolvedAlbums,
} from './catalog-links.js';

function reply(body: unknown, status = 200) {
  return { ok: status === 200, status, json: async () => body };
}

const catalogAlbum = (id: string, name: string, artistName: string) => ({
  id,
  type: 'albums',
  attributes: {
    name,
    artistName,
    url: `https://music.apple.com/us/album/x/${id}`,
  },
});

/** A catalog whose song search finds the played song on the given album. */
function catalogWith(album: ReturnType<typeof catalogAlbum>) {
  const song = {
    id: '900',
    type: 'songs',
    attributes: {
      name: 'A Match Into Water',
      artistName: 'Pierce the Veil',
      albumName: album.attributes.name,
      isrc: 'US5261216603',
    },
    relationships: { albums: { data: [album] } },
  };
  return vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/search'))
      return reply({ results: { songs: { data: [song] } } });
    return reply({ data: [song] });
  });
}

let db: Database;
beforeAll(setupTestDb);
beforeEach(async () => {
  db = createDb(env.DB);
  await env.DB.exec(
    'DELETE FROM lastfm_album_tracks; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists;'
  );
});
afterEach(() => vi.unstubAllGlobals());

/** An album known only through its track (plays from before album snapshots). */
async function seed(values: Partial<typeof lastfmAlbums.$inferInsert> = {}) {
  const [artist] = await db
    .insert(lastfmArtists)
    .values({ name: 'Pierce the Veil' })
    .returning();
  const [album] = await db
    .insert(lastfmAlbums)
    .values({ name: 'Collide With the Sky', artistId: artist.id, ...values })
    .returning();
  await db.insert(lastfmTracks).values({
    name: 'A Match In Water',
    artistId: artist.id,
    albumId: album.id,
  });
  return album;
}

const read = async (id: number) =>
  (await db.select().from(lastfmAlbums).where(eq(lastfmAlbums.id, id)))[0];

describe('linkShelfAlbums', () => {
  it('links an unlinked album from a song played on it', async () => {
    const album = await seed({ tracklistSyncedAt: '2026-01-01T00:00:00.000Z' });
    vi.stubGlobal(
      'fetch',
      catalogWith(
        catalogAlbum('1440941951', 'Collide With The Sky', 'Pierce the Veil')
      )
    );
    expect(await linkShelfAlbums(db, 'token', [album.id])).toEqual({
      checked: 1,
      linked: 1,
    });
    expect(await read(album.id)).toMatchObject({
      appleMusicId: 1440941951,
      appleMusicUrl: 'https://music.apple.com/us/album/x/1440941951',
      tracklistSyncedAt: null,
    });
  });

  it('leaves a release credited to another artist and waits before retrying', async () => {
    const album = await seed();
    const fetch = catalogWith(
      catalogAlbum('77', 'Collide With The Sky', 'Various Artists')
    );
    vi.stubGlobal('fetch', fetch);
    expect(await linkShelfAlbums(db, 'token', [album.id])).toEqual({
      checked: 1,
      linked: 0,
    });
    const row = await read(album.id);
    expect(row.appleMusicId).toBeNull();
    expect(row.catalogLinkCheckedAt).toBeTruthy();
    fetch.mockClear();
    await linkShelfAlbums(db, 'token', [album.id]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips pinned and already linked albums', async () => {
    const pinned = await seed({ appleMusicPinned: 1 });
    const fetch = catalogWith(
      catalogAlbum('1440941951', 'Collide With The Sky', 'Pierce the Veil')
    );
    vi.stubGlobal('fetch', fetch);
    expect(await linkShelfAlbums(db, 'token', [pinned.id])).toEqual({
      checked: 0,
      linked: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retries at the next refresh after a rate limit', async () => {
    const album = await seed();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({}, 429))
    );
    await linkShelfAlbums(db, 'token', [album.id]);
    expect((await read(album.id)).catalogLinkCheckedAt).toBeNull();
  });
});

describe('pinCatalogAlbum', () => {
  const box = {
    data: [
      {
        id: '555',
        type: 'albums',
        attributes: {
          name: 'Collide With The Sky (Deluxe Reissue Box)',
          artistName: 'Pierce the Veil',
          url: 'https://music.apple.com/us/album/x/555',
        },
        relationships: {
          tracks: {
            data: [
              {
                id: '901',
                type: 'songs',
                attributes: {
                  name: 'May These Noises Startle You in Your Sleep Tonight',
                  artistName: 'Pierce the Veil',
                  discNumber: 1,
                  trackNumber: 1,
                },
              },
            ],
          },
        },
      },
    ],
  };

  it('stores a verified id that tracklist sync then trusts', async () => {
    const album = await seed({
      appleMusicId: 1,
      appleMusicUrl: 'https://music.apple.com/us/album/x/1',
    });
    const fetch = vi.fn(async (_input: string) => reply(box));
    vi.stubGlobal('fetch', fetch);
    expect(await pinCatalogAlbum(db, 'token', 1, album.id, 555)).toMatchObject({
      status: 'pinned',
      apple_music_id: 555,
    });
    expect(await read(album.id)).toMatchObject({
      appleMusicId: 555,
      appleMusicPinned: 1,
      tracklistSyncedAt: null,
    });
    // The catalog title differs from the stored one; a pin is used as is.
    expect(await syncAlbumTracklists(db, 'token', [album.id])).toEqual({
      stored: 1,
      skipped: 0,
    });
    const tracks = await db
      .select()
      .from(lastfmAlbumTracks)
      .where(eq(lastfmAlbumTracks.albumId, album.id));
    expect(tracks).toHaveLength(1);
    expect(
      fetch.mock.calls.some(([input]) => String(input).includes('/search'))
    ).toBe(false);
  });

  it('rejects an id the catalog does not have, and releases a pin', async () => {
    const album = await seed({ appleMusicId: 555, appleMusicPinned: 1 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({ errors: [] }, 404))
    );
    expect(await pinCatalogAlbum(db, 'token', 1, album.id, 999)).toEqual({
      status: 'catalog_not_found',
    });
    expect(await pinCatalogAlbum(db, 'token', 1, album.id, null)).toMatchObject(
      {
        status: 'unpinned',
        apple_music_id: 555,
      }
    );
    expect((await read(album.id)).appleMusicPinned).toBe(0);
    expect(await pinCatalogAlbum(db, 'token', 1, 999999, null)).toEqual({
      status: 'album_not_found',
    });
  });
});

describe('unresolvedAlbums', () => {
  it('lists shelf albums without a stored tracklist, in shelf order', async () => {
    const a = await seed();
    const [artist] = await db
      .insert(lastfmArtists)
      .values({ name: 'Wilco' })
      .returning();
    const [b] = await db
      .insert(lastfmAlbums)
      .values({
        name: 'Star Wars',
        artistId: artist.id,
        appleMusicId: 1690693404,
      })
      .returning();
    const [c] = await db
      .insert(lastfmAlbums)
      .values({
        name: 'Wilco (The Album)',
        artistId: artist.id,
        appleMusicId: 3,
      })
      .returning();
    await db.insert(lastfmAlbumTracks).values({
      albumId: c.id,
      discNumber: 1,
      trackNumber: 1,
      name: 'Wilco (The Song)',
      appleMusicId: 31,
      syncedAt: '2026-10-15T00:00:00.000Z',
    });
    const items = await unresolvedAlbums(db, [b.id, c.id, a.id]);
    expect(items.map((item) => [item.album_id, item.apple_music_id])).toEqual([
      [b.id, 1690693404],
      [a.id, null],
    ]);
  });
});
