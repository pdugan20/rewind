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
