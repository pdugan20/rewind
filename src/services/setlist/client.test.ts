import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchSetlist, toSetlistDate } from './client.js';

describe('toSetlistDate', () => {
  it('YYYY-MM-DD → DD-MM-YYYY', () => {
    expect(toSetlistDate('2024-03-12')).toBe('12-03-2024');
    expect(toSetlistDate('2008-09-13')).toBe('13-09-2008');
  });
  it('throws on invalid format', () => {
    expect(() => toSetlistDate('03/12/2024')).toThrow();
    expect(() => toSetlistDate('2024-3-12')).toThrow();
  });
});

describe('searchSetlist', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when API key missing (no fetch made)', async () => {
    const result = await searchSetlist(undefined, {
      artistName: 'Phoebe Bridgers',
      date: '2024-03-12',
    });
    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('passes DD-MM-YYYY in the API call (not ISO)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ setlist: [] }), { status: 200 })
    );
    await searchSetlist('key', {
      artistName: 'Phoebe Bridgers',
      date: '2024-03-12',
    });
    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain('date=12-03-2024');
    expect(url).not.toContain('date=2024-03-12');
  });

  it('sends x-api-key header', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ setlist: [] }), { status: 200 })
    );
    await searchSetlist('test-key', {
      artistName: 'Test',
      date: '2024-01-01',
    });
    const init = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers.Accept).toBe('application/json');
  });

  it('parses a real-shape match', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          setlist: [
            {
              id: 'abc123',
              url: 'https://www.setlist.fm/setlist/phoebe-bridgers/2024/abc123.html',
              eventDate: '12-03-2024',
              artist: {
                mbid: 'b46f4498-bb95-4d2b-aa41-b2bbe48a4596',
                name: 'Phoebe Bridgers',
              },
              venue: {
                name: 'Climate Pledge Arena',
                city: { name: 'Seattle', country: { name: 'United States' } },
              },
              tour: { name: 'Reunion Tour' },
            },
          ],
        }),
        { status: 200 }
      )
    );
    const result = await searchSetlist('key', {
      artistName: 'Phoebe Bridgers',
      date: '2024-03-12',
    });
    expect(result).toMatchObject({
      setlist_id: 'abc123',
      artist_name: 'Phoebe Bridgers',
      artist_mbid: 'b46f4498-bb95-4d2b-aa41-b2bbe48a4596',
      venue_name: 'Climate Pledge Arena',
      venue_city: 'Seattle',
      tour_name: 'Reunion Tour',
      event_date: '2024-03-12',
    });
  });

  it('returns null on 404 (no-match)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response('not found', { status: 404 })
    );
    expect(
      await searchSetlist('key', { artistName: 'Obscure', date: '1999-12-31' })
    ).toBeNull();
  });

  it('returns null on empty setlist array', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ setlist: [] }), { status: 200 })
    );
    expect(
      await searchSetlist('key', { artistName: 'Test', date: '2024-01-01' })
    ).toBeNull();
  });

  it('throws on other non-2xx', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response('rate limited', { status: 429 })
    );
    await expect(
      searchSetlist('key', { artistName: 'X', date: '2024-01-01' })
    ).rejects.toThrow(/429/);
  });
});
