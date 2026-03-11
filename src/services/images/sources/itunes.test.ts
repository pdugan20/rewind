import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ITunesClient } from './itunes.js';

describe('ITunesClient', () => {
  let client: ITunesClient;

  beforeEach(() => {
    client = new ITunesClient();
    vi.restoreAllMocks();
  });

  it('has the correct name', () => {
    expect(client.name).toBe('itunes');
  });

  it('returns empty array when artist or album name is missing', async () => {
    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'test-id',
    });
    expect(results).toEqual([]);
  });

  it('searches for album art by artist and album name', async () => {
    const mockResponse = {
      resultCount: 1,
      results: [
        {
          artworkUrl100:
            'https://is1-ssl.mzstatic.com/image/thumb/Music/100x100bb.jpg',
          collectionName: 'Test Album',
          artistName: 'Test Artist',
        },
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
      entityType: 'albums',
      entityId: 'test-id',
      artistName: 'Test Artist',
      albumName: 'Test Album',
    });

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('itunes');
    expect(results[0].url).toContain('600x600bb');
    expect(results[0].width).toBe(600);
  });

  it('returns empty array on API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'test-id',
      artistName: 'Test Artist',
      albumName: 'Test Album',
    });

    expect(results).toEqual([]);
  });

  it('handles empty search results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ resultCount: 0, results: [] }),
      })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'test-id',
      artistName: 'Unknown Artist',
      albumName: 'Unknown Album',
    });

    expect(results).toEqual([]);
  });
});
