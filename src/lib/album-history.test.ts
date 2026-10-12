import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import {
  lastfmArtists,
  lastfmAlbums,
  lastfmTracks,
  lastfmScrobbles,
} from '../db/schema/lastfm.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';
import {
  albumTrackHistory,
  albumTrackHistoryQuery,
  artistAlbumHistory,
} from './album-history.js';

describe('selective album history', () => {
  let db: Database;
  beforeAll(setupTestDb);
  beforeEach(async () => {
    db = createDb(env.DB);
    for (const table of [
      'cd_artwork_checks',
      'cd_artwork_albums',
      'lastfm_scrobbles',
      'lastfm_tracks',
      'lastfm_albums',
      'lastfm_artists',
    ])
      await env.DB.prepare(`DELETE FROM ${table}`).run();
  });
  async function seed() {
    const [artist] = await db
      .insert(lastfmArtists)
      .values({ name: 'Synthetic' })
      .returning();
    const albums = await db
      .insert(lastfmAlbums)
      .values([
        { name: 'Original', artistId: artist.id },
        { name: 'Other release', artistId: artist.id },
      ])
      .returning();
    const tracks = await db
      .insert(lastfmTracks)
      .values([
        { name: 'Shared song', artistId: artist.id, albumId: albums[0].id },
        { name: 'Second song', artistId: artist.id, albumId: albums[0].id },
        { name: 'Unplayed', artistId: artist.id, albumId: albums[0].id },
        {
          name: 'Excluded',
          artistId: artist.id,
          albumId: albums[0].id,
          isFiltered: 1,
        },
      ])
      .returning();
    await db.insert(lastfmScrobbles).values([
      { trackId: tracks[0].id, scrobbledAt: '2026-01-01T00:00:00Z' },
      { trackId: tracks[1].id, scrobbledAt: '2026-01-02T00:00:00Z' },
      {
        trackId: tracks[0].id,
        albumId: albums[1].id,
        albumRecorded: 1,
        scrobbledAt: '2026-01-03T00:00:00Z',
      },
      {
        trackId: tracks[0].id,
        albumId: null,
        albumRecorded: 1,
        scrobbledAt: '2026-01-04T00:00:00Z',
      },
      {
        trackId: tracks[1].id,
        albumId: albums[1].id,
        albumRecorded: 1,
        scrobbledAt: '2026-01-05T00:00:00Z',
      },
      { trackId: tracks[3].id, scrobbledAt: '2025-01-01T00:00:00Z' },
    ]);
    return { artist, albums, tracks };
  }
  it('counts only events attributed to the requested album and preserves zero-play tracks', async () => {
    const { albums, tracks } = await seed();
    const old = await albumTrackHistory(db, albums[0].id, 1);
    expect(old.map((t) => [t.id, t.scrobbleCount])).toEqual([
      [tracks[0].id, 1],
      [tracks[1].id, 1],
      [tracks[2].id, 0],
    ]);
    const other = await albumTrackHistory(db, albums[1].id, 1);
    expect(other.map((t) => [t.id, t.scrobbleCount])).toEqual([
      [tracks[0].id, 1],
      [tracks[1].id, 1],
    ]);
    expect(other[0].firstScrobbledAt).toBe('2026-01-03T00:00:00Z');
    expect(
      await artistAlbumHistory(
        db,
        (await db.select().from(lastfmArtists))[0].id,
        1
      )
    ).toEqual(
      expect.arrayContaining(
        albums.map((a) => expect.objectContaining({ id: a.id, playcount: 2 }))
      )
    );
  });
  it('excludes foreign events and corrupt cross-owner relationships', async () => {
    const { artist, albums } = await seed();
    const [foreign] = await db
      .insert(lastfmArtists)
      .values({ name: 'Foreign', userId: 2 })
      .returning();
    const [song] = await db
      .insert(lastfmTracks)
      .values({ name: 'Foreign song', artistId: foreign.id, userId: 2 })
      .returning();
    await db.insert(lastfmScrobbles).values([
      {
        userId: 2,
        trackId: song.id,
        albumId: albums[1].id,
        albumRecorded: 1,
        scrobbledAt: '2026-02-01',
      },
      {
        userId: 1,
        trackId: song.id,
        albumId: albums[1].id,
        albumRecorded: 1,
        scrobbledAt: '2026-02-02',
      },
    ]);
    expect(await albumTrackHistory(db, albums[1].id, 2)).toHaveLength(0);
    expect(
      (await albumTrackHistory(db, albums[1].id, 1)).reduce(
        (n, t) => n + t.scrobbleCount,
        0
      )
    ).toBe(2);
    expect(
      (await artistAlbumHistory(db, artist.id, 1)).reduce(
        (n, a) => n + a.playcount,
        0
      )
    ).toBe(4);
  });
  it('does not infer default album membership from plays that explicitly name another album', async () => {
    const { artist, albums } = await seed();
    const [song] = await db
      .insert(lastfmTracks)
      .values({
        name: 'Snapshot only',
        artistId: artist.id,
        albumId: albums[0].id,
      })
      .returning();
    await db.insert(lastfmScrobbles).values({
      trackId: song.id,
      albumId: albums[1].id,
      albumRecorded: 1,
      scrobbledAt: '2026-03-01',
    });
    expect(
      (await albumTrackHistory(db, albums[0].id, 1)).some(
        (t) => t.id === song.id
      )
    ).toBe(false);
    expect(
      (await albumTrackHistory(db, albums[1].id, 1)).find(
        (t) => t.id === song.id
      )?.scrobbleCount
    ).toBe(1);
  });

  it('returns the combined count and first-date result through the production route', async () => {
    const { albums } = await seed();
    const token = await createTestApiKey();
    const response = await SELF.fetch(
      `https://example.com/v1/listening/albums/${albums[1].id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      first_scrobbled_at: string;
      tracks: Array<{ scrobble_count: number }>;
    };
    expect(body.first_scrobbled_at).toBe('2026-01-03T00:00:00Z');
    expect(body.tracks.map((t) => t.scrobble_count)).toEqual([1, 1]);
    const foreign = await createTestApiKey({ userId: 2 });
    expect(
      (
        await SELF.fetch(
          `https://example.com/v1/listening/albums/${albums[1].id}`,
          { headers: { Authorization: `Bearer ${foreign}` } }
        )
      ).status
    ).toBe(404);
  });
  it('uses album and track index searches for both attribution branches', async () => {
    const { albums } = await seed();
    const plan = await db.all<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN ${albumTrackHistoryQuery(albums[1].id, 1)}`
    );
    expect(
      plan.some((p) =>
        p.detail.includes('idx_lastfm_scrobbles_user_album_date')
      )
    ).toBe(true);
    expect(
      plan.some((p) =>
        p.detail.includes('idx_lastfm_scrobbles_user_track_date')
      )
    ).toBe(true);
    expect(plan.some((p) => /^SCAN s\b/.test(p.detail))).toBe(false);
  });
});
