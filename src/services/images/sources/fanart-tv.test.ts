import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FanartTvClient } from './fanart-tv.js';

describe('FanartTvClient', () => {
  let client: FanartTvClient;

  beforeEach(() => {
    client = new FanartTvClient('test-api-key');
    vi.restoreAllMocks();
  });

  it('has the correct name', () => {
    expect(client.name).toBe('fanart-tv');
  });

  it('returns empty array when API key is empty', async () => {
    const noKeyClient = new FanartTvClient('');
    const results = await noKeyClient.search({
      domain: 'listening',
      entityType: 'artists',
      entityId: 'test-id',
      mbid: 'abc123',
    });
    expect(results).toEqual([]);
  });

  it('searches for artist thumbnails and backgrounds', async () => {
    const mockResponse = {
      artistthumb: [
        { id: '1', url: 'https://assets.fanart.tv/thumb1.jpg', likes: '10' },
      ],
      artistbackground: [
        { id: '2', url: 'https://assets.fanart.tv/bg1.jpg', likes: '5' },
      ],
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
      mbid: 'abc123',
    });

    expect(results).toHaveLength(2);
    expect(results[0].width).toBe(1000);
    expect(results[0].height).toBe(1000);
    expect(results[1].width).toBe(1920);
    expect(results[1].height).toBe(1080);
  });

  it('searches for movie posters and backgrounds', async () => {
    const mockResponse = {
      movieposter: [
        { id: '1', url: 'https://assets.fanart.tv/poster1.jpg', likes: '10' },
      ],
      moviebackground: [
        { id: '2', url: 'https://assets.fanart.tv/bg1.jpg', likes: '5' },
      ],
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
      entityId: 'test-id',
      tmdbId: '27205',
    });

    expect(results).toHaveLength(2);
    expect(results[0].width).toBe(1000);
    expect(results[0].height).toBe(1426);
  });

  it('returns empty array for unsupported domain/type combos', async () => {
    const results = await client.search({
      domain: 'collecting',
      entityType: 'releases',
      entityId: 'test-id',
    });
    expect(results).toEqual([]);
  });

  it('requires MBID for music artists', async () => {
    const results = await client.search({
      domain: 'listening',
      entityType: 'artists',
      entityId: 'test-id',
      artistName: 'Test Artist',
    });
    expect(results).toEqual([]);
  });
});
