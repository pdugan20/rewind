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
import { lastfmArtists } from '../../db/schema/lastfm.js';
import { setupTestDb } from '../../test-helpers.js';
import { enrichArtistsByName } from './enrich.js';

interface SeedArtist {
  name: string;
  playcount?: number;
  appleMusicUrl?: string | null;
  appleMusicId?: number | null;
  itunesEnrichedAt?: string | null;
  isFiltered?: number;
}

async function seedArtist(
  db: Database,
  artist: SeedArtist
): Promise<{ id: number }> {
  const [row] = await db
    .insert(lastfmArtists)
    .values({
      name: artist.name,
      playcount: artist.playcount ?? 0,
      appleMusicUrl: artist.appleMusicUrl ?? null,
      appleMusicId: artist.appleMusicId ?? null,
      itunesEnrichedAt: artist.itunesEnrichedAt ?? null,
      isFiltered: artist.isFiltered ?? 0,
    })
    .returning({ id: lastfmArtists.id });
  return { id: row.id };
}

function mockItunesResponse(results: Array<Record<string, unknown>>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          resultCount: results.length,
          results,
        }),
    })
  );
}

describe('enrichArtistsByName', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(lastfmArtists);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes apple_music_id + apple_music_url on a direct-artist match', async () => {
    const { id } = await seedArtist(db, { name: 'Silk Sonic', playcount: 20 });

    mockItunesResponse([
      {
        wrapperType: 'artist',
        artistId: 1540560524,
        artistName: 'Silk Sonic',
        artistLinkUrl:
          'https://music.apple.com/us/artist/silk-sonic/1540560524',
      },
    ]);

    const result = await enrichArtistsByName(db, 10);

    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(0);

    const [updated] = await db
      .select()
      .from(lastfmArtists)
      .where(eq(lastfmArtists.id, id));
    expect(updated.appleMusicId).toBe(1540560524);
    expect(updated.appleMusicUrl).toBe(
      'https://music.apple.com/us/artist/silk-sonic/1540560524'
    );
    expect(updated.itunesEnrichedAt).toBeTruthy();
  });

  it('falls back to artistViewUrl when artistLinkUrl is absent', async () => {
    const { id } = await seedArtist(db, { name: 'Legacy Artist' });

    mockItunesResponse([
      {
        wrapperType: 'artist',
        artistId: 12345,
        artistName: 'Legacy Artist',
        artistViewUrl: 'https://music.apple.com/us/artist/legacy/12345',
      },
    ]);

    await enrichArtistsByName(db, 10);

    const [updated] = await db
      .select()
      .from(lastfmArtists)
      .where(eq(lastfmArtists.id, id));
    expect(updated.appleMusicUrl).toBe(
      'https://music.apple.com/us/artist/legacy/12345'
    );
  });

  it('bumps itunes_enriched_at but leaves URL null on no_match', async () => {
    const { id } = await seedArtist(db, { name: 'Tunitas', playcount: 10 });

    mockItunesResponse([]);

    const result = await enrichArtistsByName(db, 10);

    expect(result.skipped).toBe(1);
    expect(result.succeeded).toBe(0);

    const [updated] = await db
      .select()
      .from(lastfmArtists)
      .where(eq(lastfmArtists.id, id));
    expect(updated.appleMusicUrl).toBeNull();
    expect(updated.appleMusicId).toBeNull();
    expect(updated.itunesEnrichedAt).toBeTruthy();
  });

  it('rejects name mismatches (artistMatches filter)', async () => {
    const { id } = await seedArtist(db, { name: 'The Beatles' });

    // iTunes returns a completely different artist
    mockItunesResponse([
      {
        wrapperType: 'artist',
        artistId: 999,
        artistName: 'Totally Unrelated Band',
        artistLinkUrl: 'https://music.apple.com/us/artist/unrelated/999',
      },
    ]);

    const result = await enrichArtistsByName(db, 10);

    expect(result.succeeded).toBe(0);
    expect(result.skipped).toBe(1);

    const [updated] = await db
      .select()
      .from(lastfmArtists)
      .where(eq(lastfmArtists.id, id));
    expect(updated.appleMusicUrl).toBeNull();
  });

  it('skips artists that already have apple_music_url set', async () => {
    await seedArtist(db, {
      name: 'Already Enriched',
      appleMusicUrl: 'https://music.apple.com/us/artist/existing/1',
      appleMusicId: 1,
      itunesEnrichedAt: new Date().toISOString(),
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ resultCount: 0, results: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichArtistsByName(db, 10);

    expect(result.total).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips filtered artists', async () => {
    await seedArtist(db, {
      name: 'Filtered Band',
      isFiltered: 1,
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichArtistsByName(db, 10);

    expect(result.total).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry artists enriched within the last 30 days', async () => {
    const fifteenDaysAgo = new Date(
      Date.now() - 15 * 24 * 60 * 60 * 1000
    ).toISOString();

    await seedArtist(db, {
      name: 'Recent No-Match',
      itunesEnrichedAt: fifteenDaysAgo,
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichArtistsByName(db, 10);

    expect(result.total).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries artists whose last attempt was more than 30 days ago', async () => {
    const fortyDaysAgo = new Date(
      Date.now() - 40 * 24 * 60 * 60 * 1000
    ).toISOString();

    const { id } = await seedArtist(db, {
      name: 'Stale No-Match',
      itunesEnrichedAt: fortyDaysAgo,
    });

    mockItunesResponse([
      {
        wrapperType: 'artist',
        artistId: 42,
        artistName: 'Stale No-Match',
        artistLinkUrl: 'https://music.apple.com/us/artist/stale/42',
      },
    ]);

    const result = await enrichArtistsByName(db, 10);

    expect(result.succeeded).toBe(1);
    const [updated] = await db
      .select()
      .from(lastfmArtists)
      .where(eq(lastfmArtists.id, id));
    expect(updated.appleMusicId).toBe(42);
  });

  it('never-tried rows sort ahead of retried rows (via tier)', async () => {
    const fortyDaysAgo = new Date(
      Date.now() - 40 * 24 * 60 * 60 * 1000
    ).toISOString();

    await seedArtist(db, {
      name: 'Old Retry',
      itunesEnrichedAt: fortyDaysAgo,
      playcount: 1000,
    });
    await seedArtist(db, { name: 'Fresh Untried', playcount: 5 });

    const terms: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string | URL) => {
        terms.push(new URL(url).searchParams.get('term') ?? '');
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ resultCount: 0, results: [] }),
        };
      })
    );

    await enrichArtistsByName(db, 10);

    // Fresh untried (low playcount) still comes before old retry (high playcount)
    expect(terms[0]).toBe('Fresh Untried');
    expect(terms[1]).toBe('Old Retry');
  });

  it('stops the batch early on a 403 rate-limit response', async () => {
    await seedArtist(db, { name: 'First Artist', playcount: 100 });
    await seedArtist(db, { name: 'Second Artist', playcount: 50 });
    await seedArtist(db, { name: 'Third Artist', playcount: 10 });

    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          return { ok: false, status: 403 };
        }
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              resultCount: 1,
              results: [
                {
                  wrapperType: 'artist',
                  artistId: callCount,
                  artistName:
                    callCount === 1 ? 'First Artist' : 'Never Reached',
                  artistLinkUrl: 'https://music.apple.com/us/artist/x/1',
                },
              ],
            }),
        };
      })
    );

    const result = await enrichArtistsByName(db, 10);

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(callCount).toBe(2); // Did NOT call for third artist
  });
});
