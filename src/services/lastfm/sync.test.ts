import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createDb, type Database } from '../../db/client.js';
import {
  lastfmArtists,
  lastfmAlbums,
  lastfmTracks,
  lastfmScrobbles,
  lastfmYearlyStats,
} from '../../db/schema/lastfm.js';
import { setupTestDb } from '../../test-helpers.js';
import {
  syncRecentScrobbles,
  syncListening,
  syncYearlyStats,
  upsertAlbum,
  upsertArtist,
} from './sync.js';
import { VARIOUS_ARTISTS_MBID } from './constants.js';
import type { LastfmClient } from './client.js';
import { loadFilters } from './filters.js';
import { eq } from 'drizzle-orm';

describe('syncListening', () => {
  it('exports syncListening function', () => {
    expect(typeof syncListening).toBe('function');
  });
});

describe('syncRecentScrobbles audiobook filtering', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(lastfmYearlyStats);
    await db.delete(lastfmScrobbles);
    await db.delete(lastfmTracks);
    await db.delete(lastfmAlbums);
    await db.delete(lastfmArtists);
    await loadFilters(db);
  });

  it('cascades a numbered audiobook signature and omits it from feed/search candidates', async () => {
    const client = {
      getRecentTracks: async () => ({
        recenttracks: {
          track: [
            {
              artist: { mbid: '', '#text': 'Homer, Emily Wilson' },
              name: '001 - The Iliad (Wilson translation)',
              mbid: '',
              album: { mbid: '', '#text': 'The Iliad' },
              url: 'https://last.fm/test/iliad',
              date: { uts: '1785298519', '#text': '29 Jul 2026' },
              image: [],
            },
          ],
          '@attr': { totalPages: '1' },
        },
      }),
      getArtistTopTags: async () => {
        throw new Error('Artist not found');
      },
    } as unknown as LastfmClient;

    const result = await syncRecentScrobbles(db, client);

    const [artist] = await db.select().from(lastfmArtists);
    const [album] = await db.select().from(lastfmAlbums);
    const [track] = await db.select().from(lastfmTracks);

    expect(artist.isFiltered).toBe(1);
    expect(album.isFiltered).toBe(1);
    expect(track.isFiltered).toBe(1);
    expect(result.newArtists.size).toBe(0);
    expect(result.newAlbums.size).toBe(0);
  });
});

describe('syncYearlyStats', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(lastfmYearlyStats);
    await db.delete(lastfmScrobbles);
    await db.delete(lastfmTracks);
    await db.delete(lastfmAlbums);
    await db.delete(lastfmArtists);
  });

  it('aggregates per-year totals + correct distinct counts across years', async () => {
    const [artistA] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Artist A',
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [artistB] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Artist B',
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [albumA] = await db
      .insert(lastfmAlbums)
      .values({
        userId: 1,
        name: 'Album A',
        artistId: artistA.id,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [albumB] = await db
      .insert(lastfmAlbums)
      .values({
        userId: 1,
        name: 'Album B',
        artistId: artistB.id,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [trackA1] = await db
      .insert(lastfmTracks)
      .values({
        userId: 1,
        name: 'A1',
        artistId: artistA.id,
        albumId: albumA.id,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [trackB1] = await db
      .insert(lastfmTracks)
      .values({
        userId: 1,
        name: 'B1',
        artistId: artistB.id,
        albumId: albumB.id,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();

    await db.insert(lastfmScrobbles).values([
      // 2024: 3 plays of A, 1 play of B (4 total, 2 artists, 2 albums, 2 tracks)
      {
        userId: 1,
        trackId: trackA1.id,
        scrobbledAt: '2024-06-01T00:00:00Z',
        createdAt: new Date().toISOString(),
      },
      {
        userId: 1,
        trackId: trackA1.id,
        scrobbledAt: '2024-07-01T00:00:00Z',
        createdAt: new Date().toISOString(),
      },
      {
        userId: 1,
        trackId: trackA1.id,
        scrobbledAt: '2024-12-15T00:00:00Z',
        createdAt: new Date().toISOString(),
      },
      {
        userId: 1,
        trackId: trackB1.id,
        scrobbledAt: '2024-08-01T00:00:00Z',
        createdAt: new Date().toISOString(),
      },
      // 2025: 2 plays of A only (2 total, 1 artist, 1 album, 1 track)
      {
        userId: 1,
        trackId: trackA1.id,
        scrobbledAt: '2025-03-01T00:00:00Z',
        createdAt: new Date().toISOString(),
      },
      {
        userId: 1,
        trackId: trackA1.id,
        scrobbledAt: '2025-09-01T00:00:00Z',
        createdAt: new Date().toISOString(),
      },
    ]);

    const synced = await syncYearlyStats(db);
    expect(synced).toBe(2);

    const rows = await db
      .select()
      .from(lastfmYearlyStats)
      .where(eq(lastfmYearlyStats.userId, 1));
    const byYear = new Map(rows.map((r) => [r.year, r]));

    const y2024 = byYear.get(2024)!;
    expect(y2024.scrobbles).toBe(4);
    expect(y2024.uniqueArtists).toBe(2);
    expect(y2024.uniqueAlbums).toBe(2);
    expect(y2024.uniqueTracks).toBe(2);
    // Most-scrobbled artist in 2024 is Artist A (3 plays vs 1 for B).
    expect(y2024.topArtistId).toBe(artistA.id);

    const y2025 = byYear.get(2025)!;
    expect(y2025.scrobbles).toBe(2);
    expect(y2025.uniqueArtists).toBe(1);
    expect(y2025.uniqueTracks).toBe(1);
    expect(y2025.topArtistId).toBe(artistA.id);
  });

  it('upserts: re-running with new scrobbles updates the same row', async () => {
    const [artist] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Repeat',
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [track] = await db
      .insert(lastfmTracks)
      .values({
        userId: 1,
        name: 'Repeat Track',
        artistId: artist.id,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    await db.insert(lastfmScrobbles).values({
      userId: 1,
      trackId: track.id,
      scrobbledAt: '2025-01-01T00:00:00Z',
      createdAt: new Date().toISOString(),
    });

    await syncYearlyStats(db);
    const [first] = await db
      .select()
      .from(lastfmYearlyStats)
      .where(eq(lastfmYearlyStats.year, 2025));
    expect(first.scrobbles).toBe(1);

    await db.insert(lastfmScrobbles).values([
      {
        userId: 1,
        trackId: track.id,
        scrobbledAt: '2025-02-01T00:00:00Z',
        createdAt: new Date().toISOString(),
      },
      {
        userId: 1,
        trackId: track.id,
        scrobbledAt: '2025-03-01T00:00:00Z',
        createdAt: new Date().toISOString(),
      },
    ]);
    await syncYearlyStats(db);

    const allRows = await db
      .select()
      .from(lastfmYearlyStats)
      .where(eq(lastfmYearlyStats.year, 2025));
    expect(allRows).toHaveLength(1);
    expect(allRows[0].scrobbles).toBe(3);
  });

  it('excludes filtered tracks and artists', async () => {
    const [realArtist] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Real',
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [filteredArtist] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Filtered Artist',
        isFiltered: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [realTrack] = await db
      .insert(lastfmTracks)
      .values({
        userId: 1,
        name: 'Real Track',
        artistId: realArtist.id,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [filteredTrack] = await db
      .insert(lastfmTracks)
      .values({
        userId: 1,
        name: 'Skit',
        artistId: realArtist.id,
        isFiltered: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [trackByFilteredArtist] = await db
      .insert(lastfmTracks)
      .values({
        userId: 1,
        name: 'By Filtered Artist',
        artistId: filteredArtist.id,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();

    await db.insert(lastfmScrobbles).values([
      {
        userId: 1,
        trackId: realTrack.id,
        scrobbledAt: '2025-04-01T00:00:00Z',
        createdAt: new Date().toISOString(),
      },
      {
        userId: 1,
        trackId: filteredTrack.id,
        scrobbledAt: '2025-04-01T00:00:00Z',
        createdAt: new Date().toISOString(),
      },
      {
        userId: 1,
        trackId: trackByFilteredArtist.id,
        scrobbledAt: '2025-04-01T00:00:00Z',
        createdAt: new Date().toISOString(),
      },
    ]);

    await syncYearlyStats(db);
    const [row] = await db
      .select()
      .from(lastfmYearlyStats)
      .where(eq(lastfmYearlyStats.year, 2025));
    expect(row.scrobbles).toBe(1);
    expect(row.uniqueArtists).toBe(1);
    expect(row.uniqueTracks).toBe(1);
  });
});

describe('upsertAlbum - strict (name, artist_id) identity', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(lastfmScrobbles);
    await db.delete(lastfmTracks);
    await db.delete(lastfmAlbums);
    await db.delete(lastfmArtists);
    await loadFilters(db);
  });

  it('mints distinct album rows when two artists share an album name', async () => {
    const [pearlJam] = await db
      .insert(lastfmArtists)
      .values({ userId: 1, name: 'Pearl Jam', isFiltered: 0 })
      .returning();
    const [bobDylan] = await db
      .insert(lastfmArtists)
      .values({ userId: 1, name: 'Bob Dylan', isFiltered: 0 })
      .returning();

    const dylanAlbum = await upsertAlbum(
      db,
      'MTV Unplugged',
      bobDylan.id,
      null,
      'Bob Dylan'
    );
    expect(dylanAlbum.isNew).toBe(true);

    // A second artist's identically-named album must land in its own
    // row — strict (name, artist_id) identity, no cross-artist merge.
    const pearlJamAlbum = await upsertAlbum(
      db,
      'MTV Unplugged',
      pearlJam.id,
      null,
      'Pearl Jam'
    );

    expect(pearlJamAlbum.isNew).toBe(true);
    expect(pearlJamAlbum.id).not.toBe(dylanAlbum.id);

    const rows = await db
      .select()
      .from(lastfmAlbums)
      .where(eq(lastfmAlbums.name, 'MTV Unplugged'));
    expect(rows).toHaveLength(2);
    const artistIds = new Set(rows.map((r) => r.artistId));
    expect(artistIds).toEqual(new Set([bobDylan.id, pearlJam.id]));
  });

  it('returns the same row on repeat upsert for the same (name, artist_id)', async () => {
    const [artist] = await db
      .insert(lastfmArtists)
      .values({ userId: 1, name: 'Pearl Jam', isFiltered: 0 })
      .returning();

    const first = await upsertAlbum(db, 'Ten', artist.id, null, 'Pearl Jam');
    const second = await upsertAlbum(db, 'Ten', artist.id, null, 'Pearl Jam');

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);
  });
});

describe('upsertArtist - MBID-first lookup', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(lastfmScrobbles);
    await db.delete(lastfmTracks);
    await db.delete(lastfmAlbums);
    await db.delete(lastfmArtists);
    await loadFilters(db);
  });

  it('resolves to existing row by MBID even when scrobble carries a different name', async () => {
    const [canonical] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Various Artists',
        mbid: VARIOUS_ARTISTS_MBID,
        isFiltered: 0,
      })
      .returning();

    // Scrobble carries the canonical MBID but a casing-drifted display name.
    const result = await upsertArtist(
      db,
      'various artists',
      VARIOUS_ARTISTS_MBID
    );

    expect(result.isNew).toBe(false);
    expect(result.id).toBe(canonical.id);

    const rows = await db
      .select()
      .from(lastfmArtists)
      .where(eq(lastfmArtists.mbid, VARIOUS_ARTISTS_MBID));
    expect(rows).toHaveLength(1);
  });
});
