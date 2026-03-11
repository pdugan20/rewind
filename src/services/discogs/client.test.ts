import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscogsClient } from './client.js';

describe('DiscogsClient', () => {
  let client: DiscogsClient;

  beforeEach(() => {
    client = new DiscogsClient('test-token', 'testuser');
    vi.restoreAllMocks();
  });

  it('should construct with token and username', () => {
    expect(client).toBeDefined();
  });

  it('should send correct headers when fetching collection', async () => {
    const mockResponse = {
      pagination: { page: 1, pages: 1, per_page: 100, items: 0 },
      releases: [],
    };

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(mockResponse)));

    await client.getCollectionPage(1, 50);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('/users/testuser/collection/folders/0/releases');
    expect(url).toContain('page=1');
    expect(url).toContain('per_page=50');
    expect((options as RequestInit).headers).toEqual(
      expect.objectContaining({
        Authorization: 'Discogs token=test-token',
        'User-Agent': 'RewindAPI/1.0',
      })
    );
  });

  it('should paginate through all collection items', async () => {
    const page1Response = {
      pagination: { page: 1, pages: 2, per_page: 1, items: 2 },
      releases: [
        {
          instance_id: 1,
          folder_id: 0,
          rating: 5,
          date_added: '2024-01-01T00:00:00-00:00',
          basic_information: {
            id: 100,
            title: 'Test Album',
            year: 2020,
            resource_url: '',
            thumb: '',
            cover_image: '',
            artists: [{ id: 1, name: 'Test Artist', resource_url: '' }],
            labels: [{ name: 'Test Label', catno: 'TL001' }],
            formats: [{ name: 'Vinyl', qty: '1', descriptions: ['LP'] }],
            genres: ['Rock'],
            styles: ['Alternative'],
          },
        },
      ],
    };

    const page2Response = {
      pagination: { page: 2, pages: 2, per_page: 1, items: 2 },
      releases: [
        {
          instance_id: 2,
          folder_id: 0,
          rating: 4,
          date_added: '2024-02-01T00:00:00-00:00',
          basic_information: {
            id: 200,
            title: 'Another Album',
            year: 2021,
            resource_url: '',
            thumb: '',
            cover_image: '',
            artists: [{ id: 2, name: 'Another Artist', resource_url: '' }],
            labels: [],
            formats: [{ name: 'CD', qty: '1' }],
            genres: ['Electronic'],
            styles: [],
          },
        },
      ],
    };

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(page1Response)))
      .mockResolvedValueOnce(new Response(JSON.stringify(page2Response)));

    const items = await client.getAllCollectionItems();
    expect(items).toHaveLength(2);
    expect(items[0].basic_information.title).toBe('Test Album');
    expect(items[1].basic_information.title).toBe('Another Album');
  });

  it('should fetch wantlist items', async () => {
    const mockResponse = {
      pagination: { page: 1, pages: 1, per_page: 100, items: 1 },
      wants: [
        {
          id: 1,
          rating: 0,
          notes: '',
          date_added: '2024-03-01T00:00:00-00:00',
          basic_information: {
            id: 300,
            title: 'Wanted Album',
            year: 2023,
            resource_url: '',
            thumb: '',
            cover_image: '',
            artists: [{ id: 3, name: 'Wanted Artist' }],
            formats: [{ name: 'Vinyl', qty: '1' }],
            genres: ['Rock'],
            styles: [],
          },
        },
      ],
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse))
    );

    const items = await client.getAllWantlistItems();
    expect(items).toHaveLength(1);
    expect(items[0].basic_information.title).toBe('Wanted Album');
  });

  it('should fetch release details', async () => {
    const mockRelease = {
      id: 100,
      title: 'Test Album',
      year: 2020,
      uri: 'https://www.discogs.com/release/100',
      artists: [{ id: 1, name: 'Test Artist', resource_url: '' }],
      labels: [{ name: 'Test Label', catno: 'TL001' }],
      formats: [{ name: 'Vinyl', qty: '1', descriptions: ['LP'] }],
      genres: ['Rock'],
      styles: ['Alternative'],
      tracklist: [
        { position: 'A1', title: 'Track 1', duration: '3:30' },
        { position: 'A2', title: 'Track 2', duration: '4:15' },
      ],
      images: [
        {
          type: 'primary',
          uri: 'https://img.discogs.com/test.jpg',
          width: 600,
          height: 600,
        },
      ],
      country: 'US',
      community: { have: 1000, want: 500 },
      lowest_price: 25.0,
      num_for_sale: 42,
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockRelease))
    );

    const release = await client.getReleaseDetail(100);
    expect(release.title).toBe('Test Album');
    expect(release.tracklist).toHaveLength(2);
    expect(release.community.have).toBe(1000);
  });

  it('should handle rate limiting with retry', async () => {
    const rateLimitResponse = new Response('Rate limited', {
      status: 429,
      headers: { 'Retry-After': '1' },
    });

    const successResponse = new Response(
      JSON.stringify({
        pagination: { page: 1, pages: 1, per_page: 100, items: 0 },
        releases: [],
      })
    );

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rateLimitResponse)
      .mockResolvedValueOnce(successResponse);

    const result = await client.getCollectionPage();
    expect(result.releases).toEqual([]);
  });

  it('should throw on non-429 errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' })
    );

    await expect(client.getCollectionPage()).rejects.toThrow(
      'Discogs API error: 404 Not Found'
    );
  });
});
