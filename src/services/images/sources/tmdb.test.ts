import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TmdbClient } from './tmdb.js';

describe('TmdbClient', () => {
  let client: TmdbClient;

  beforeEach(() => {
    client = new TmdbClient('test-api-key');
    vi.restoreAllMocks();
  });

  it('has the correct name', () => {
    expect(client.name).toBe('tmdb');
  });

  it('returns empty array when API key is empty', async () => {
    const noKeyClient = new TmdbClient('');
    const results = await noKeyClient.search({
      domain: 'watching',
      entityType: 'movies',
      entityId: '27205',
    });
    expect(results).toEqual([]);
  });

  it('returns empty for non-watching domains', async () => {
    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'test-id',
    });
    expect(results).toEqual([]);
  });

  it('fetches movie posters and backdrops', async () => {
    const mockResponse = {
      posters: [{ file_path: '/poster.jpg', width: 2000, height: 3000 }],
      backdrops: [{ file_path: '/backdrop.jpg', width: 1920, height: 1080 }],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })
    );

    const results = await client.search({
      domain: 'watching',
      entityType: 'movies',
      entityId: '27205',
    });

    expect(results).toHaveLength(2);
    expect(results[0].url).toContain('image.tmdb.org');
    expect(results[0].url).toContain('/poster.jpg');
    expect(results[0].width).toBe(2000);
    expect(results[1].url).toContain('/backdrop.jpg');
  });

  it('falls back to movie detail for poster_path', async () => {
    const mockDetail = {
      poster_path: '/fallback-poster.jpg',
      backdrop_path: '/fallback-backdrop.jpg',
    };

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404 })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockDetail),
        })
    );

    const results = await client.search({
      domain: 'watching',
      entityType: 'movies',
      entityId: '27205',
    });

    expect(results).toHaveLength(2);
    expect(results[0].url).toContain('/fallback-poster.jpg');
  });

  it('returns empty array on total failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 })
    );

    const results = await client.search({
      domain: 'watching',
      entityType: 'movies',
      entityId: '99999',
    });

    expect(results).toEqual([]);
  });
});
