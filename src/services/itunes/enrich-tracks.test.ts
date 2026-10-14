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
  lastfmScrobbles,
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

describe('various-artists records', () => {
  const SOUNDTRACK = 'Reservoir Dogs: Original Motion Picture Soundtrack';
  beforeAll(setupTestDb);
  beforeEach(async () => {
    await env.DB.exec(
      'DELETE FROM cd_artwork_checks; DELETE FROM cd_artwork_albums; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists;'
    );
    // Disc-art enrollment on play stays off unless a test turns it on.
    await env.DB.exec(
      "UPDATE cd_artwork_control SET enabled=1,enroll_since='2099-01-01T00:00:00Z' WHERE id=1"
    );
    await db.insert(lastfmArtists).values({
      name: 'Various Artists',
      mbid: '89ad4ac3-39f7-470e-963a-56509c546377',
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  // A play as sync records it: the album is credited to the track artist.
  async function played(artistName: string, song: string, album = SOUNDTRACK) {
    const [artist] = await db
      .insert(lastfmArtists)
      .values({ name: artistName })
      .returning();
    const [split] = await db
      .insert(lastfmAlbums)
      .values({ name: album, artistId: artist.id })
      .returning();
    const [track] = await db
      .insert(lastfmTracks)
      .values({ name: song, artistId: artist.id, albumId: split.id })
      .returning();
    await db.insert(lastfmScrobbles).values([
      {
        trackId: track.id,
        albumId: split.id,
        albumRecorded: 1,
        scrobbledAt: '2026-01-01T00:00:00.000Z',
      },
      // The same song played from another album keeps that album.
      {
        trackId: track.id,
        albumId: null,
        albumRecorded: 1,
        scrobbledAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
    return { artist, split, track };
  }
  const song = (
    artistName: string,
    trackName: string,
    collectionName: string,
    extra: Record<string, unknown> = {}
  ) => ({
    artistName,
    trackName,
    trackId: 1,
    trackViewUrl: 'https://music.apple.com/us/song/1',
    collectionId: 1440847276,
    collectionName,
    collectionViewUrl: 'https://music.apple.com/us/album/1440847276',
    previewUrl: 'https://audio.example/preview.m4a',
    ...extra,
  });
  function results(...items: Array<Record<string, unknown>>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ results: items }), {
            headers: { 'content-type': 'application/json' },
          })
      )
    );
  }
  async function albumOf(trackId: number) {
    const [row] = await db
      .select({
        id: lastfmAlbums.id,
        name: lastfmAlbums.name,
        artist: lastfmArtists.name,
        appleMusicId: lastfmAlbums.appleMusicId,
      })
      .from(lastfmTracks)
      .innerJoin(lastfmAlbums, eq(lastfmAlbums.id, lastfmTracks.albumId))
      .innerJoin(lastfmArtists, eq(lastfmArtists.id, lastfmAlbums.artistId))
      .where(eq(lastfmTracks.id, trackId));
    return row;
  }
  const playAlbums = async (trackId: number) =>
    (
      await db
        .select({ albumId: lastfmScrobbles.albumId })
        .from(lastfmScrobbles)
        .where(eq(lastfmScrobbles.trackId, trackId))
        .orderBy(lastfmScrobbles.scrobbledAt)
    ).map((row) => row.albumId);

  it('files a soundtrack song and its plays of that album under one Various Artists album', async () => {
    const nilsson = await played('Harry Nilsson', 'Coconut');
    results(
      // The artist's own album is iTunes' first match for the song.
      song('Harry Nilsson', 'Coconut', 'Nilsson Schmilsson', {
        collectionId: 304815001,
      }),
      song(
        'Harry Nilsson',
        'Coconut',
        'Reservoir Dogs (Original Motion Picture Soundtrack)',
        { collectionArtistName: 'Various Artists' }
      )
    );
    expect((await enrichBatch(db, 1)).succeeded).toBe(1);
    const compilation = await albumOf(nilsson.track.id);
    expect(compilation).toMatchObject({
      name: SOUNDTRACK,
      artist: 'Various Artists',
      appleMusicId: 1440847276,
    });
    expect(await playAlbums(nilsson.track.id)).toEqual([compilation.id, null]);

    const stealers = await played('Stealers Wheel', 'Stuck in the Middle');
    results(
      song(
        'Stealers Wheel',
        'Stuck in the Middle',
        'Reservoir Dogs (Original Motion Picture Soundtrack)',
        { collectionArtistName: 'Various Artists' }
      )
    );
    await enrichBatch(db, 1);
    expect((await albumOf(stealers.track.id)).id).toBe(compilation.id);
    // The per-artist album keeps no catalog identity of its own.
    const [split] = await db
      .select()
      .from(lastfmAlbums)
      .where(eq(lastfmAlbums.id, nilsson.split.id));
    expect(split.appleMusicId).toBeNull();
  });

  const soundtrack = (artistName: string, trackName: string) =>
    song(
      artistName,
      trackName,
      'Reservoir Dogs (Original Motion Picture Soundtrack)',
      { collectionArtistName: 'Various Artists' }
    );

  it('enrolls the soundtrack for disc art the way a play would', async () => {
    await env.DB.exec(
      "UPDATE cd_artwork_control SET enroll_since='2020-01-01T00:00:00Z' WHERE id=1"
    );
    const nilsson = await played('Harry Nilsson', 'Coconut');
    results(soundtrack('Harry Nilsson', 'Coconut'));
    await enrichBatch(db, 1);
    const compilation = await albumOf(nilsson.track.id);
    const held = await env.DB.prepare(
      'SELECT album_id,discovery_outcome FROM cd_artwork_albums WHERE album_id=?'
    )
      .bind(compilation.id)
      .first();
    expect(held).toEqual({
      album_id: compilation.id,
      discovery_outcome: 'identity_required',
    });
  });

  it('leaves the track queued when the move fails, then moves it on the next run', async () => {
    const nilsson = await played('Harry Nilsson', 'Coconut');
    results(soundtrack('Harry Nilsson', 'Coconut'));
    const batch = vi
      .spyOn(db, 'batch')
      .mockRejectedValueOnce(new Error('D1 unavailable'));
    expect((await enrichBatch(db, 1)).failed).toBe(1);
    const [pending] = await db
      .select()
      .from(lastfmTracks)
      .where(eq(lastfmTracks.id, nilsson.track.id));
    expect(pending.itunesEnrichedAt).toBeNull();
    expect(pending.albumId).toBe(nilsson.split.id);
    expect(await playAlbums(nilsson.track.id)).toEqual([
      nilsson.split.id,
      null,
    ]);
    batch.mockRestore();

    expect((await enrichBatch(db, 1)).succeeded).toBe(1);
    const compilation = await albumOf(nilsson.track.id);
    expect(compilation.artist).toBe('Various Artists');
    expect(await playAlbums(nilsson.track.id)).toEqual([compilation.id, null]);
  });

  it("does not use another user's Various Artists row", async () => {
    await db
      .update(lastfmArtists)
      .set({ userId: 2 })
      .where(eq(lastfmArtists.name, 'Various Artists'));
    const nilsson = await played('Harry Nilsson', 'Coconut');
    results(soundtrack('Harry Nilsson', 'Coconut'));
    expect((await enrichBatch(db, 1)).succeeded).toBe(1);
    expect((await albumOf(nilsson.track.id)).id).toBe(nilsson.split.id);
  });

  it.each([
    [
      'a single artist collection',
      'Pure McCartney',
      'Pure McCartney',
      'Paul McCartney',
    ],
    [
      'a different compilation',
      SOUNDTRACK,
      "'70s Greatest Hits",
      'Various Artists',
    ],
  ])(
    'leaves %s with the track artist',
    async (_, album, collection, albumArtist) => {
      const wings = await played('Wings', 'Jet', album);
      results(
        song('Wings', 'Jet', collection, {
          collectionArtistName: albumArtist,
        })
      );
      expect((await enrichBatch(db, 1)).succeeded).toBe(1);
      expect((await albumOf(wings.track.id)).id).toBe(wings.split.id);
      expect(await playAlbums(wings.track.id)).toEqual([wings.split.id, null]);
    }
  );
});
