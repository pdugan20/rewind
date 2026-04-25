import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractCalendarCandidates } from './extract.js';
import type { CalendarEvent } from '../google/calendar-client.js';

// Mock the upstream modules so the extractor runs without a real DB or
// real Google credentials.
vi.mock('../google/auth.js', () => ({
  getGoogleAccessToken: vi.fn().mockResolvedValue('test-token'),
}));

const mockListCalendarEvents = vi.fn();
const mockReadSyncToken = vi.fn();
const mockWriteSyncToken = vi.fn();

vi.mock('../google/calendar-client.js', async () => {
  const actual = await vi.importActual<
    typeof import('../google/calendar-client.js')
  >('../google/calendar-client.js');
  return {
    ...actual,
    listCalendarEvents: (...args: unknown[]) => mockListCalendarEvents(...args),
  };
});

vi.mock('../google/calendar-sync-token.js', () => ({
  readCalendarSyncToken: () => mockReadSyncToken(),
  writeCalendarSyncToken: (db: unknown, token: string) =>
    mockWriteSyncToken(db, token),
}));

// Lightweight DB stub — the extractor uses
// db.insert().values().onConflictDoNothing().returning(), where
// `.returning()` resolves to an array of inserted rows (empty on conflict).
function makeDbStub(opts: { existingRefs?: Set<string> } = {}) {
  const existing = opts.existingRefs ?? new Set<string>();
  const inserts: Array<{ sourceRef: string }> = [];
  return {
    insert() {
      return {
        values(row: { sourceRef: string }) {
          return {
            onConflictDoNothing() {
              return {
                returning() {
                  if (existing.has(row.sourceRef)) {
                    return Promise.resolve([]);
                  }
                  existing.add(row.sourceRef);
                  inserts.push(row);
                  return Promise.resolve([{ id: inserts.length }]);
                },
              };
            },
          };
        },
      };
    },
    _inserts: inserts,
  };
}

const mariners: CalendarEvent = {
  id: 'evt-mariners',
  summary: 'Mariners vs Astros',
  location: 'T-Mobile Park',
  description: null,
  start: { dateTime: '2024-06-15T19:10:00-07:00' },
  end: { dateTime: '2024-06-15T22:10:00-07:00' },
  status: 'confirmed',
  htmlLink: 'https://calendar.google.com/...',
};
const lunch: CalendarEvent = {
  id: 'evt-lunch',
  summary: 'Lunch with Jess',
  location: 'Cafe X',
  description: null,
  start: { dateTime: '2024-06-15T12:00:00-07:00' },
  end: { dateTime: '2024-06-15T13:00:00-07:00' },
  status: 'confirmed',
  htmlLink: null,
};
const cancelledShow: CalendarEvent = {
  id: 'evt-cancelled',
  summary: 'Concert at Showbox',
  location: 'Showbox SoDo',
  description: null,
  start: { dateTime: '2024-06-20T20:00:00-07:00' },
  end: { dateTime: '2024-06-20T23:00:00-07:00' },
  status: 'cancelled',
  htmlLink: null,
};

describe('extractCalendarCandidates', () => {
  beforeEach(() => {
    mockListCalendarEvents.mockReset();
    mockReadSyncToken.mockReset();
    mockWriteSyncToken.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('filters non-matching events and inserts matched ones', async () => {
    mockReadSyncToken.mockResolvedValueOnce(null);
    mockListCalendarEvents.mockResolvedValueOnce({
      events: [mariners, lunch],
      nextSyncToken: 'sync-1',
    });

    const db = makeDbStub();
    const result = await extractCalendarCandidates(db as never, {} as never, {
      timeMin: '2024-06-01T00:00:00Z',
      timeMax: '2024-07-01T00:00:00Z',
      mode: 'range',
    });

    expect(result.scanned).toBe(2);
    expect(result.matched).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.candidates[0].summary).toBe('Mariners vs Astros');
    expect(result.candidates[0].event_date).toBe('2024-06-15');
    expect(db._inserts).toHaveLength(1);
  });

  it('drops cancelled events even when allowlist matches', async () => {
    mockReadSyncToken.mockResolvedValueOnce(null);
    mockListCalendarEvents.mockResolvedValueOnce({
      events: [mariners, cancelledShow],
      nextSyncToken: 'sync-1',
    });

    const db = makeDbStub();
    const result = await extractCalendarCandidates(db as never, {} as never, {
      mode: 'range',
    });

    expect(result.matched).toBe(1);
    expect(result.candidates[0].source_ref).toBe('evt-mariners');
  });

  it('dryRun does not insert and does not write syncToken', async () => {
    mockReadSyncToken.mockResolvedValueOnce(null);
    mockListCalendarEvents.mockResolvedValueOnce({
      events: [mariners],
      nextSyncToken: 'sync-1',
    });

    const db = makeDbStub();
    const result = await extractCalendarCandidates(db as never, {} as never, {
      mode: 'range',
      dryRun: true,
    });

    expect(result.matched).toBe(1);
    expect(result.inserted).toBe(0);
    expect(db._inserts).toHaveLength(0);
    expect(mockWriteSyncToken).not.toHaveBeenCalled();
  });

  it('UNIQUE constraint violation does not throw — silently dedupes', async () => {
    mockReadSyncToken.mockResolvedValueOnce(null);
    mockListCalendarEvents.mockResolvedValueOnce({
      events: [mariners],
      nextSyncToken: 'sync-1',
    });

    const db = makeDbStub({ existingRefs: new Set(['evt-mariners']) });
    const result = await extractCalendarCandidates(db as never, {} as never, {
      mode: 'range',
    });

    expect(result.matched).toBe(1);
    expect(result.inserted).toBe(0); // collision swallowed
  });

  it('incremental mode passes stored syncToken and writes new one', async () => {
    mockReadSyncToken.mockResolvedValueOnce('stored-token');
    mockListCalendarEvents.mockResolvedValueOnce({
      events: [mariners],
      nextSyncToken: 'fresh-token',
    });

    const db = makeDbStub();
    await extractCalendarCandidates(db as never, {} as never, {
      mode: 'incremental',
    });

    const args = mockListCalendarEvents.mock.calls[0][1];
    expect(args).toMatchObject({ syncToken: 'stored-token' });
    expect(mockWriteSyncToken).toHaveBeenCalledWith(
      expect.anything(),
      'fresh-token'
    );
  });

  it('410 expiry triggers fallback range pull and self-heals', async () => {
    const { CalendarSyncTokenExpiredError } =
      await import('../google/calendar-client.js');

    mockReadSyncToken.mockResolvedValueOnce('stale-token');
    mockListCalendarEvents
      .mockRejectedValueOnce(new CalendarSyncTokenExpiredError())
      .mockResolvedValueOnce({
        events: [mariners],
        nextSyncToken: 'fresh-after-recovery',
      });

    const db = makeDbStub();
    const result = await extractCalendarCandidates(db as never, {} as never, {
      mode: 'incremental',
    });

    expect(result.resyncedFromExpiry).toBe(true);
    expect(result.matched).toBe(1);
    expect(mockListCalendarEvents).toHaveBeenCalledTimes(2);
    // Second call must use timeMin/timeMax, not syncToken
    const secondArgs = mockListCalendarEvents.mock.calls[1][1];
    expect(secondArgs.syncToken).toBeUndefined();
    expect(secondArgs.timeMin).toBeTruthy();
    expect(secondArgs.timeMax).toBeTruthy();
    expect(mockWriteSyncToken).toHaveBeenCalledWith(
      expect.anything(),
      'fresh-after-recovery'
    );
  });

  it('drains paginated results in one logical pull', async () => {
    mockReadSyncToken.mockResolvedValueOnce(null);
    mockListCalendarEvents
      .mockResolvedValueOnce({
        events: [mariners],
        nextPageToken: 'page-2',
      })
      .mockResolvedValueOnce({
        events: [lunch],
        nextSyncToken: 'sync-final',
      });

    const db = makeDbStub();
    const result = await extractCalendarCandidates(db as never, {} as never, {
      mode: 'range',
    });

    expect(result.scanned).toBe(2);
    expect(result.matched).toBe(1);
    expect(mockListCalendarEvents).toHaveBeenCalledTimes(2);
  });
});
