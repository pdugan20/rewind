import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import { lastfmArtists } from '../../db/schema/lastfm.js';
import { setupTestDb } from '../../test-helpers.js';
import {
  VARIOUS_ARTISTS_MBID,
  VARIOUS_ARTISTS_NAME,
  getVariousArtistsId,
} from './constants.js';

describe('Various Artists canonical row', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(() => {
    db = createDb(env.DB);
  });

  it('is seeded by migration 0038 with the canonical MBID', async () => {
    const [row] = await db
      .select()
      .from(lastfmArtists)
      .where(eq(lastfmArtists.mbid, VARIOUS_ARTISTS_MBID))
      .limit(1);

    expect(row).toBeDefined();
    expect(row.name).toBe(VARIOUS_ARTISTS_NAME);
    expect(row.isFiltered).toBe(0);
  });

  it('getVariousArtistsId resolves to the canonical row id', async () => {
    const id = await getVariousArtistsId(db);
    expect(id).not.toBeNull();

    const [row] = await db
      .select({ mbid: lastfmArtists.mbid })
      .from(lastfmArtists)
      .where(eq(lastfmArtists.id, id!))
      .limit(1);
    expect(row.mbid).toBe(VARIOUS_ARTISTS_MBID);
  });

  it('falls back to name lookup when no MBID match exists', async () => {
    await db
      .delete(lastfmArtists)
      .where(eq(lastfmArtists.mbid, VARIOUS_ARTISTS_MBID));

    const [renamed] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: VARIOUS_ARTISTS_NAME,
        mbid: null,
        isFiltered: 0,
      })
      .returning();

    const id = await getVariousArtistsId(db);
    expect(id).toBe(renamed.id);
  });
});
