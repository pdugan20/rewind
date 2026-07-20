import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FoursquareClient } from './client.js';

function checkinsResponse(
  items: unknown[],
  count: number
): Record<string, unknown> {
  return {
    meta: { code: 200, requestId: 'req' },
    response: { checkins: { count, items } },
  };
}

describe('FoursquareClient', () => {
  let client: FoursquareClient;

  beforeEach(() => {
    client = new FoursquareClient('test-oauth-token');
    vi.restoreAllMocks();
  });

  it('should construct with an access token', () => {
    expect(client).toBeDefined();
  });

  it('should request users/self/checkins with token, version, sort, and paging params', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(checkinsResponse([], 0))));

    await client.getCheckins({ offset: 500, limit: 250 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('https://api.foursquare.com/v2/users/self/checkins');
    expect(url).toContain('oauth_token=test-oauth-token');
    expect(url).toContain('v=20250101');
    expect(url).toContain('sort=oldestfirst');
    expect(url).toContain('limit=250');
    expect(url).toContain('offset=500');
  });

  it('should default to offset 0 and limit 250', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(checkinsResponse([], 0))));

    await client.getCheckins();

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('offset=0');
    expect(url).toContain('limit=250');
  });

  it('should send a browser-like User-Agent header', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(checkinsResponse([], 0))));

    await client.getCheckins();

    const [, options] = fetchSpy.mock.calls[0];
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('Mozilla/5.0');
  });

  it('should unwrap the response envelope into items and count', async () => {
    const item = {
      id: 'chk1',
      createdAt: 1735689600,
      shout: 'Great coffee',
      venue: {
        id: 'venue1',
        name: 'Victrola Coffee',
        categories: [{ name: 'Coffee Shop', primary: true }],
        location: {
          city: 'Seattle',
          state: 'WA',
          country: 'United States',
          lat: 47.61,
          lng: -122.32,
        },
      },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(checkinsResponse([item], 1234)))
    );

    const page = await client.getCheckins({ offset: 0, limit: 250 });

    expect(page.count).toBe(1234);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe('chk1');
    expect(page.items[0].createdAt).toBe(1735689600);
    expect(page.items[0].venue?.name).toBe('Victrola Coffee');
    expect(page.items[0].venue?.categories?.[0].primary).toBe(true);
    expect(page.items[0].venue?.location?.lat).toBe(47.61);
  });

  it('should tolerate legacy checkins with no venue', async () => {
    const item = { id: 'chk-legacy', createdAt: 1300000000 };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(checkinsResponse([item], 1)))
    );

    const page = await client.getCheckins();
    expect(page.items[0].venue).toBeUndefined();
  });

  it('should retry after a 429 rate limit response', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('Rate limited', {
          status: 429,
          headers: { 'Retry-After': '0' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(checkinsResponse([], 42)))
      );

    const page = await client.getCheckins();
    expect(page.count).toBe(42);
  });

  it('should throw on non-429 errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
    );

    await expect(client.getCheckins()).rejects.toThrow(
      'Foursquare API error: 401 Unauthorized'
    );
  });
});
