import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import {
  lastfmArtists,
  lastfmAlbums,
  lastfmTracks,
} from '../../db/schema/lastfm.js';
import { setupTestDb } from '../../test-helpers.js';
import { enrichBatch } from './enrich.js';
const db = createDb(env.DB);
async function seed(
  name = 'Synthetic (White Album - Deluxe Edition)',
  userId = 1
) {
  const [artist] = await db
    .insert(lastfmArtists)
    .values({ name: 'Synthetic', userId })
    .returning();
  const [album] = await db
    .insert(lastfmAlbums)
    .values({ name, artistId: artist.id, userId })
    .returning();
  const [track] = await db
    .insert(lastfmTracks)
    .values({
      name: 'Test Song',
      artistId: artist.id,
      albumId: album.id,
      userId,
    })
    .returning();
  return { artist, album, track };
}
function response(extra: Record<string, unknown> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              artistName: 'Synthetic',
              trackName: 'Test Song',
              trackId: 101,
              trackViewUrl: 'https://music.apple.com/us/song/test/101',
              artistId: 102,
              artistViewUrl: 'https://music.apple.com/us/artist/synthetic/102',
              collectionId: 103,
              collectionName: 'Synthetic (Green Album)',
              collectionViewUrl: 'https://music.apple.com/us/album/test/103',
              ...extra,
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    )
  );
}
async function rows(ids: Awaited<ReturnType<typeof seed>>) {
  return {
    album: (
      await db
        .select()
        .from(lastfmAlbums)
        .where(eq(lastfmAlbums.id, ids.album.id))
    )[0],
    track: (
      await db
        .select()
        .from(lastfmTracks)
        .where(eq(lastfmTracks.id, ids.track.id))
    )[0],
  };
}
describe('track enrichment identity boundaries', () => {
  beforeAll(setupTestDb);
  beforeEach(async () => {
    await env.DB.exec(
      'DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists;'
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  it('enriches the exact song without assigning a different collection to its album', async () => {
    const ids = await seed();
    response();
    expect((await enrichBatch(db, 1)).succeeded).toBe(1);
    const result = await rows(ids);
    expect(result.track.appleMusicId).toBe(101);
    expect(result.album.appleMusicId).toBeNull();
    expect(result.album.itunesEnrichedAt).toBeNull();
  });
  it('assigns a verified same-title edition and scopes writes to the owning user', async () => {
    const ids = await seed(undefined, 2);
    response({ collectionName: 'Synthetic (White Album)' });
    await enrichBatch(db, 1);
    expect((await rows(ids)).album.appleMusicId).toBe(103);
  });
  it.each([
    { trackName: 'Another Song' },
    { trackName: undefined },
    { artistName: undefined },
    { trackName: 'Test Song (Live)' },
  ])('rejects an unverifiable or different song %o', async (extra) => {
    const ids = await seed();
    response(extra);
    await enrichBatch(db, 1);
    const result = await rows(ids);
    expect(result.track.appleMusicId).toBeNull();
    expect(result.album.appleMusicId).toBeNull();
  });
  it('keeps an unqualified self-titled album unresolved even for an exact song', async () => {
    const ids = await seed('Synthetic');
    response({ collectionName: 'Synthetic (Deluxe Edition)' });
    await enrichBatch(db, 1);
    expect((await rows(ids)).album.appleMusicId).toBeNull();
  });
  it('does not overwrite existing album metadata', async () => {
    const ids = await seed();
    await db
      .update(lastfmAlbums)
      .set({ appleMusicId: 999, itunesEnrichedAt: new Date().toISOString() })
      .where(eq(lastfmAlbums.id, ids.album.id));
    response({ collectionName: 'Synthetic (White Album)' });
    await enrichBatch(db, 1);
    expect((await rows(ids)).album.appleMusicId).toBe(999);
  });
});
