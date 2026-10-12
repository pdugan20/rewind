import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import { lastfmAlbums, lastfmArtists } from '../../db/schema/lastfm.js';
import { setupTestDb } from '../../test-helpers.js';
import {
  backfillAppleMusicAlbums,
  lazyEnrichAppleMusicAlbums,
} from './album.js';

describe('catalog album identity', () => {
  let db: Database;
  beforeAll(setupTestDb);
  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(lastfmAlbums);
    await db.delete(lastfmArtists);
  });
  afterEach(() => vi.unstubAllGlobals());
  async function seed(userId = 1) {
    const [artist] = await db
      .insert(lastfmArtists)
      .values({ name: 'Synthetic', userId })
      .returning();
    const [album] = await db
      .insert(lastfmAlbums)
      .values({
        name: 'Synthetic (White Album - Deluxe Edition)',
        artistId: artist.id,
        userId,
        appleMusicId: 101,
        releasedYear: 2016,
        totalTracks: 10,
      })
      .returning();
    return album;
  }
  function response(
    name = 'Synthetic (White Album)',
    artistName = 'Synthetic',
    status = 200
  ) {
    return {
      ok: status === 200,
      status,
      json: async () => ({
        data: [
          {
            id: '101',
            type: 'albums',
            attributes: {
              name,
              artistName,
              releaseDate: '2016-04-01',
              trackCount: 14,
            },
          },
        ],
      }),
    };
  }
  it('accepts verified identity and recognized editions', async () => {
    const album = await seed();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    expect(await backfillAppleMusicAlbums(db, 'synthetic-token')).toEqual({
      filled: 1,
      skipped: 0,
    });
    const [row] = await db
      .select()
      .from(lastfmAlbums)
      .where(eq(lastfmAlbums.id, album.id));
    expect(row.totalTracks).toBe(14);
  });
  it.each([
    ['different qualifier', 'Synthetic (Green Album)', 'Synthetic'],
    ['artist prefix', 'Synthetic (White Album)', 'Synthetic Orchestra'],
    ['missing artist', 'Synthetic (White Album)', ''],
    ['missing title', '', 'Synthetic'],
  ])(
    'holds %s without replacing stored metadata',
    async (_case, title, artist) => {
      const album = await seed();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(response(title, artist))
      );
      expect(await backfillAppleMusicAlbums(db, 'synthetic-token')).toEqual({
        filled: 0,
        skipped: 1,
      });
      const [row] = await db
        .select()
        .from(lastfmAlbums)
        .where(eq(lastfmAlbums.id, album.id));
      expect(row.releasedYear).toBe(2016);
      expect(row.totalTracks).toBe(10);
      expect(row.appleMusicEnrichedAt).not.toBeNull();
      expect(row.appleMusicId).toBe(101);
    }
  );
  it.each([401, 429, 503])(
    'preserves values and retry eligibility on HTTP %s',
    async (status) => {
      const album = await seed();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(response(undefined, undefined, status))
      );
      await backfillAppleMusicAlbums(db, 'synthetic-token');
      const [row] = await db
        .select()
        .from(lastfmAlbums)
        .where(eq(lastfmAlbums.id, album.id));
      expect(row.totalTracks).toBe(10);
      expect(row.appleMusicEnrichedAt).toBeNull();
      expect(row.updatedAt).toBe(album.updatedAt);
    }
  );
  it('preserves metadata and eligibility for a malformed catalog body', async () => {
    const album = await seed();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { invalid: true } }),
      })
    );
    await backfillAppleMusicAlbums(db, 'synthetic-token');
    const [row] = await db
      .select()
      .from(lastfmAlbums)
      .where(eq(lastfmAlbums.id, album.id));
    expect(row.totalTracks).toBe(10);
    expect(row.appleMusicEnrichedAt).toBeNull();
  });

  it('does not write against a binding changed during a fetch', async () => {
    const album = await seed();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await db
          .update(lastfmAlbums)
          .set({ appleMusicId: 202 })
          .where(eq(lastfmAlbums.id, album.id));
        return response();
      })
    );
    expect(await backfillAppleMusicAlbums(db, 'synthetic-token')).toEqual({
      filled: 0,
      skipped: 1,
    });
    const [row] = await db
      .select()
      .from(lastfmAlbums)
      .where(eq(lastfmAlbums.id, album.id));
    expect(row.totalTracks).toBe(10);
    expect(row.appleMusicEnrichedAt).toBeNull();
  });
  it('scopes lazy requests and scheduled batches to their owner', async () => {
    const foreign = await seed(2);
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await lazyEnrichAppleMusicAlbums(db, 'synthetic-token', [foreign.id])
    ).toEqual({ enriched: 0 });
    expect(await backfillAppleMusicAlbums(db, 'synthetic-token')).toEqual({
      filled: 0,
      skipped: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('holds conflicting established identifiers without a provider call', async () => {
    const album = await seed();
    await db
      .update(lastfmAlbums)
      .set({ identityConflict: 1 })
      .where(eq(lastfmAlbums.id, album.id));
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);
    expect(await backfillAppleMusicAlbums(db, 'synthetic-token')).toEqual({
      filled: 0,
      skipped: 0,
    });
    expect(mock).not.toHaveBeenCalled();
  });
});
