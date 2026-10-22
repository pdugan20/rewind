import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createDb, type Database } from '../db/client.js';
import {
  lastfmAlbumTracks,
  lastfmAlbums,
  lastfmArtists,
  lastfmScrobbles,
  lastfmTracks,
  listeningDiscmanSnapshots,
} from '../db/schema/lastfm.js';
import { images } from '../db/schema/system.js';
import { eq } from 'drizzle-orm';
import { createTestApiKey, setupTestDb } from '../test-helpers.js';
import { DiscmanSnapshot } from '../services/discman/schema.js';
import {
  buildDiscmanSnapshot,
  publishDiscmanSnapshot,
} from '../services/discman/snapshot.js';

const PREVIEW = (n: number) =>
  `https://audio-ssl.itunes.apple.com/itunes-assets/${n}.plus.aac.p.m4a`;

describe('GET /v1/listening/discman', () => {
  let db: Database;
  let token: string;
  let minute = 0;

  beforeAll(async () => {
    await setupTestDb();
    token = await createTestApiKey({ name: 'discman-read', scope: 'read' });
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    minute = 0;
    // Artwork rows reference albums, so they go first.
    await env.DB.exec('DELETE FROM cd_artwork_albums');
    await env.DB.exec('DELETE FROM cd_artwork_jobs');
    for (const table of [
      listeningDiscmanSnapshots,
      lastfmScrobbles,
      lastfmAlbumTracks,
      lastfmTracks,
      lastfmAlbums,
      lastfmArtists,
      images,
    ])
      await db.delete(table);
  });

  // Each call plays later than the previous one.
  async function seedAlbum(options: {
    artist: string;
    album: string;
    plays: string[];
    filtered?: string[];
    albumFiltered?: boolean;
    appleMusicId?: number;
    /** Apple previews for the played songs; on by default. */
    previews?: boolean;
    /** Disc art state; the shelf only lists albums with accepted art. */
    artwork?: 'accepted' | 'pending' | 'hidden' | 'none';
  }) {
    const [artist] = await db
      .insert(lastfmArtists)
      .values({
        name: options.artist,
        appleMusicUrl: `https://music.apple.com/us/artist/${options.artist}`,
        genre: 'rock',
      })
      .onConflictDoNothing()
      .returning();
    const artistId =
      artist?.id ??
      (await db.select().from(lastfmArtists)).find(
        (row) => row.name === options.artist
      )!.id;
    const [album] = await db
      .insert(lastfmAlbums)
      .values({
        name: options.album,
        artistId,
        appleMusicId: options.appleMusicId ?? null,
        appleMusicUrl: `https://music.apple.com/us/album/${options.appleMusicId ?? 1}`,
        isFiltered: options.albumFiltered ? 1 : 0,
      })
      .returning();
    const tracks = new Map<string, number>();
    for (const name of options.plays) {
      if (tracks.has(name)) continue;
      const [track] = await db
        .insert(lastfmTracks)
        .values({
          name,
          artistId,
          albumId: album.id,
          appleMusicUrl: `https://music.apple.com/us/album/${options.appleMusicId ?? 1}?i=${tracks.size + 100}`,
          previewUrl:
            options.previews === false ? null : PREVIEW(tracks.size + 100),
          isFiltered: options.filtered?.includes(name) ? 1 : 0,
        })
        .returning();
      tracks.set(name, track.id);
    }
    for (const name of options.plays) {
      minute++;
      await db.insert(lastfmScrobbles).values({
        trackId: tracks.get(name)!,
        scrobbledAt: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
      });
    }
    await attachArtwork(album.id, options.artwork ?? 'accepted');
    return album;
  }

  it('withholds a fallback preview that belongs to a different release', async () => {
    const album = await seedAlbum({
      artist: 'Synthetic Ensemble',
      album: 'Concert Recording (Live)',
      appleMusicId: 501,
      plays: ['Shared Song'],
    });
    await db
      .update(lastfmTracks)
      .set({
        appleMusicUrl:
          'https://music.apple.com/us/album/greatest-hits/999?i=100',
      })
      .where(eq(lastfmTracks.albumId, album.id));
    expect((await buildDiscmanSnapshot(db, 1)).albums).toHaveLength(0);
    await db
      .update(lastfmTracks)
      .set({
        appleMusicUrl: 'https://music.apple.com/us/album/concert/501?i=100',
      })
      .where(eq(lastfmTracks.albumId, album.id));
    expect((await buildDiscmanSnapshot(db, 1)).albums).toHaveLength(1);
  });

  async function attachArtwork(
    albumId: number,
    state: 'accepted' | 'pending' | 'hidden' | 'none'
  ) {
    if (state === 'none') return;
    const job = `job-${albumId}`;
    const now = new Date(Date.UTC(2026, 9, 1)).toISOString();
    await env.DB.prepare(
      "INSERT INTO cd_artwork_jobs (id,user_id,album_id,state,input,source_hash,source_key,source_mime,candidate_hash,provenance,updated_at,created_at) VALUES (?,1,?,?,'{}','s','k','image/png',?,'{}',?,?)"
    )
      .bind(
        job,
        albumId,
        state === 'pending' ? 'pending' : 'accepted',
        albumId.toString(16).padStart(64, '0'),
        now,
        now
      )
      .run();
    // Hidden art keeps its job but is no longer the album's active disc.
    await env.DB.prepare(
      "INSERT INTO cd_artwork_albums (user_id,album_id,release_id,medium_position,active_job,hidden_job,next_check) VALUES (1,?,'r',1,?,?,?)"
    )
      .bind(
        albumId,
        state === 'hidden' ? null : job,
        state === 'hidden' ? job : null,
        now
      )
      .run();
  }

  function get(headers: Record<string, string> = {}) {
    return SELF.fetch('http://localhost/v1/listening/discman', {
      headers: { Authorization: `Bearer ${token}`, ...headers },
    });
  }

  it('requires authentication', async () => {
    const res = await SELF.fetch('http://localhost/v1/listening/discman');
    expect(res.status).toBe(401);
  });

  it('orders albums newest first and caps the shelf at 12 with no time window', async () => {
    for (let i = 0; i < 14; i++)
      await seedAlbum({
        artist: `Artist ${i}`,
        album: `Album ${i}`,
        plays: ['A'],
      });
    const snapshot = await buildDiscmanSnapshot(db, 1);
    expect(snapshot.albums.map((a) => a.name)).toEqual(
      Array.from({ length: 12 }, (_, i) => `Album ${13 - i}`)
    );
  });

  it('lists only albums with accepted disc art, reaching past newer albums without it', async () => {
    await seedAlbum({ artist: 'Weezer', album: 'Pinkerton', plays: ['A'] });
    await seedAlbum({
      artist: 'Wilco',
      album: 'Star Wars',
      plays: ['B'],
      artwork: 'hidden',
    });
    await seedAlbum({
      artist: 'Pavement',
      album: 'Wowee Zowee',
      plays: ['C'],
      artwork: 'pending',
    });
    await seedAlbum({
      artist: 'Hole',
      album: 'Live Through This',
      plays: ['D'],
    });
    // A various-artists soundtrack files each artist as its own album, and
    // none of them has art yet.
    for (const artist of ['Harry Nilsson', 'Stealers Wheel', 'Joe Tex'])
      await seedAlbum({
        artist,
        album: 'Reservoir Dogs',
        plays: ['E', 'F'],
        artwork: 'none',
      });
    const snapshot = await buildDiscmanSnapshot(db, 1);
    expect(snapshot.albums.map((a) => a.name)).toEqual([
      'Live Through This',
      'Pinkerton',
    ]);
  });

  it('leaves out albums with no preview and fills the shelf from older ones', async () => {
    for (let i = 0; i < 13; i++)
      await seedAlbum({
        artist: `Artist ${i}`,
        album: `Album ${i}`,
        plays: ['A'],
      });
    // The newest album has disc art, but none of its songs has a preview.
    await seedAlbum({
      artist: 'JAY-Z',
      album: 'The Blueprint',
      plays: ['Breathe Easy', 'Takeover'],
      previews: false,
    });
    const snapshot = await buildDiscmanSnapshot(db, 1);
    expect(snapshot.albums.map((a) => a.name)).toEqual(
      Array.from({ length: 12 }, (_, i) => `Album ${12 - i}`)
    );
  });

  it('publishes an empty shelf when no album has accepted disc art', async () => {
    await seedAlbum({
      artist: 'Bedlam',
      album: 'Reservoir Dogs',
      plays: ['A'],
      artwork: 'none',
    });
    const snapshot = await buildDiscmanSnapshot(db, 1);
    expect(snapshot.albums).toEqual([]);
  });

  it('uses the catalog tracklist in disc/track order with per-song plays', async () => {
    const album = await seedAlbum({
      artist: 'Mudhoney',
      album: 'Superfuzz Bigmuff',
      plays: ['Mudride', 'Need', 'Mudride', 'Skit'],
      filtered: ['Skit'],
      appleMusicId: 101,
    });
    const song = (n: number, disc: number, name: string) => ({
      albumId: album.id,
      appleMusicId: 1000 + n,
      discNumber: disc,
      trackNumber: n,
      name,
      previewUrl: n === 3 ? null : PREVIEW(n),
      syncedAt: '2026-10-01T00:00:00.000Z',
    });
    await db
      .insert(lastfmAlbumTracks)
      .values([
        song(1, 2, 'Bonus'),
        song(1, 1, 'Need'),
        song(2, 1, 'Skit'),
        song(3, 1, 'Mudride'),
        song(4, 1, 'Unheard'),
      ]);

    const [shelf] = (await buildDiscmanSnapshot(db, 1)).albums;
    expect(shelf.tracklist_source).toBe('catalog');
    expect(
      shelf.tracks.map((t) => [
        t.position,
        t.disc_number,
        t.track_number,
        t.name,
      ])
    ).toEqual([
      [1, 1, 1, 'Need'],
      [2, 1, 3, 'Mudride'],
      [3, 1, 4, 'Unheard'],
      [4, 2, 1, 'Bonus'],
    ]);
    const mudride = shelf.tracks[1];
    expect(mudride.play_count).toBe(2);
    expect(mudride.track_id).not.toBeNull();
    // The catalog row has no preview, so the played track's preview fills in.
    expect(mudride.preview_url).toMatch(
      /^https:\/\/audio-ssl\.itunes\.apple\.com\//
    );
    expect(shelf.tracks[2]).toMatchObject({
      play_count: 0,
      last_played_at: null,
    });
    expect(shelf.play_count).toBe(3);
    expect(shelf.artist).toMatchObject({ name: 'Mudhoney', genre: 'rock' });
  });

  it('falls back to played songs and skips filtered albums', async () => {
    await seedAlbum({
      artist: 'Hidden',
      album: 'Audiobook',
      plays: ['Ch 1'],
      albumFiltered: true,
    });
    await seedAlbum({
      artist: 'Sleater-Kinney',
      album: 'Dig Me Out',
      plays: ['Dig Me Out', 'One More Hour'],
    });
    const snapshot = await buildDiscmanSnapshot(db, 1);
    expect(snapshot.albums.map((a) => a.name)).toEqual(['Dig Me Out']);
    const [album] = snapshot.albums;
    expect(album.tracklist_source).toBe('listens');
    expect(
      album.tracks.map((t) => [t.position, t.track_number, t.name])
    ).toEqual([
      [1, null, 'Dig Me Out'],
      [2, null, 'One More Hour'],
    ]);
  });

  it('includes every image size for albums and artists', async () => {
    const album = await seedAlbum({
      artist: 'Low',
      album: 'Things We Lost',
      plays: ['Medicine'],
    });
    await db.insert(images).values({
      domain: 'listening',
      entityType: 'albums',
      entityId: String(album.id),
      r2Key: `listening/albums/${album.id}/original.jpg`,
      source: 'test',
      thumbhash: 'AQID',
      imageVersion: 2,
    });
    const [shelf] = (await buildDiscmanSnapshot(db, 1)).albums;
    expect(shelf.image?.thumbhash).toBe('AQID');
    expect(shelf.image?.urls.thumbnail).toContain('width=64');
    expect(shelf.image?.urls.large).toContain('width=600');
    expect(shelf.artist.image).toBeNull();
  });

  it('serves the stored snapshot privately with ETag revalidation', async () => {
    await seedAlbum({
      artist: 'Low',
      album: 'Things We Lost',
      plays: ['Medicine'],
    });
    await publishDiscmanSnapshot(db, 1);
    // A later play is invisible until the next publish.
    await seedAlbum({
      artist: 'Mudhoney',
      album: 'Superfuzz',
      plays: ['Need'],
    });

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=60');
    expect(res.headers.get('Vary')).toContain('Authorization');
    const body = DiscmanSnapshot.parse(await res.json());
    expect(body.albums.map((a) => a.name)).toEqual(['Things We Lost']);

    const etag = res.headers.get('ETag')!;
    expect(etag).toBeTruthy();
    expect((await get({ 'If-None-Match': etag })).status).toBe(304);
  });

  it('builds once inline before the first publish', async () => {
    await seedAlbum({
      artist: 'Low',
      album: 'Things We Lost',
      plays: ['Medicine'],
    });
    const res = await get();
    expect(res.status).toBe(200);
    const stored = await db.select().from(listeningDiscmanSnapshots);
    expect(stored).toHaveLength(1);
  });

  it('rebuilds a stored snapshot that no longer matches the contract', async () => {
    await seedAlbum({
      artist: 'Low',
      album: 'Things We Lost',
      plays: ['Medicine'],
    });
    await db.insert(listeningDiscmanSnapshots).values({
      userId: 1,
      snapshot: JSON.stringify({ schema_version: 0 }),
      builtAt: '2026-01-01T00:00:00.000Z',
    });
    const res = await get();
    expect(res.status).toBe(200);
    const body = DiscmanSnapshot.parse(await res.json());
    expect(body.albums.map((a) => a.name)).toEqual(['Things We Lost']);
  });

  it('keeps CORS and Vary on a 304 revalidation', async () => {
    await seedAlbum({ artist: 'Low', album: 'Things', plays: ['Medicine'] });
    const origin = { Origin: 'https://patdugan.me' };
    const res = await get(origin);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://patdugan.me'
    );
    const vary = res.headers.get('Vary') ?? '';
    expect(vary).toContain('Authorization');
    expect(vary).toContain('Origin');
    const revalidated = await get({
      ...origin,
      'If-None-Match': res.headers.get('ETag')!,
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://patdugan.me'
    );
    expect(revalidated.headers.get('Cache-Control')).toBe(
      'private, max-age=60'
    );
    expect(revalidated.headers.get('Vary')).toContain('Authorization');
  });

  it('nulls a zero stored duration instead of failing the shelf', async () => {
    const album = await seedAlbum({
      artist: 'Low',
      album: 'Things',
      plays: ['Medicine'],
    });
    await db
      .update(lastfmTracks)
      .set({ durationMs: 0 })
      .where(eq(lastfmTracks.albumId, album.id));
    const { albums } = await buildDiscmanSnapshot(db, 1);
    expect(albums).toHaveLength(1);
    expect(albums[0].tracks[0].duration_ms).toBeNull();
  });

  it('attaches each played song to one catalog row, preferring its catalog id', async () => {
    const album = await seedAlbum({
      artist: 'Mudhoney',
      album: 'Superfuzz Bigmuff',
      plays: ['Need', 'Need'],
      appleMusicId: 101,
    });
    // The played song is the disc 2 version of a title that also opens disc 1.
    await db
      .update(lastfmTracks)
      .set({ appleMusicId: 2001 })
      .where(eq(lastfmTracks.albumId, album.id));
    await db.insert(lastfmAlbumTracks).values(
      [
        [1001, 1],
        [2001, 2],
      ].map(([appleMusicId, discNumber]) => ({
        albumId: album.id,
        appleMusicId,
        discNumber,
        trackNumber: 1,
        name: 'Need',
        syncedAt: '2026-10-01T00:00:00.000Z',
      }))
    );
    const [shelf] = (await buildDiscmanSnapshot(db, 1)).albums;
    expect(
      shelf.tracks.map((t) => [t.disc_number, t.apple_music_id, t.play_count])
    ).toEqual([
      [1, 1001, 0],
      [2, 2001, 2],
    ]);
    const [track] = await db
      .select()
      .from(lastfmTracks)
      .where(eq(lastfmTracks.albumId, album.id));
    expect(shelf.tracks[1].track_id).toBe(track.id);
  });
});
