import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  listCalendarEvents,
  listAllCalendarEvents,
  CalendarSyncTokenExpiredError,
} from './calendar-client.js';

describe('Calendar client', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('range pull: sends timeMin + singleEvents=true + orderBy=startTime', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              id: 'evt1',
              summary: 'Mariners vs Astros',
              location: 'T-Mobile Park',
              start: { dateTime: '2024-06-15T19:10:00-07:00' },
              end: { dateTime: '2024-06-15T22:10:00-07:00' },
              status: 'confirmed',
            },
          ],
          nextSyncToken: 'sync-abc',
        }),
        { status: 200 }
      )
    );

    const result = await listCalendarEvents('access-token', {
      timeMin: '2024-06-01T00:00:00Z',
      timeMax: '2024-07-01T00:00:00Z',
      q: 'Mariners',
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].summary).toBe('Mariners vs Astros');
    expect(result.nextSyncToken).toBe('sync-abc');

    const calledUrl = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain('timeMin=2024-06-01');
    expect(calledUrl).toContain('singleEvents=true');
    expect(calledUrl).toContain('orderBy=startTime');
    expect(calledUrl).toContain('q=Mariners');
  });

  it('syncToken pull: omits timeMin/singleEvents/orderBy, sends syncToken', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], nextSyncToken: 'sync-xyz' }), {
        status: 200,
      })
    );

    await listCalendarEvents('tk', { syncToken: 'sync-prev' });

    const calledUrl = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain('syncToken=sync-prev');
    expect(calledUrl).not.toContain('singleEvents');
    expect(calledUrl).not.toContain('orderBy');
    expect(calledUrl).not.toContain('timeMin');
  });

  it('410 throws CalendarSyncTokenExpiredError', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response('Gone', { status: 410 })
    );
    await expect(
      listCalendarEvents('tk', { syncToken: 'expired' })
    ).rejects.toThrow(CalendarSyncTokenExpiredError);
  });

  it('non-200 (non-410) throws with status + body', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response('Bad request', { status: 400 })
    );
    await expect(
      listCalendarEvents('tk', { timeMin: '2024-01-01T00:00:00Z' })
    ).rejects.toThrow(/400.*Bad request/);
  });

  it('listAllCalendarEvents drains pages and returns final syncToken', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ id: 'a', start: {}, end: {} }],
            nextPageToken: 'pg2',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ id: 'b', start: {}, end: {} }],
            nextPageToken: 'pg3',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ id: 'c', start: {}, end: {} }],
            nextSyncToken: 'final-token',
          }),
          { status: 200 }
        )
      );

    const result = await listAllCalendarEvents('tk', {
      timeMin: '2024-01-01T00:00:00Z',
    });
    expect(result.events.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(result.nextSyncToken).toBe('final-token');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(3);
  });

  it('handles items missing optional fields without throwing', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [{ id: 'sparse' }], // no summary, no start/end
        }),
        { status: 200 }
      )
    );
    const result = await listCalendarEvents('tk', {
      timeMin: '2024-01-01T00:00:00Z',
    });
    expect(result.events[0].id).toBe('sparse');
    expect(result.events[0].summary).toBeNull();
    expect(result.events[0].start).toEqual({});
  });
});
