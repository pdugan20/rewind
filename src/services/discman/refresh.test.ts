import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import {
  lastfmAlbums,
  lastfmArtists,
  lastfmScrobbles,
  lastfmTracks,
} from '../../db/schema/lastfm.js';
import { setupTestDb } from '../../test-helpers.js';
import { enrichBatch } from '../itunes/enrich.js';
import { enrichNewAlbums } from '../itunes/album-enrich.js';
import { syncAlbumTracklists } from '../apple-music/tracklist.js';
import { selectRecentAlbums } from './snapshot.js';
import { refreshDiscman } from './refresh.js';

vi.mock('../itunes/enrich.js', async (original) => ({
  ...(await original<typeof import('../itunes/enrich.js')>()),
  enrichBatch: vi.fn(async () => undefined),
}));
vi.mock('../itunes/album-enrich.js', async (original) => ({
  ...(await original<typeof import('../itunes/album-enrich.js')>()),
  enrichNewAlbums: vi.fn(async () => ({ checked: 0, filed: 0, linked: 0 })),
}));
vi.mock('../apple-music/tracklist.js', async (original) => ({
  ...(await original<typeof import('../apple-music/tracklist.js')>()),
  syncAlbumTracklists: vi.fn(async () => ({ stored: 0, skipped: 0 })),
}));

const db = createDb(env.DB);
beforeAll(setupTestDb);
beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM listening_discman_snapshots; DELETE FROM cd_artwork_albums; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists;'
  );
});
afterEach(() => vi.unstubAllGlobals());

async function seed() {
  const [artist] = await db
    .insert(lastfmArtists)
    .values({ name: 'Synthetic Refresh Artist', userId: 2 })
    .returning();
  const [album] = await db
    .insert(lastfmAlbums)
    .values({
      name: 'Synthetic Refresh Album',
      artistId: artist.id,
      userId: 2,
      imageKey: 'synthetic/cover.jpg',
      itunesEnrichedAt: '2026-01-01T00:00:00.000Z',
      catalogLinkCheckedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    })
    .returning();
  const [track] = await db
    .insert(lastfmTracks)
    .values({
      name: 'Synthetic Refresh Song',
      artistId: artist.id,
      albumId: album.id,
      userId: 2,
    })
    .returning();
  await db.insert(lastfmScrobbles).values({
    trackId: track.id,
    albumId: album.id,
    albumRecorded: 1,
    userId: 2,
    scrobbledAt: new Date().toISOString(),
  });
  return { album, artist, track };
}

it('scheduled refresh links an owned cover-only album even with an empty disc shelf', async () => {
  const { album, artist, track } = await seed();
  expect(await selectRecentAlbums(db, 2)).toEqual([]);
  const song = {
    id: '800',
    type: 'songs',
    attributes: {
      name: track.name,
      artistName: artist.name,
      albumName: album.name,
    },
    relationships: {
      albums: {
        data: [
          {
            id: '900',
            type: 'albums',
            attributes: {
              name: album.name,
              artistName: artist.name,
              url: 'https://music.apple.com/us/album/synthetic/900',
            },
          },
        ],
      },
    },
  };
  const fetch = vi.fn(async (input: string) =>
    Response.json(
      new URL(input).pathname.endsWith('/search')
        ? { results: { songs: { data: [song] } } }
        : { data: [song] }
    )
  );
  vi.stubGlobal('fetch', fetch);
  await refreshDiscman(
    db,
    { APPLE_MUSIC_DEVELOPER_TOKEN: 'synthetic-token' },
    2
  );
  expect(
    (
      await db.select().from(lastfmAlbums).where(eq(lastfmAlbums.id, album.id))
    )[0]
  ).toMatchObject({
    appleMusicId: 900,
    appleMusicUrl: 'https://music.apple.com/us/album/synthetic/900',
  });
  expect(enrichNewAlbums).toHaveBeenCalledWith(db, 5, 2, 'synthetic-token');
  expect(syncAlbumTracklists).toHaveBeenCalledWith(
    db,
    'synthetic-token',
    [],
    2
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  const snapshot = await env.DB.prepare(
    'SELECT snapshot FROM listening_discman_snapshots WHERE user_id = 2'
  ).first<{ snapshot: string }>();
  expect(snapshot).not.toBeNull();
});

it('publishes the shelf without a token or during catalog failure', async () => {
  const { album } = await seed();
  const fetch = vi.fn(async () => {
    throw new Error('synthetic provider outage');
  });
  vi.stubGlobal('fetch', fetch);
  await refreshDiscman(db, { APPLE_MUSIC_DEVELOPER_TOKEN: '' }, 2);
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(enrichBatch).mockRejectedValueOnce(
    new Error('synthetic enrichment outage')
  );
  await refreshDiscman(
    db,
    { APPLE_MUSIC_DEVELOPER_TOKEN: 'synthetic-token' },
    2
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(
    (
      await db.select().from(lastfmAlbums).where(eq(lastfmAlbums.id, album.id))
    )[0].appleMusicId
  ).toBeNull();
  expect(
    await env.DB.prepare(
      'SELECT user_id FROM listening_discman_snapshots WHERE user_id = 2'
    ).first()
  ).toEqual({ user_id: 2 });
});
