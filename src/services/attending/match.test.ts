import { describe, it, expect } from 'vitest';
import { extractVenueName, resolveVenue, resolvePerformer } from './match.js';

// In-memory venue store mimicking the seeded D1 row shape.
function makeVenuesStub(
  seed: Array<{ id: number; name: string; aliases: string | null }>
) {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve(seed);
            },
          };
        },
      };
    },
    insert() {
      return {
        values(row: { name: string }) {
          return {
            returning() {
              const id = seed.length + 1000;
              seed.push({ id, name: row.name, aliases: null });
              return Promise.resolve([{ id }]);
            },
          };
        },
      };
    },
  };
}

const seedVenues = [
  { id: 1, name: 'T-Mobile Park', aliases: '["Safeco Field"]' },
  { id: 2, name: 'Climate Pledge Arena', aliases: '["KeyArena"]' },
  {
    id: 3,
    name: 'Lumen Field',
    aliases: '["CenturyLink Field","Qwest Field"]',
  },
  {
    id: 4,
    name: 'Husky Stadium',
    aliases: '["Alaska Airlines Field at Husky Stadium"]',
  },
  { id: 5, name: 'Showbox SoDo', aliases: '[]' },
];

describe('extractVenueName', () => {
  it('takes everything before first newline', () => {
    expect(extractVenueName('T-Mobile Park\nSeattle, WA')).toBe(
      'T-Mobile Park'
    );
  });
  it('takes everything before first comma when no newline', () => {
    expect(extractVenueName('T-Mobile Park, Seattle, WA')).toBe(
      'T-Mobile Park'
    );
  });
  it('takes whichever comes first if both present', () => {
    expect(extractVenueName('Foo, Bar\nBaz')).toBe('Foo');
  });
  it('passes through clean single-line names', () => {
    expect(extractVenueName('Husky Stadium')).toBe('Husky Stadium');
  });
  it('trims whitespace', () => {
    expect(extractVenueName('  Lumen Field  ')).toBe('Lumen Field');
  });
});

describe('resolveVenue', () => {
  it('exact name match → confidence 1.0', async () => {
    const db = makeVenuesStub([...seedVenues]);
    const result = await resolveVenue('T-Mobile Park', db as never);
    expect(result).toEqual({
      venue_id: 1,
      confidence: 1.0,
      matched_via: 'name',
    });
  });

  it('case-insensitive name match', async () => {
    const db = makeVenuesStub([...seedVenues]);
    const result = await resolveVenue('t-mobile park', db as never);
    expect(result.venue_id).toBe(1);
    expect(result.confidence).toBe(1.0);
  });

  it('alias match (Safeco Field → T-Mobile Park) → confidence 0.95', async () => {
    const db = makeVenuesStub([...seedVenues]);
    const result = await resolveVenue('Safeco Field', db as never);
    expect(result).toEqual({
      venue_id: 1,
      confidence: 0.95,
      matched_via: 'alias',
    });
  });

  it('alias match: KeyArena → Climate Pledge Arena', async () => {
    const db = makeVenuesStub([...seedVenues]);
    const result = await resolveVenue('KeyArena', db as never);
    expect(result.venue_id).toBe(2);
    expect(result.matched_via).toBe('alias');
  });

  it('alias match for older Lumen Field aliases', async () => {
    const db = makeVenuesStub([...seedVenues]);
    expect(
      (await resolveVenue('CenturyLink Field', db as never)).venue_id
    ).toBe(3);
    expect((await resolveVenue('Qwest Field', db as never)).venue_id).toBe(3);
  });

  it('cleans calendar location format ("T-Mobile Park\\nSeattle, WA")', async () => {
    const db = makeVenuesStub([...seedVenues]);
    const result = await resolveVenue(
      'T-Mobile Park\nSeattle, WA',
      db as never
    );
    expect(result.venue_id).toBe(1);
    expect(result.confidence).toBe(1.0);
  });

  it('substring fallback (looser) when name extraction misses', async () => {
    const db = makeVenuesStub([...seedVenues]);
    // Hypothetical odd format that bypasses extractVenueName cleanup.
    const result = await resolveVenue(
      'Section A at Husky Stadium',
      db as never
    );
    expect(result.venue_id).toBe(4);
    expect(result.confidence).toBeLessThan(1.0);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('auto-creates a row for unknown venue, confidence 0.5', async () => {
    const seed = [...seedVenues];
    const db = makeVenuesStub(seed);
    const result = await resolveVenue('Yankee Stadium', db as never);
    expect(result.confidence).toBe(0.5);
    expect(result.matched_via).toBe('auto_created');
    expect(result.venue_id).toBeGreaterThan(0);
    // Stub assigned id = seed.length + 1000 (after seed's 5 → 1005)
    expect(seed.find((v) => v.id === result.venue_id)).toBeTruthy();
  });

  it('throws on empty input', async () => {
    const db = makeVenuesStub([...seedVenues]);
    await expect(resolveVenue('', db as never)).rejects.toThrow();
    await expect(resolveVenue('   ', db as never)).rejects.toThrow();
  });
});

// ─── resolvePerformer tests ─────────────────────────────────────────

interface PerformerRow {
  id: number;
  name: string;
  mbid: string | null;
  lastfmArtistId: number | null;
}
interface LastfmRow {
  id: number;
  name: string;
  mbid: string | null;
}

// Multi-table stub for performer flows. Discriminates by which table
// is passed to .from() so we can return the right rows for each query.
function makePerformerDbStub(opts: {
  performers?: PerformerRow[];
  lastfm?: LastfmRow[];
}) {
  const performersStore = opts.performers ?? [];
  const lastfmStore = opts.lastfm ?? [];
  const inserts: PerformerRow[] = [];

  function isPerformersTable(t: unknown): boolean {
    // Drizzle table objects have a [Symbol] tag; here we just check by
    // the table's known column member.
    const obj = t as Record<string, unknown>;
    return Boolean(obj?.lastfmArtistId);
  }

  return {
    select() {
      return {
        from(table: unknown) {
          const isPerformers = isPerformersTable(table);
          return {
            where() {
              return {
                limit() {
                  // Used for mbid lookup or first-row fetch in cross-probe
                  if (isPerformers) {
                    return Promise.resolve(performersStore);
                  }
                  return Promise.resolve(lastfmStore);
                },
                // No limit() — the resolver also calls .from().where()
                // without limit when fetching all performers.
                then(fn: (v: unknown) => unknown) {
                  return Promise.resolve(
                    isPerformers ? performersStore : lastfmStore
                  ).then(fn);
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(row: PerformerRow) {
          return {
            returning() {
              const id = performersStore.length + inserts.length + 1000;
              const created = { ...row, id };
              inserts.push(created);
              performersStore.push(created);
              return Promise.resolve([{ id }]);
            },
          };
        },
      };
    },
    _inserts: inserts,
  };
}

describe('resolvePerformer', () => {
  it('exact mbid match wins (no auto-create)', async () => {
    const db = makePerformerDbStub({
      performers: [
        {
          id: 5,
          name: 'Phoebe Bridgers',
          mbid: 'b46f4498-bb95-4d2b-aa41-b2bbe48a4596',
          lastfmArtistId: 42,
        },
      ],
    });
    const result = await resolvePerformer(
      'Phoebe Bridgers',
      'b46f4498-bb95-4d2b-aa41-b2bbe48a4596',
      db as never
    );
    expect(result).toEqual({
      performer_id: 5,
      matched_via: 'mbid',
      lastfm_artist_id: 42,
    });
    expect(db._inserts).toHaveLength(0);
  });

  it('exact name match (case-insensitive)', async () => {
    const db = makePerformerDbStub({
      performers: [{ id: 7, name: 'Odesza', mbid: null, lastfmArtistId: null }],
    });
    const result = await resolvePerformer('odesza', null, db as never);
    expect(result.performer_id).toBe(7);
    expect(result.matched_via).toBe('name');
  });

  it('cross-domain probe: name in lastfm_artists creates linked performer', async () => {
    const db = makePerformerDbStub({
      performers: [],
      lastfm: [{ id: 99, name: 'Phoebe Bridgers', mbid: 'mb-from-lastfm' }],
    });
    const result = await resolvePerformer('Phoebe Bridgers', null, db as never);
    expect(result.matched_via).toBe('lastfm_cross_domain');
    expect(result.lastfm_artist_id).toBe(99);
    expect(db._inserts).toHaveLength(1);
    expect(db._inserts[0].lastfmArtistId).toBe(99);
    expect(db._inserts[0].mbid).toBe('mb-from-lastfm');
  });

  it('auto-creates when no match anywhere', async () => {
    const db = makePerformerDbStub({ performers: [], lastfm: [] });
    const result = await resolvePerformer('Some New Band', null, db as never);
    expect(result.matched_via).toBe('auto_created');
    expect(result.lastfm_artist_id).toBeNull();
    expect(db._inserts[0].name).toBe('Some New Band');
  });

  it('throws on empty name', async () => {
    const db = makePerformerDbStub({});
    await expect(resolvePerformer('', null, db as never)).rejects.toThrow();
  });
});
