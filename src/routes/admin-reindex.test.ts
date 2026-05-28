import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { readingItems } from '../db/schema/reading.js';
import {
  lastfmAlbums,
  lastfmArtists,
  lastfmTracks,
} from '../db/schema/lastfm.js';
import { setupTestDbWithFts5, createTestApiKey } from '../test-helpers.js';

describe('POST /v1/admin/reindex-search', () => {
  let adminToken: string;
  let readToken: string;

  beforeAll(async () => {
    await setupTestDbWithFts5();
    adminToken = await createTestApiKey({
      name: 'reindex-admin',
      scope: 'admin',
    });
    readToken = await createTestApiKey({
      name: 'reindex-read',
      scope: 'read',
    });
  });

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM search_index');
    try {
      await env.DB.exec('DELETE FROM reading_items');
    } catch {
      // table may not exist on some test runs
    }
  });

  it('rejects non-admin tokens', async () => {
    const res = await SELF.fetch('http://localhost/v1/admin/reindex-search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('reindexes reading items with description as subtitle', async () => {
    const db = createDb(env.DB);
    await db.insert(readingItems).values({
      userId: 1,
      source: 'instapaper',
      sourceId: 'test-1',
      title: "The Secret Weapon of 'S.N.L.'",
      description: 'A documentary about the writer Jim Downey.',
      status: 'unread',
      progress: 0,
      savedAt: '2026-04-01T00:00:00.000Z',
    });

    const res = await SELF.fetch('http://localhost/v1/admin/reindex-search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ domains: ['reading'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.domains.reading.indexed).toBe(1);

    // Verify the row is now searchable via the normalized match.
    const searchRes = await SELF.fetch(
      'http://localhost/v1/search?q=SNL+writer&domain=reading',
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    const searchBody = (await searchRes.json()) as any;
    expect(searchBody.data.length).toBe(1);
    expect(searchBody.data[0].title).toContain('snl');
  });

  it('streams listening across artist/album/track segments without buildAllThenSlice', async () => {
    const db = createDb(env.DB);
    await db.delete(lastfmTracks);
    await db.delete(lastfmAlbums);
    await db.delete(lastfmArtists);

    const [artist] = await db
      .insert(lastfmArtists)
      .values({ userId: 1, name: 'Pearl Jam', isFiltered: 0 })
      .returning();
    const [album] = await db
      .insert(lastfmAlbums)
      .values({
        userId: 1,
        name: 'MTV Unplugged',
        artistId: artist.id,
        isFiltered: 0,
      })
      .returning();
    await db.insert(lastfmTracks).values({
      userId: 1,
      name: 'Porch',
      artistId: artist.id,
      albumId: album.id,
      isFiltered: 0,
    });

    // Tiny chunk_size proves the segment cursor works across boundaries.
    const total = 3;
    for (let offset = 0; offset < total; offset += 1) {
      const res = await SELF.fetch('http://localhost/v1/admin/reindex-search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          domains: ['listening'],
          chunk_size: 1,
          chunk_offset: offset,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.domains.listening.total).toBe(total);
      expect(body.domains.listening.indexed).toBe(1);
    }

    const rows = await db.all<{ entity_type: string; title: string }>(
      sql`SELECT entity_type, title FROM search_index WHERE domain = 'listening' ORDER BY entity_type`
    );
    const byType = rows.reduce<Record<string, string[]>>((acc, r) => {
      (acc[r.entity_type] = acc[r.entity_type] ?? []).push(r.title);
      return acc;
    }, {});
    // search_index normalizes to lowercase before storing.
    expect(byType.artist).toEqual(['pearl jam']);
    expect(byType.album).toEqual(['mtv unplugged']);
    expect(byType.track).toEqual(['porch']);
  });

  it('uses joined artist name as subtitle for album + track rows', async () => {
    const db = createDb(env.DB);
    await db.delete(lastfmTracks);
    await db.delete(lastfmAlbums);
    await db.delete(lastfmArtists);

    const [artist] = await db
      .insert(lastfmArtists)
      .values({ userId: 1, name: 'Bob Dylan', isFiltered: 0 })
      .returning();
    const [album] = await db
      .insert(lastfmAlbums)
      .values({
        userId: 1,
        name: 'Blood on the Tracks',
        artistId: artist.id,
        isFiltered: 0,
      })
      .returning();
    await db.insert(lastfmTracks).values({
      userId: 1,
      name: 'Tangled Up in Blue',
      artistId: artist.id,
      albumId: album.id,
      isFiltered: 0,
    });

    const res = await SELF.fetch('http://localhost/v1/admin/reindex-search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ domains: ['listening'] }),
    });
    expect(res.status).toBe(200);

    const rows = await db.all<{ entity_type: string; subtitle: string | null }>(
      sql`SELECT entity_type, subtitle FROM search_index WHERE domain = 'listening'`
    );
    const albumSubtitle = rows.find((r) => r.entity_type === 'album')?.subtitle;
    const trackSubtitle = rows.find((r) => r.entity_type === 'track')?.subtitle;
    expect(albumSubtitle).toBe('bob dylan');
    expect(trackSubtitle).toBe('bob dylan');
  });

  it('defaults to all domains when body is empty', async () => {
    const res = await SELF.fetch('http://localhost/v1/admin/reindex-search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Object.keys(body.domains).sort()).toEqual(
      ['collecting', 'listening', 'reading', 'running', 'watching'].sort()
    );
  });
});
