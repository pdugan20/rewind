import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlexClient } from './plex.js';

describe('PlexClient', () => {
  let client: PlexClient;

  beforeEach(() => {
    client = new PlexClient('https://plex.example.com', 'test-token');
    vi.restoreAllMocks();
  });

  it('has the correct name', () => {
    expect(client.name).toBe('plex');
  });

  it('returns empty array when plex URL or token is missing', async () => {
    const noUrlClient = new PlexClient('', 'token');
    const results = await noUrlClient.search({
      domain: 'watching',
      entityType: 'movies',
      entityId: 'test-id',
      plexThumbPath: '/library/metadata/123/thumb',
    });
    expect(results).toEqual([]);
  });

  it('returns empty array when no plexThumbPath is provided', async () => {
    const results = await client.search({
      domain: 'watching',
      entityType: 'movies',
      entityId: 'test-id',
    });
    expect(results).toEqual([]);
  });

  it('returns image when Plex server is accessible', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const results = await client.search({
      domain: 'watching',
      entityType: 'movies',
      entityId: 'test-id',
      plexThumbPath: '/library/metadata/123/thumb',
    });

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('plex');
    expect(results[0].url).toContain('plex.example.com');
    expect(results[0].width).toBe(1000);
    expect(results[0].height).toBe(1500);
  });

  it('returns empty array when Plex server is not accessible', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 })
    );

    const results = await client.search({
      domain: 'watching',
      entityType: 'movies',
      entityId: 'test-id',
      plexThumbPath: '/library/metadata/123/thumb',
    });

    expect(results).toEqual([]);
  });

  it('handles network errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Connection refused'))
    );

    const results = await client.search({
      domain: 'watching',
      entityType: 'movies',
      entityId: 'test-id',
      plexThumbPath: '/library/metadata/123/thumb',
    });

    expect(results).toEqual([]);
  });
});
