import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import {
  lastfmArtists,
  lastfmAlbums,
  lastfmTracks,
  lastfmScrobbles,
  lastfmTopTracks,
  lastfmAlbumAttributionAudit,
} from '../../db/schema/lastfm.js';
import { setupTestDb, createTestApiKey } from '../../test-helpers.js';
import {
  upsertAlbum,
  upsertArtist,
  syncRecentScrobbles,
  backfillScrobbles,
} from './sync.js';
import type { LastfmClient } from './client.js';
import { loadFilters } from './filters.js';
import { scrobbleAlbumId } from '../../lib/scrobble-album.js';

describe('event album identity', () => {
  let db: Database;
  beforeAll(setupTestDb);
  beforeEach(async () => {
    db = createDb(env.DB);
    for (const table of [
      'lastfm_album_attribution_audit',
      'cd_artwork_checks',
      'cd_artwork_albums',
      'lastfm_scrobbles',
      'lastfm_top_tracks',
      'lastfm_top_albums',
      'lastfm_top_artists',
      'lastfm_yearly_stats',
      'lastfm_monthly_stats',
      'lastfm_user_stats',
      'lastfm_tracks',
      'lastfm_albums',
      'lastfm_artists',
      'sync_runs',
    ])
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    await env.DB.prepare(
      "UPDATE cd_artwork_control SET enabled=1,enroll_since='2020-01-01T00:00:00Z' WHERE id=1"
    ).run();
    await loadFilters(db);
  });
  const raw = (album: string, time: number) => ({
    artist: { mbid: '', '#text': 'Synthetic' },
    name: 'Shared song',
    mbid: '',
    album: { mbid: '', '#text': album },
    url: 'https://example.com/song',
    date: { uts: String(time), '#text': '' },
    image: [],
  });
  function client(events: ReturnType<typeof raw>[]) {
    return {
      getRecentTracks: async () => ({
        recenttracks: { track: events, '@attr': { totalPages: '1' } },
      }),
      getArtistTopTags: async () => ({ toptags: { tag: [] } }),
    } as unknown as LastfmClient;
  }
  it('files later plays of an album the album check filed under Various Artists', async () => {
    const various = await upsertArtist(
      db,
      'Various Artists',
      '89ad4ac3-39f7-470e-963a-56509c546377'
    );
    const artist = await upsertArtist(db, 'Synthetic', null);
    const compilation = await upsertAlbum(
      db,
      'Soundtrack',
      various.id,
      null,
      'Various Artists'
    );
    const split = await upsertAlbum(
      db,
      'Soundtrack',
      artist.id,
      null,
      'Synthetic'
    );
    await db.insert(lastfmAlbumAttributionAudit).values({
      originalAlbumId: split.id,
      originalAlbumName: 'Soundtrack',
      originalArtistId: artist.id,
      action: 'FILE_UNDER_VARIOUS_ARTISTS',
      newAlbumId: compilation.id,
      newArtistId: various.id,
    });
    // A placeholder Various Artists album that already holds this artist's
    // play, but was never filed from their album, attracts nothing.
    const hits = await upsertAlbum(
      db,
      'Greatest Hits',
      various.id,
      null,
      'Various Artists'
    );
    const [old] = await db
      .insert(lastfmTracks)
      .values({ name: 'Old song', artistId: artist.id, albumId: hits.id })
      .returning();
    await db.insert(lastfmScrobbles).values({
      trackId: old.id,
      albumId: hits.id,
      albumRecorded: 1,
      scrobbledAt: '2020-01-01T00:00:00.000Z',
    });
    await syncRecentScrobbles(
      db,
      client([
        raw('Soundtrack', 1780000000),
        raw('Greatest Hits', 1780000100),
        raw('Other release', 1780000200),
      ])
    );
    const albums = await db.select().from(lastfmAlbums);
    const own = (name: string) =>
      albums.find((a) => a.name === name && a.artistId === artist.id)!.id;
    const plays = await db
      .select({ albumId: lastfmScrobbles.albumId })
      .from(lastfmScrobbles)
      .orderBy(lastfmScrobbles.scrobbledAt);
    expect(plays.map((play) => play.albumId)).toEqual([
      hits.id,
      compilation.id,
      own('Greatest Hits'),
      own('Other release'),
    ]);
  });
  it('preserves each reported album, legacy attribution and explicit absence through sync and replay', async () => {
    const artist = await upsertArtist(db, 'Synthetic', null);
    const original = await upsertAlbum(
      db,
      'Original',
      artist.id,
      null,
      'Synthetic'
    );
    const [song] = await db
      .insert(lastfmTracks)
      .values({
        name: 'Shared song',
        artistId: artist.id,
        albumId: original.id,
      })
      .returning();
    await db
      .insert(lastfmScrobbles)
      .values({ trackId: song.id, scrobbledAt: '2026-01-01T00:00:00.000Z' });
    const events = [
      raw('Other release', 1780000000),
      raw('Original', 1780000100),
      raw('', 1780000200),
    ];
    const first = await syncRecentScrobbles(db, client(events));
    const replay = await syncRecentScrobbles(db, client(events));
    expect(first.count).toBe(3);
    expect(replay.count).toBe(0);
    const [track] = await db.select().from(lastfmTracks);
    expect(track.albumId).toBe(original.id);
    const albums = await db.select().from(lastfmAlbums);
    const other = albums.find((a) => a.name === 'Other release')!;
    const rows = await db
      .select({ albumId: scrobbleAlbumId })
      .from(lastfmScrobbles)
      .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id));
    expect(rows.map((r) => r.albumId).sort()).toEqual(
      [original.id, original.id, other.id, null].sort()
    );
    const held = await env.DB.prepare(
      'SELECT album_id FROM cd_artwork_albums ORDER BY album_id'
    ).all<{ album_id: number }>();
    expect(held.results.map((r) => r.album_id)).toEqual(
      [original.id, other.id].sort((a, b) => a - b)
    );
    const token = await createTestApiKey();
    const res = await SELF.fetch(
      'https://example.com/v1/listening/recent?limit=10',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ album: { name: string } | null }>;
    };
    expect(body.data.map((r) => r.album?.name ?? null)).toEqual([
      null,
      'Original',
      'Other release',
      'Original',
    ]);
  });
  it('uses the latest event for cached song summaries and excludes another owner', async () => {
    const artist = await upsertArtist(db, 'Synthetic', null);
    const original = await upsertAlbum(
      db,
      'Original',
      artist.id,
      null,
      'Synthetic'
    );
    const other = await upsertAlbum(
      db,
      'Other release',
      artist.id,
      null,
      'Synthetic'
    );
    const [song] = await db
      .insert(lastfmTracks)
      .values({
        name: 'Shared song',
        artistId: artist.id,
        albumId: original.id,
      })
      .returning();
    await db.insert(lastfmScrobbles).values({
      trackId: song.id,
      albumId: other.id,
      albumRecorded: 1,
      scrobbledAt: '2026-02-01T00:00:00Z',
    });
    await db
      .insert(lastfmTopTracks)
      .values({ trackId: song.id, period: 'overall', rank: 1, playcount: 1 });
    const token = await createTestApiKey();
    const get = async (key: string) => {
      const res = await SELF.fetch(
        'https://example.com/v1/listening/top/tracks?period=overall',
        { headers: { Authorization: `Bearer ${key}` } }
      );
      expect(res.status).toBe(200);
      return (await res.json()) as {
        data: Array<{ album_id: number | null }>;
      };
    };
    expect((await get(token)).data[0].album_id).toBe(other.id);
    const foreign = await createTestApiKey({ userId: 2 });
    expect((await get(foreign)).data).toHaveLength(0);
    await db.insert(lastfmScrobbles).values({
      trackId: song.id,
      albumId: null,
      albumRecorded: 1,
      scrobbledAt: '2026-03-01T00:00:00Z',
    });
    expect((await get(token)).data[0].album_id).toBeNull();
  });

  it('backfill also snapshots the reported album', async () => {
    await backfillScrobbles(
      db,
      client([raw('Backfilled release', 1780000000)])
    );
    const [event] = await db.select().from(lastfmScrobbles);
    expect(event.albumRecorded).toBe(1);
    expect(event.albumId).not.toBeNull();
  });
  it('holds conflicting album MBIDs and does not replace established artist identity', async () => {
    const artist = await upsertArtist(db, 'Synthetic', 'artist-first');
    await upsertArtist(db, 'Synthetic', 'artist-other');
    const album = await upsertAlbum(
      db,
      'Same title',
      artist.id,
      'release-first',
      'Synthetic'
    );
    await upsertAlbum(
      db,
      'Same title',
      artist.id,
      'release-other',
      'Synthetic'
    );
    await upsertAlbum(
      db,
      'Same title',
      artist.id,
      'release-first',
      'Synthetic'
    );
    const [row] = await db.select().from(lastfmAlbums);
    const [a] = await db.select().from(lastfmArtists);
    expect(row.mbid).toBe('release-first');
    expect(row.identityConflict).toBe(1);
    expect(a.mbid).toBe('artist-first');
    expect(a.identityConflict).toBe(1);
    const [song] = await db
      .insert(lastfmTracks)
      .values({ name: 'song', artistId: artist.id, albumId: album.id })
      .returning();
    await db.insert(lastfmScrobbles).values({
      trackId: song.id,
      albumId: album.id,
      albumRecorded: 1,
      scrobbledAt: '2026-02-01T00:00:00Z',
    });
    expect(
      (await env.DB.prepare('SELECT album_id FROM cd_artwork_albums').all())
        .results
    ).toHaveLength(0);
  });
});
