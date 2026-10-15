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
import { and, eq } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import {
  lastfmAlbums,
  lastfmArtists,
  lastfmScrobbles,
  lastfmTracks,
} from '../../db/schema/lastfm.js';
import { setupTestDb } from '../../test-helpers.js';
import { enrichNewAlbums, reviewAlbums } from './album-enrich.js';
import { enrichBatch } from './enrich.js';

const db = createDb(env.DB);
const SOUNDTRACK = 'Reservoir Dogs: Original Motion Picture Soundtrack';
const NEW = '2026-10-16T00:00:00.000Z';
const BEFORE_CUTOFF = '2026-10-14T21:00:00.000Z';

let variousArtistsId: number;
let minute = 0;

beforeAll(setupTestDb);
beforeEach(async () => {
  minute = 0;
  await env.DB.exec(
    'DELETE FROM lastfm_album_attribution_audit; DELETE FROM cd_artwork_checks; DELETE FROM cd_artwork_albums; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists;'
  );
  // Disc-art enrollment on play stays off unless a test turns it on.
  await env.DB.exec(
    "UPDATE cd_artwork_control SET enabled=1,enroll_since='2099-01-01T00:00:00Z' WHERE id=1"
  );
  [{ id: variousArtistsId }] = await db
    .insert(lastfmArtists)
    .values({
      name: 'Various Artists',
      mbid: '89ad4ac3-39f7-470e-963a-56509c546377',
    })
    .returning();
});
afterEach(() => vi.unstubAllGlobals());

async function artist(name: string) {
  const [existing] = await db
    .select()
    .from(lastfmArtists)
    .where(eq(lastfmArtists.name, name));
  return (
    existing ?? (await db.insert(lastfmArtists).values({ name }).returning())[0]
  );
}

/**
 * One play as sync records it: under a per-artist album, while the song may
 * already belong to another album (as "Coconut" belongs to Nilsson Schmilsson).
 */
async function played(
  artistName: string,
  song: string,
  options: { album?: string; createdAt?: string; songAlbum?: string } = {}
) {
  const a = await artist(artistName);
  const albumName = options.album ?? SOUNDTRACK;
  const [existing] = await db
    .select()
    .from(lastfmAlbums)
    .where(
      and(eq(lastfmAlbums.name, albumName), eq(lastfmAlbums.artistId, a.id))
    );
  const split =
    existing ??
    (
      await db
        .insert(lastfmAlbums)
        .values({
          name: albumName,
          artistId: a.id,
          createdAt: options.createdAt ?? NEW,
        })
        .returning()
    )[0];
  const home = options.songAlbum
    ? (
        await db
          .insert(lastfmAlbums)
          .values({ name: options.songAlbum, artistId: a.id })
          .returning()
      )[0]
    : split;
  const [track] = await db
    .insert(lastfmTracks)
    .values({ name: song, artistId: a.id, albumId: home.id })
    .returning();
  minute++;
  await db.insert(lastfmScrobbles).values({
    trackId: track.id,
    albumId: split.id,
    albumRecorded: 1,
    scrobbledAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
  });
  return { artist: a, split, home, track };
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
  ...extra,
});
const soundtrack = (artistName: string, trackName: string) =>
  song(
    artistName,
    trackName,
    'Reservoir Dogs (Original Motion Picture Soundtrack)',
    { collectionArtistName: 'Various Artists' }
  );

function itunes(answer: (term: string) => Array<Record<string, unknown>>) {
  const fetch = vi.fn(async (url: string) => {
    const term = new URL(url).searchParams.get('term') ?? '';
    return new Response(JSON.stringify({ results: answer(term) }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function album(id: number) {
  return (
    await db.select().from(lastfmAlbums).where(eq(lastfmAlbums.id, id))
  )[0];
}
async function compilation() {
  return (
    await db
      .select()
      .from(lastfmAlbums)
      .where(
        and(
          eq(lastfmAlbums.name, SOUNDTRACK),
          eq(lastfmAlbums.artistId, variousArtistsId)
        )
      )
  )[0];
}
const playAlbum = async (trackId: number) =>
  (
    await db
      .select({ albumId: lastfmScrobbles.albumId })
      .from(lastfmScrobbles)
      .where(eq(lastfmScrobbles.trackId, trackId))
  ).map((row) => row.albumId);
const songAlbum = async (trackId: number) =>
  (await db.select().from(lastfmTracks).where(eq(lastfmTracks.id, trackId)))[0]
    .albumId;

describe('album checks', () => {
  it('files soundtrack plays under one Various Artists album, including songs that live elsewhere', async () => {
    await env.DB.exec(
      "UPDATE cd_artwork_control SET enroll_since='2020-01-01T00:00:00Z' WHERE id=1"
    );
    const nilsson = await played('Harry Nilsson', 'Coconut', {
      songAlbum: 'Nilsson Schmilsson',
    });
    const stealers = await played('Stealers Wheel', 'Stuck in the Middle');
    itunes((term) =>
      term.includes('Coconut')
        ? // A plain search finds only Nilsson's own albums; the soundtrack
          // appears once the album is part of the search.
          term.includes('Reservoir')
          ? [soundtrack('Harry Nilsson', 'Coconut')]
          : [
              song('Harry Nilsson', 'Coconut', 'Nilsson Schmilsson', {
                collectionId: 304815001,
              }),
            ]
        : [soundtrack('Stealers Wheel', 'Stuck in the Middle')]
    );

    expect(await enrichNewAlbums(db, 5)).toEqual({
      checked: 2,
      filed: 2,
      linked: 0,
    });
    const various = await compilation();
    expect(various.appleMusicId).toBe(1440847276);
    expect(await playAlbum(nilsson.track.id)).toEqual([various.id]);
    expect(await playAlbum(stealers.track.id)).toEqual([various.id]);
    // "Coconut" still belongs to Nilsson's album; a song first seen on the
    // soundtrack moves with it.
    expect(await songAlbum(nilsson.track.id)).toBe(nilsson.home.id);
    expect(await songAlbum(stealers.track.id)).toBe(various.id);
    expect((await album(nilsson.split.id)).itunesEnrichedAt).not.toBeNull();
    // Sync reads the audit row to file later plays of these albums the same way.
    const audit = await env.DB.prepare(
      "SELECT original_album_id,new_album_id FROM lastfm_album_attribution_audit WHERE action='FILE_UNDER_VARIOUS_ARTISTS' ORDER BY original_album_id"
    ).all();
    expect(audit.results).toEqual([
      { original_album_id: nilsson.split.id, new_album_id: various.id },
      { original_album_id: stealers.split.id, new_album_id: various.id },
    ]);
    const held = await env.DB.prepare(
      'SELECT discovery_outcome FROM cd_artwork_albums WHERE album_id=?'
    )
      .bind(various.id)
      .first();
    expect(held).toEqual({ discovery_outcome: 'identity_required' });
  });

  it('still files a new soundtrack song after track enrichment runs first', async () => {
    // The refresh enriches new tracks before checking albums.
    const stealers = await played('Stealers Wheel', 'Stuck in the Middle');
    itunes(() => [soundtrack('Stealers Wheel', 'Stuck in the Middle')]);
    expect((await enrichBatch(db, 5)).succeeded).toBe(1);
    expect((await album(stealers.split.id)).appleMusicId).toBeNull();
    expect(await enrichNewAlbums(db, 5)).toMatchObject({ filed: 1 });
    expect(await songAlbum(stealers.track.id)).toBe((await compilation()).id);
  });

  it('links a single-artist album and leaves its plays with the artist', async () => {
    const paul = await played('Paul McCartney', "Maybe I'm Amazed", {
      album: 'PURE MCCARTNEY',
      songAlbum: 'McCartney',
    });
    itunes(() => [
      song('Paul McCartney', "Maybe I'm Amazed", 'McCartney (2011 Remaster)', {
        collectionId: 1,
      }),
      song(
        'Paul McCartney',
        "Maybe I'm Amazed",
        'Pure McCartney (Deluxe Edition)',
        { collectionId: 1440954858 }
      ),
    ]);
    expect(await enrichNewAlbums(db, 5)).toMatchObject({ linked: 1 });
    expect((await album(paul.split.id)).appleMusicId).toBe(1440954858);
    expect(await playAlbum(paul.track.id)).toEqual([paul.split.id]);
  });

  it('leaves albums created before the cutoff to the reviewed action', async () => {
    const nilsson = await played('Harry Nilsson', 'Coconut', {
      createdAt: BEFORE_CUTOFF,
    });
    const fetch = itunes(() => [soundtrack('Harry Nilsson', 'Coconut')]);
    expect(await enrichNewAlbums(db, 5)).toEqual({
      checked: 0,
      filed: 0,
      linked: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await playAlbum(nilsson.track.id)).toEqual([nilsson.split.id]);
  });

  it('previews a review without writing, then applies the same decision', async () => {
    const nilsson = await played('Harry Nilsson', 'Coconut', {
      createdAt: BEFORE_CUTOFF,
      songAlbum: 'Nilsson Schmilsson',
    });
    const [existing] = await db
      .insert(lastfmAlbums)
      .values({ name: SOUNDTRACK, artistId: variousArtistsId })
      .returning();
    itunes(() => [soundtrack('Harry Nilsson', 'Coconut')]);

    const preview = await reviewAlbums(db, 1, [nilsson.split.id], true);
    expect(preview).toEqual({
      dry_run: true,
      items: [
        {
          album_id: nilsson.split.id,
          album: SOUNDTRACK,
          artist: 'Harry Nilsson',
          played_track: 'Coconut',
          match: {
            album: 'Reservoir Dogs (Original Motion Picture Soundtrack)',
            album_artist: 'Various Artists',
            catalog_id: 1440847276,
          },
          action: 'file_under_various_artists',
          target_album_id: existing.id,
          plays_moved: 1,
          tracks_moved: 0,
        },
      ],
    });
    expect(await playAlbum(nilsson.track.id)).toEqual([nilsson.split.id]);
    expect((await album(nilsson.split.id)).itunesEnrichedAt).toBeNull();

    const live = await reviewAlbums(db, 1, [nilsson.split.id], false);
    expect(live.items[0]).toMatchObject({
      action: 'file_under_various_artists',
      applied: true,
    });
    expect(await playAlbum(nilsson.track.id)).toEqual([existing.id]);
  });

  it('reports why a search failed and changes nothing', async () => {
    const nilsson = await played('Harry Nilsson', 'Coconut', {
      createdAt: BEFORE_CUTOFF,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 503 }))
    );
    const live = await reviewAlbums(db, 1, [nilsson.split.id], false);
    expect(live.items[0]).toMatchObject({
      action: 'error',
      detail: 'HTTP 503',
      applied: false,
    });
    expect((await album(nilsson.split.id)).itunesEnrichedAt).toBeNull();
  });

  it('stops at a rate limit and leaves the albums unchecked', async () => {
    const nilsson = await played('Harry Nilsson', 'Coconut', {
      createdAt: BEFORE_CUTOFF,
    });
    const stealers = await played('Stealers Wheel', 'Stuck in the Middle', {
      createdAt: BEFORE_CUTOFF,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('slow down', { status: 429 }))
    );
    const live = await reviewAlbums(
      db,
      1,
      [nilsson.split.id, stealers.split.id],
      false,
      0
    );
    expect(live.items.map((item) => item.action)).toEqual([
      'rate_limited',
      'rate_limited',
    ]);
    expect((await album(nilsson.split.id)).itunesEnrichedAt).toBeNull();
  });

  it("ignores another user's albums", async () => {
    const nilsson = await played('Harry Nilsson', 'Coconut');
    itunes(() => [soundtrack('Harry Nilsson', 'Coconut')]);
    expect((await reviewAlbums(db, 2, [nilsson.split.id], true)).items).toEqual(
      []
    );
  });
});
