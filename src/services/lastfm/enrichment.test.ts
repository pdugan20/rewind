import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import { lastfmArtists } from '../../db/schema/lastfm.js';
import { setupTestDb } from '../../test-helpers.js';
import {
  enrichArtistBio,
  enrichArtistSimilar,
  stripLastfmBioLink,
} from './enrichment.js';
import type { LastfmClient } from './client.js';

function makeMockClient(overrides: Partial<LastfmClient> = {}): LastfmClient {
  return {
    getArtistInfo: async () => ({}),
    getArtistSimilar: async () => ({
      similarartists: { artist: [], '@attr': { artist: '' } },
    }),
    ...overrides,
  } as unknown as LastfmClient;
}

describe('stripLastfmBioLink', () => {
  it('removes the trailing Last.fm read-more link', () => {
    const input =
      'Olivia Rodrigo is an American singer-songwriter. <a href="https://www.last.fm/music/Olivia+Rodrigo">Read more on Last.fm</a>.';
    expect(stripLastfmBioLink(input)).toBe(
      'Olivia Rodrigo is an American singer-songwriter.'
    );
  });

  it('strips CDATA wrappers', () => {
    expect(stripLastfmBioLink('<![CDATA[hello]]>')).toBe('hello');
  });

  it('returns null for null/empty input', () => {
    expect(stripLastfmBioLink(null)).toBeNull();
    expect(stripLastfmBioLink('')).toBeNull();
  });
});

describe('enrichArtistBio', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(lastfmArtists);
  });

  it('persists bio_summary + bio_content + bio_synced_at', async () => {
    const [a] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Olivia Rodrigo',
        mbid: null,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();

    const client = makeMockClient({
      getArtistInfo: async () => ({
        artist: {
          name: 'Olivia Rodrigo',
          url: 'https://last.fm/x',
          bio: {
            summary: 'Pop singer. <a href="x">Read more on Last.fm</a>.',
            content:
              'Olivia Rodrigo is an American singer-songwriter. <a href="x">Read more on Last.fm</a>.',
          },
        },
      }),
    } as unknown as Partial<LastfmClient>);

    const out = await enrichArtistBio(db, client, {
      id: a.id,
      name: a.name,
      mbid: a.mbid ?? null,
    });
    expect(out.bio_summary).toBe('Pop singer.');
    expect(out.bio_content).toContain('American singer-songwriter');
    expect(out.bio_content).not.toContain('Read more on Last.fm');

    const [persisted] = await db
      .select()
      .from(lastfmArtists)
      .where(eq(lastfmArtists.id, a.id));
    expect(persisted.bioSummary).toBe('Pop singer.');
    expect(persisted.bioSyncedAt).toBeTruthy();
  });

  it('returns nulls + does not throw on Last.fm failure', async () => {
    const [a] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Failing Artist',
        mbid: null,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();

    const client = makeMockClient({
      getArtistInfo: async () => {
        throw new Error('Last.fm 503');
      },
    } as unknown as Partial<LastfmClient>);

    const out = await enrichArtistBio(db, client, {
      id: a.id,
      name: a.name,
      mbid: a.mbid ?? null,
    });
    expect(out.bio_summary).toBeNull();
    expect(out.bio_content).toBeNull();
  });
});

describe('enrichArtistSimilar', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(lastfmArtists);
  });

  it('intersects similar artists with the user listened-to set; drops non-matches', async () => {
    const now = new Date().toISOString();
    const [olivia] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Olivia Rodrigo',
        mbid: 'olivia-mbid',
        isFiltered: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [taylor] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Taylor Swift',
        mbid: 'taylor-mbid',
        playcount: 1842,
        isFiltered: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [lorde] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Lorde',
        mbid: null,
        playcount: 612,
        isFiltered: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const client = makeMockClient({
      getArtistSimilar: async () => ({
        similarartists: {
          artist: [
            // Match by mbid:
            {
              name: 'Taylor Swift',
              mbid: 'taylor-mbid',
              match: '0.91',
              url: 'https://last.fm/x',
              image: [],
            },
            // Match by case-insensitive name:
            {
              name: 'lorde',
              match: '0.78',
              url: 'https://last.fm/x',
              image: [],
            },
            // No local match — should be dropped:
            {
              name: 'Some Artist Not In My Library',
              mbid: 'unknown-mbid',
              match: '0.66',
              url: 'https://last.fm/x',
              image: [],
            },
          ],
          '@attr': { artist: 'Olivia Rodrigo' },
        },
      }),
    } as unknown as Partial<LastfmClient>);

    const out = await enrichArtistSimilar(db, client, {
      id: olivia.id,
      name: olivia.name,
      mbid: olivia.mbid ?? null,
    });
    expect(out.persisted).toBe(2);

    const [persisted] = await db
      .select()
      .from(lastfmArtists)
      .where(eq(lastfmArtists.id, olivia.id));
    const stored = JSON.parse(persisted.similarArtists ?? '[]');
    expect(
      stored.map((s: { artist_id: number }) => s.artist_id).sort()
    ).toEqual([taylor.id, lorde.id].sort());
    const taylorEntry = stored.find(
      (s: { artist_id: number }) => s.artist_id === taylor.id
    );
    expect(taylorEntry.similarity_score).toBeCloseTo(0.91);
    expect(persisted.similarSyncedAt).toBeTruthy();
  });

  it('persists empty array + sync timestamp when intersection is empty', async () => {
    const now = new Date().toISOString();
    const [a] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Solo Artist',
        mbid: null,
        isFiltered: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const client = makeMockClient({
      getArtistSimilar: async () => ({
        similarartists: {
          artist: [
            {
              name: 'Unknown 1',
              match: '0.5',
              url: 'https://last.fm/x',
              image: [],
            },
            {
              name: 'Unknown 2',
              match: '0.4',
              url: 'https://last.fm/x',
              image: [],
            },
          ],
          '@attr': { artist: 'Solo Artist' },
        },
      }),
    } as unknown as Partial<LastfmClient>);

    const out = await enrichArtistSimilar(db, client, {
      id: a.id,
      name: a.name,
      mbid: a.mbid ?? null,
    });
    expect(out.persisted).toBe(0);

    const [persisted] = await db
      .select()
      .from(lastfmArtists)
      .where(eq(lastfmArtists.id, a.id));
    expect(persisted.similarArtists).toBe('[]');
    expect(persisted.similarSyncedAt).toBeTruthy();
  });

  it('does not throw on Last.fm failure; still bumps similar_synced_at', async () => {
    const now = new Date().toISOString();
    const [a] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Failing',
        mbid: null,
        isFiltered: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const client = makeMockClient({
      getArtistSimilar: async () => {
        throw new Error('Last.fm 503');
      },
    } as unknown as Partial<LastfmClient>);

    const out = await enrichArtistSimilar(db, client, {
      id: a.id,
      name: a.name,
      mbid: a.mbid ?? null,
    });
    expect(out.persisted).toBe(0);

    const [persisted] = await db
      .select()
      .from(lastfmArtists)
      .where(eq(lastfmArtists.id, a.id));
    // Similar artists JSON not written on failure (only timestamp).
    expect(persisted.similarSyncedAt).toBeTruthy();
  });
});
