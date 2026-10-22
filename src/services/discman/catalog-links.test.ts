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
  lastfmScrobbles,
  lastfmTracks,
} from '../../db/schema/lastfm.js';
import { setupTestDb } from '../../test-helpers.js';
import { syncAlbumTracklists } from '../apple-music/tracklist.js';
import {
  linkRecentAlbums,
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
    'DELETE FROM cd_artwork_albums; DELETE FROM cd_artwork_jobs; DELETE FROM lastfm_album_tracks; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists;'
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
  it('leaves an existing URL-only catalog selection untouched', async () => {
    const album = await seed();
    const url = 'https://music.apple.com/us/album/existing/123';
    await db
      .update(lastfmAlbums)
      .set({ appleMusicUrl: url })
      .where(eq(lastfmAlbums.id, album.id));
    const fetcher = vi.spyOn(globalThis, 'fetch');
    expect(await linkShelfAlbums(db, 'token', [album.id])).toEqual({
      checked: 0,
      linked: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (
        await db
          .select()
          .from(lastfmAlbums)
          .where(eq(lastfmAlbums.id, album.id))
      )[0].appleMusicUrl
    ).toBe(url);
  });
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

  it('tries an earlier song when the latest play is missing from the catalog', async () => {
    const album = await seed();
    const [{ id: matchId }] = await db.select().from(lastfmTracks);
    const [bonus] = await db
      .insert(lastfmTracks)
      .values({
        name: 'Bonus Track',
        artistId: album.artistId,
        albumId: album.id,
      })
      .returning();
    const play = (trackId: number, minute: number) => ({
      trackId,
      albumId: album.id,
      albumRecorded: 1,
      scrobbledAt: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
    });
    await db
      .insert(lastfmScrobbles)
      .values([play(matchId, 1), play(bonus.id, 2), play(bonus.id, 3)]);
    const catalog = catalogWith(
      catalogAlbum('1440941951', 'Collide With The Sky', 'Pierce the Veil')
    );
    const fetch = vi.fn(async (input: string) =>
      new URL(input).searchParams.get('term')?.includes('Bonus')
        ? reply({ results: {} })
        : catalog(input)
    );
    vi.stubGlobal('fetch', fetch);
    expect(await linkShelfAlbums(db, 'token', [album.id])).toEqual({
      checked: 1,
      linked: 1,
    });
    expect((await read(album.id)).appleMusicId).toBe(1440941951);
    const terms = fetch.mock.calls.map(([url]) =>
      new URL(url).searchParams.get('term')
    );
    expect(terms[0]).toContain('Bonus');
    expect(terms.some((term) => term?.includes('Match'))).toBe(true);
  });

  it('files a verified recording under its different album artist', async () => {
    const album = await seed();
    const fetch = catalogWith(
      catalogAlbum('77', 'Collide With The Sky', 'Various Artists')
    );
    vi.stubGlobal('fetch', fetch);
    expect(await linkShelfAlbums(db, 'token', [album.id])).toEqual({
      checked: 1,
      linked: 1,
    });
    const row = await read(album.id);
    expect(row.appleMusicId).toBeNull();
    const target = (await db.select().from(lastfmAlbums)).find(
      (a) => a.appleMusicId === 77
    );
    expect(target).toBeTruthy();
    expect((await db.select().from(lastfmTracks))[0].albumId).toBe(target!.id);
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

// Synthetic catalog and plays, with no generated artwork jobs or shelf admission.
async function recentAlbum(
  suffix: string,
  values: Partial<typeof lastfmAlbums.$inferInsert> = {},
  artistValues: Partial<typeof lastfmArtists.$inferInsert> = {},
  playValues: Partial<typeof lastfmScrobbles.$inferInsert> = {}
) {
  const userId = values.userId ?? 1;
  const [artist] = await db
    .insert(lastfmArtists)
    .values({
      name: `Synthetic Artist ${suffix}`,
      userId,
      ...artistValues,
    })
    .returning();
  const [album] = await db
    .insert(lastfmAlbums)
    .values({
      name: `Synthetic Album ${suffix}`,
      artistId: artist.id,
      userId,
      ...values,
    })
    .returning();
  const [track] = await db
    .insert(lastfmTracks)
    .values({
      name: `Synthetic Song ${suffix}`,
      artistId: artist.id,
      albumId: album.id,
      userId,
    })
    .returning();
  await db.insert(lastfmScrobbles).values({
    trackId: track.id,
    albumId: album.id,
    albumRecorded: 1,
    userId,
    scrobbledAt: new Date().toISOString(),
    ...playValues,
  });
  return { album, artist, track };
}

function syntheticCatalog(rows: Awaited<ReturnType<typeof recentAlbum>>[]) {
  return vi.fn(async (input: string) => {
    const url = new URL(input);
    const row = rows.find(
      ({ track }) =>
        url.searchParams.get('term')?.includes(track.name) ||
        url.searchParams.get('ids') === String(track.id)
    );
    const songs = row
      ? [
          {
            id: String(row.track.id),
            type: 'songs',
            attributes: {
              name: row.track.name,
              artistName: row.artist.name,
              albumName: row.album.name,
            },
            relationships: {
              albums: {
                data: [
                  catalogAlbum(
                    String(100000 + row.album.id),
                    row.album.name,
                    row.artist.name
                  ),
                ],
              },
            },
          },
        ]
      : [];
    return reply(
      url.pathname.endsWith('/search')
        ? { results: { songs: { data: songs } } }
        : { data: songs }
    );
  });
}

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86400000).toISOString();

describe('linkRecentAlbums', () => {
  it('links cover-only recent albums and retries older misses without the shelf cooldown', async () => {
    const row = await recentAlbum('cover-only', {
      name: '4:44',
      imageKey: 'synthetic/cover.jpg',
      itunesEnrichedAt: daysAgo(3),
      catalogLinkCheckedAt: daysAgo(2),
    });
    const fetch = syntheticCatalog([row]);
    vi.stubGlobal('fetch', fetch);
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 1,
      linked: 1,
    });
    expect(await read(row.album.id)).toMatchObject({
      appleMusicId: 100000 + row.album.id,
      appleMusicUrl: `https://music.apple.com/us/album/x/${100000 + row.album.id}`,
    });
    fetch.mockClear();
    await linkRecentAlbums(db, 'token');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips cooldowns, pins, linked rows, filters, conflicts and other owners', async () => {
    const rows = await Promise.all([
      recentAlbum('cooldown', { catalogLinkCheckedAt: daysAgo(0.25) }),
      recentAlbum('pinned', { appleMusicPinned: 1 }),
      recentAlbum('linked', {
        appleMusicId: 99,
        catalogLinkCheckedAt: daysAgo(0.25),
      }),
      recentAlbum('filtered', { isFiltered: 1 }),
      recentAlbum('conflict', { identityConflict: 1 }),
      recentAlbum('artist-filtered', {}, { isFiltered: 1 }),
      recentAlbum('artist-conflict', {}, { identityConflict: 1 }),
      recentAlbum('other-owner', { userId: 2 }),
      recentAlbum('foreign-artist', {}, { userId: 2 }),
      recentAlbum('stale', {}, {}, { scrobbledAt: daysAgo(31) }),
      recentAlbum('absent-album', {}, {}, { albumId: null }),
    ]);
    const fetch = syntheticCatalog(rows);
    vi.stubGlobal('fetch', fetch);
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 0,
      linked: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect((await read(rows[7].album.id)).appleMusicId).toBeNull();
  });

  it('uses the recorded album rather than the track default and supports legacy plays', async () => {
    const wrong = await recentAlbum('default', {}, {}, { albumId: null });
    const recorded = await recentAlbum('recorded');
    await db
      .update(lastfmTracks)
      .set({ albumId: wrong.album.id })
      .where(eq(lastfmTracks.id, recorded.track.id));
    const legacy = await recentAlbum(
      'legacy',
      {},
      {},
      { albumRecorded: 0, albumId: null }
    );
    vi.stubGlobal('fetch', syntheticCatalog([wrong, recorded, legacy]));
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 2,
      linked: 2,
    });
    expect((await read(wrong.album.id)).appleMusicId).toBeNull();
    expect((await read(recorded.album.id)).appleMusicId).toBeTruthy();
    expect((await read(legacy.album.id)).appleMusicId).toBeTruthy();
  });

  it('bounds attempts to five distinct albums and advances past checked misses', async () => {
    const rows = [];
    for (let i = 0; i < 7; i++) rows.push(await recentAlbum(String(i)));
    const fetch = vi.fn(async () => reply({ results: {} }));
    vi.stubGlobal('fetch', fetch);
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 5,
      linked: 0,
    });
    // One song per album: two song searches and two album searches per miss.
    expect(fetch).toHaveBeenCalledTimes(20);
    expect((await read(rows[0].album.id)).catalogLinkCheckedAt).toBeNull();
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 2,
      linked: 0,
    });
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 0,
      linked: 0,
    });
  });

  it.each([429, 503])('leaves HTTP %i failures retryable', async (status) => {
    const row = await recentAlbum('failure');
    const fetch = vi.fn(async () => reply({}, status));
    vi.stubGlobal('fetch', fetch);
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 0,
      linked: 0,
    });
    expect((await read(row.album.id)).catalogLinkCheckedAt).toBeNull();
    vi.stubGlobal('fetch', syntheticCatalog([row]));
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 1,
      linked: 1,
    });
  });

  it('rejects a song found on a different release than the stored album', async () => {
    const row = await recentAlbum('stored-release');
    const fetch = syntheticCatalog([
      {
        ...row,
        album: { ...row.album, name: 'Synthetic Different Release' },
      },
    ]);
    vi.stubGlobal('fetch', fetch);
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 1,
      linked: 0,
    });
    expect((await read(row.album.id)).appleMusicId).toBeNull();
    expect((await read(row.album.id)).catalogLinkCheckedAt).toBeTruthy();
  });

  it('caps song fallback at three attempts per album and then applies cooldown', async () => {
    const row = await recentAlbum('song-cap');
    for (let i = 0; i < 4; i++) {
      const [track] = await db
        .insert(lastfmTracks)
        .values({
          name: `Synthetic Extra Song ${i}`,
          artistId: row.artist.id,
          albumId: row.album.id,
        })
        .returning();
      await db.insert(lastfmScrobbles).values({
        trackId: track.id,
        albumId: row.album.id,
        albumRecorded: 1,
        scrobbledAt: new Date().toISOString(),
      });
    }
    const fetch = vi.fn(async () => reply({ results: {} }));
    vi.stubGlobal('fetch', fetch);
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 1,
      linked: 0,
    });
    // Each of three songs makes two song searches and two album searches.
    expect(fetch).toHaveBeenCalledTimes(12);
    fetch.mockClear();
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 0,
      linked: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops the batch on rate limits without stamping unattempted albums', async () => {
    const rows = [
      await recentAlbum('rate-first'),
      await recentAlbum('rate-latest'),
    ];
    const fetch = vi.fn(async () => reply({}, 429));
    vi.stubGlobal('fetch', fetch);
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 0,
      linked: 0,
    });
    expect(fetch).toHaveBeenCalledOnce();
    for (const { album } of rows)
      expect((await read(album.id)).catalogLinkCheckedAt).toBeNull();
  });

  it('files a collaboration under its verified expanded album credit', async () => {
    const row = await recentAlbum('wrong-credit');
    const catalog = vi.fn(async (input: string) => {
      const song = {
        id: '900',
        type: 'songs',
        attributes: {
          name: row.track.name,
          artistName: row.artist.name,
          albumName: row.album.name,
        },
        relationships: {
          albums: {
            data: [
              catalogAlbum('999', row.album.name, 'Synthetic Other Artist'),
            ],
          },
        },
      };
      return reply(
        new URL(input).pathname.endsWith('/search')
          ? { results: { songs: { data: [song] } } }
          : { data: [song] }
      );
    });
    vi.stubGlobal('fetch', catalog);
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 1,
      linked: 1,
    });
    expect((await read(row.album.id)).appleMusicId).toBeNull();
    const target = (await db.select().from(lastfmAlbums)).find(
      (a) => a.appleMusicId === 999
    );
    expect(target).toBeTruthy();
    expect((await db.select().from(lastfmScrobbles))[0].albumId).toBe(
      target!.id
    );
    await db
      .update(lastfmAlbums)
      .set({ catalogLinkCheckedAt: daysAgo(0) })
      .where(eq(lastfmAlbums.id, target!.id));
    catalog.mockClear();
    await linkRecentAlbums(db, 'token');
    expect(catalog).not.toHaveBeenCalled();
  });

  it('rechecks pin, filter and conflict safety after a catalog request', async () => {
    for (const patch of [
      { appleMusicPinned: 1 },
      { isFiltered: 1 },
      { identityConflict: 1 },
    ]) {
      const row = await recentAlbum(JSON.stringify(patch));
      const catalog = syntheticCatalog([row]);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
          await db
            .update(lastfmAlbums)
            .set(patch)
            .where(eq(lastfmAlbums.id, row.album.id));
          return catalog(input);
        })
      );
      expect(await linkRecentAlbums(db, 'token')).toEqual({
        checked: 1,
        linked: 0,
      });
      expect((await read(row.album.id)).appleMusicId).toBeNull();
      expect((await read(row.album.id)).catalogLinkCheckedAt).toBeNull();
    }
  });
});

describe('recent binding validation', () => {
  it('repairs an existing wrong release without requiring disc art', async () => {
    const row = await recentAlbum('incorrect-binding', {
      appleMusicId: 55,
      appleMusicUrl: 'https://music.apple.com/us/album/wrong/55',
    });
    const search = syntheticCatalog([row]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        new URL(input).pathname.endsWith('/albums/55')
          ? reply({
              data: [catalogAlbum('55', 'Different Release', row.artist.name)],
            })
          : search(input)
      )
    );
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 1,
      linked: 1,
    });
    expect((await read(row.album.id)).appleMusicId).toBe(100000 + row.album.id);
    expect(
      await env.DB.prepare('SELECT COUNT(*) n FROM cd_artwork_jobs').first('n')
    ).toBe(0);
  });
  it('validates an existing correct release without resetting its tracklist', async () => {
    const stamp = '2026-10-01T00:00:00Z';
    const row = await recentAlbum('valid-binding', {
      appleMusicId: 55,
      appleMusicUrl: 'https://music.apple.com/us/album/valid/55',
      tracklistSyncedAt: stamp,
    });
    const fetch = vi.fn(async () =>
      reply({ data: [catalogAlbum('55', row.album.name, row.artist.name)] })
    );
    vi.stubGlobal('fetch', fetch);
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 1,
      linked: 0,
    });
    expect((await read(row.album.id)).tracklistSyncedAt).toBe(stamp);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('retains a binding and its retry eligibility during a provider outage', async () => {
    const row = await recentAlbum('temporary-outage', {
      appleMusicId: 55,
      appleMusicUrl: 'https://music.apple.com/us/album/valid/55',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({}, 503))
    );
    expect(await linkRecentAlbums(db, 'token')).toEqual({
      checked: 0,
      linked: 0,
    });
    expect(await read(row.album.id)).toMatchObject({
      appleMusicId: 55,
      catalogLinkCheckedAt: null,
    });
  });
});

it('removes a proven wrong binding when no replacement can be confirmed', async () => {
  const row = await recentAlbum('invalid-no-replacement', {
    appleMusicId: 55,
    appleMusicUrl: 'https://music.apple.com/us/album/wrong/55',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      new URL(input).pathname.endsWith('/albums/55')
        ? reply({
            data: [catalogAlbum('55', 'Different Release', row.artist.name)],
          })
        : reply({ results: {} })
    )
  );
  expect(await linkRecentAlbums(db, 'token')).toEqual({
    checked: 1,
    linked: 0,
  });
  expect(await read(row.album.id)).toMatchObject({
    appleMusicId: null,
    appleMusicUrl: null,
  });
});
