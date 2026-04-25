import { describe, it, expect } from 'vitest';
import { findExistingEvent, loadCanonicalEvent } from './load.js';
import type { CanonicalEvent } from './enrich.js';

// Track calls into the stub so tests can assert what the loader did.
interface DbCall {
  op: 'select' | 'insert' | 'update';
  table?: string;
  values?: unknown;
}

function makeDbStub(
  opts: {
    existing?: { id: number };
    events?: Array<{
      id: number;
      externalId: string | null;
      eventDate: string;
      venueId: number | null;
    }>;
  } = {}
) {
  const calls: DbCall[] = [];
  const events = opts.events ?? [];
  let nextId = 1000;

  return {
    select() {
      calls.push({ op: 'select' });
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  if (opts.existing) return Promise.resolve([opts.existing]);
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      // Identify table by checking column refs (drizzle objects).
      const t = table as Record<string, unknown>;
      const tableName = t?.attendedEvents
        ? 'attended_events'
        : t?.eventData
          ? 'attended_events'
          : t?.role
            ? 'attended_event_performers'
            : t?.totalPriceCents
              ? 'attended_event_tickets'
              : 'attended_event_sources';
      return {
        values(vals: { eventDate?: string; vendor?: string }) {
          calls.push({ op: 'insert', table: tableName, values: vals });
          return {
            returning() {
              const id = nextId++;
              if (vals.eventDate) {
                events.push({
                  id,
                  externalId: null,
                  eventDate: vals.eventDate,
                  venueId: null,
                });
              }
              return Promise.resolve([{ id, eventId: id }]);
            },
            onConflictDoNothing() {
              return {
                returning() {
                  const id = nextId++;
                  return Promise.resolve([{ id, eventId: id }]);
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(vals: unknown) {
          calls.push({ op: 'update', values: vals });
          return {
            where() {
              return Promise.resolve();
            },
          };
        },
      };
    },
    _calls: calls,
  };
}

const baseCanonical: CanonicalEvent = {
  category: 'sports',
  event_type: 'mlb_game',
  event_date: '2024-09-25',
  event_datetime: '2024-09-25T19:10:00-07:00',
  title: 'Mariners vs Astros',
  subtitle: null,
  venue_id: 1,
  external_id: '746331',
  external_source: 'mlb_stats_api',
  event_data: { league: 'mlb', season: 2024, home_score: 1, away_score: 8 },
  match_confidence: 1.0,
  performers: [],
  match_notes: [],
};

describe('loadCanonicalEvent', () => {
  it('INSERTs a new attended_events row when none exists', async () => {
    const db = makeDbStub();
    const result = await loadCanonicalEvent(baseCanonical, [], [], db as never);
    expect(result.action).toBe('inserted');
    expect(result.event_id).toBeGreaterThan(0);
    const insertCall = db._calls.find(
      (c) => c.op === 'insert' && c.table === 'attended_events'
    );
    expect(insertCall).toBeTruthy();
  });

  it('UPDATEs the existing row when found by external_id', async () => {
    const db = makeDbStub({ existing: { id: 42 } });
    const result = await loadCanonicalEvent(baseCanonical, [], [], db as never);
    expect(result.action).toBe('updated');
    expect(result.event_id).toBe(42);
    const updateCall = db._calls.find((c) => c.op === 'update');
    expect(updateCall).toBeTruthy();
  });

  it('inserts ticket rows when reservations supplied', async () => {
    const db = makeDbStub();
    const tickets = [
      {
        vendor: 'seatgeek' as const,
        reservation_number: '6P2-8YP454J',
        event_name: 'Mariners',
        event_start: null,
        venue_name: 'T-Mobile Park',
        venue_address: null,
        section: '183',
        row: '12',
        seat: '18',
        total_price_cents: 7290,
        currency: 'USD',
      },
      {
        vendor: 'seatgeek' as const,
        reservation_number: '6P2-8YP454J',
        event_name: 'Mariners',
        event_start: null,
        venue_name: 'T-Mobile Park',
        venue_address: null,
        section: '183',
        row: '12',
        seat: '19',
        total_price_cents: 7290,
        currency: 'USD',
      },
    ];
    const result = await loadCanonicalEvent(
      baseCanonical,
      tickets,
      [],
      db as never
    );
    expect(result.ticket_inserts).toBe(2);
  });

  it('skips tickets with vendor=unknown', async () => {
    const db = makeDbStub();
    const tickets = [
      {
        vendor: 'unknown' as const,
        reservation_number: 'X',
        event_name: 'X',
        event_start: null,
        venue_name: null,
        venue_address: null,
        section: null,
        row: null,
        seat: null,
        total_price_cents: null,
        currency: 'USD',
      },
    ];
    const result = await loadCanonicalEvent(
      baseCanonical,
      tickets,
      [],
      db as never
    );
    expect(result.ticket_inserts).toBe(0);
  });

  it('inserts performer links and updates source rows', async () => {
    const db = makeDbStub();
    const c = {
      ...baseCanonical,
      performers: [{ performer_id: 99, role: 'headliner' }],
    };
    const result = await loadCanonicalEvent(
      c,
      [],
      [{ source_type: 'gcal' as const, source_ref: 'evt-123' }],
      db as never
    );
    expect(result.performer_inserts).toBe(1);
    const sourceUpdate = db._calls.find(
      (call) =>
        call.op === 'update' &&
        (call.values as Record<string, unknown>)?.eventId !== undefined
    );
    expect(sourceUpdate).toBeTruthy();
  });

  it('coerces unknown category → arts on insert', async () => {
    const db = makeDbStub();
    const c: CanonicalEvent = {
      ...baseCanonical,
      category: 'unknown',
    };
    await loadCanonicalEvent(c, [], [], db as never);
    const insertCall = db._calls.find(
      (call) => call.op === 'insert' && call.table === 'attended_events'
    );
    const vals = insertCall?.values as Record<string, unknown>;
    expect(vals?.category).toBe('arts');
  });
});

describe('findExistingEvent', () => {
  it('returns null when neither external_id nor venue match', async () => {
    const db = makeDbStub();
    const result = await findExistingEvent(
      { ...baseCanonical, external_id: null, venue_id: null },
      db as never
    );
    expect(result).toBeNull();
  });

  it('finds by external_id when present', async () => {
    const db = makeDbStub({ existing: { id: 7 } });
    const result = await findExistingEvent(baseCanonical, db as never);
    expect(result?.id).toBe(7);
  });
});
