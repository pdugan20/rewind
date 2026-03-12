import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CoverArtArchiveClient } from './cover-art-archive.js';

describe('CoverArtArchiveClient', () => {
  let client: CoverArtArchiveClient;

  beforeEach(() => {
    client = new CoverArtArchiveClient();
    vi.restoreAllMocks();
  });

  it('has the correct name', () => {
    expect(client.name).toBe('cover-art-archive');
  });

  it('returns empty array when no MBID is provided', async () => {
    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'test-id',
    });
    expect(results).toEqual([]);
  });

  it('fetches cover art for a valid MBID', async () => {
    const mockResponse = {
      images: [
        {
          front: true,
          image: 'https://coverartarchive.org/release/abc123/front.jpg',
          thumbnails: {
            '500': 'https://coverartarchive.org/release/abc123/front-500.jpg',
            '1200': 'https://coverartarchive.org/release/abc123/front-1200.jpg',
          },
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
      mbid: 'abc123',
    });

    expect(results).toHaveLength(2);
    expect(results[0].source).toBe('cover-art-archive');
    expect(results[0].url).toContain('front-1200.jpg');
    expect(results[0].width).toBe(1200);
    expect(results[1].width).toBe(500);
  });

  it('returns empty array on API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'test-id',
      mbid: 'nonexistent',
    });

    expect(results).toEqual([]);
  });

  it('returns empty array on network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error'))
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'test-id',
      mbid: 'abc123',
    });

    expect(results).toEqual([]);
  });

  it('skips non-front images', async () => {
    const mockResponse = {
      images: [
        {
          front: false,
          image: 'https://coverartarchive.org/release/abc123/back.jpg',
          thumbnails: {},
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
      mbid: 'abc123',
    });

    expect(results).toHaveLength(0);
  });
});
