import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppleMusicClient } from './apple-music.js';

describe('AppleMusicClient', () => {
  let client: AppleMusicClient;

  beforeEach(() => {
    client = new AppleMusicClient('test-token');
    vi.restoreAllMocks();
  });

  it('has the correct name', () => {
    expect(client.name).toBe('apple-music');
  });

  it('returns empty array when token is empty', async () => {
    const noTokenClient = new AppleMusicClient('');
    const results = await noTokenClient.search({
      domain: 'listening',
      entityType: 'artists',
      entityId: 'test-id',
      artistName: 'Test Artist',
    });
    expect(results).toEqual([]);
  });

  it('searches for artist images', async () => {
    const mockResponse = {
      results: {
        artists: {
          data: [
            {
              attributes: {
                artwork: {
                  url: 'https://is1-ssl.mzstatic.com/image/thumb/Music/{w}x{h}bb.jpg',
                  width: 3000,
                  height: 3000,
                },
              },
            },
          ],
        },
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'artists',
      entityId: 'test-id',
      artistName: 'Test Artist',
    });

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('apple-music');
    expect(results[0].url).toContain('1000x1000');
    expect(results[0].width).toBe(1000);
  });

  it('searches for album art', async () => {
    const mockResponse = {
      results: {
        albums: {
          data: [
            {
              attributes: {
                artwork: {
                  url: 'https://is1-ssl.mzstatic.com/image/thumb/Music/{w}x{h}bb.jpg',
                  width: 3000,
                  height: 3000,
                },
              },
            },
          ],
        },
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'test-id',
      artistName: 'Test Artist',
      albumName: 'Test Album',
    });

    expect(results).toHaveLength(1);
    expect(results[0].url).toContain('1200x1200');
  });

  it('returns empty array for unsupported entity types', async () => {
    const results = await client.search({
      domain: 'listening',
      entityType: 'tracks',
      entityId: 'test-id',
    });
    expect(results).toEqual([]);
  });

  it('rewrites ampersand to "and" in artist search term', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: {
            artists: {
              data: [
                {
                  attributes: {
                    name: 'Matt and Kim',
                    artwork: {
                      url: 'https://example.com/{w}x{h}/img.jpg',
                    },
                  },
                },
              ],
            },
          },
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await client.search({
      domain: 'listening',
      entityType: 'artists',
      entityId: 'matt-kim',
      artistName: 'Matt & Kim',
    });

    expect(results).toHaveLength(1);
    const requestUrl = String(fetchMock.mock.calls[0][0]);
    // Apple Music's artist search should receive the spelled-out form,
    // not a literal ampersand. URL-encoded `&` would be `%26` either way,
    // but the term has been transformed to `Matt and Kim` first so the
    // upstream tokenizer behaves predictably.
    expect(requestUrl).toContain('term=Matt+and+Kim');
    expect(requestUrl).not.toContain('Matt+%26+Kim');
  });

  it('returns empty array on API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401 })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'artists',
      entityId: 'test-id',
      artistName: 'Test Artist',
    });

    expect(results).toEqual([]);
  });
});
