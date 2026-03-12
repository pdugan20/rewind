import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TraktClient } from './client.js';

describe('TraktClient', () => {
  let client: TraktClient;

  beforeEach(() => {
    client = new TraktClient('test-access-token', 'test-client-id');
    vi.restoreAllMocks();
  });

  it('should construct with accessToken and clientId', () => {
    expect(client).toBeDefined();
  });

  it('should send correct headers when fetching collection', async () => {
    const mockResponse: [] = [];

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(mockResponse)));

    await client.getCollection();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('/sync/collection/movies?extended=metadata');
    expect((options as RequestInit).headers).toEqual(
      expect.objectContaining({
        'trakt-api-version': '2',
        'trakt-api-key': 'test-client-id',
        Authorization: 'Bearer test-access-token',
        'Content-Type': 'application/json',
      })
    );
  });

  it('should return parsed collection items', async () => {
    const mockCollection = [
      {
        collected_at: '2024-06-15T12:00:00.000Z',
        updated_at: '2024-06-15T12:00:00.000Z',
        movie: {
          title: 'The Matrix',
          year: 1999,
          ids: {
            trakt: 481,
            slug: 'the-matrix-1999',
            imdb: 'tt0133093',
            tmdb: 603,
          },
        },
        metadata: {
          media_type: 'bluray',
          resolution: 'uhd_4k',
          hdr: 'dolby_vision',
          audio: 'dolby_atmos',
          audio_channels: '7.1',
          '3d': false,
        },
      },
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockCollection))
    );

    const items = await client.getCollection();
    expect(items).toHaveLength(1);
    expect(items[0].movie.title).toBe('The Matrix');
    expect(items[0].movie.ids.tmdb).toBe(603);
    expect(items[0].metadata.media_type).toBe('bluray');
  });

  it('should send POST with correct body when adding to collection', async () => {
    const mockResult = {
      added: { movies: 1 },
      updated: { movies: 0 },
      existing: { movies: 0 },
      not_found: { movies: [] },
    };

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(mockResult)));

    const input = [
      {
        ids: { tmdb: 603 },
        media_type: 'bluray',
        resolution: 'uhd_4k',
        hdr: 'dolby_vision',
        audio: 'dolby_atmos',
        audio_channels: '7.1',
        collected_at: '2024-06-15T12:00:00.000Z',
      },
    ];

    const result = await client.addToCollection(input);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.trakt.tv/sync/collection');
    expect((options as RequestInit).method).toBe('POST');

    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.movies).toHaveLength(1);
    expect(body.movies[0].ids).toEqual({ tmdb: 603 });
    expect(body.movies[0].media_type).toBe('bluray');
    expect(body.movies[0].collected_at).toBe('2024-06-15T12:00:00.000Z');

    expect(result.added.movies).toBe(1);
  });

  it('should send POST to correct endpoint when removing from collection', async () => {
    const mockResult = {
      added: { movies: 0 },
      updated: { movies: 0 },
      existing: { movies: 0 },
      not_found: { movies: [] },
    };

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(mockResult)));

    const input = [
      {
        ids: { tmdb: 603 },
        media_type: 'bluray',
      },
    ];

    await client.removeFromCollection(input);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.trakt.tv/sync/collection/remove');
    expect((options as RequestInit).method).toBe('POST');

    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.movies).toHaveLength(1);
    expect(body.movies[0].ids).toEqual({ tmdb: 603 });
    expect(body.movies[0].media_type).toBe('bluray');
  });

  it('should URL-encode the query when searching movies', async () => {
    const mockResults = [
      {
        type: 'movie',
        score: 100,
        movie: {
          title: 'The Lord of the Rings: The Fellowship of the Ring',
          year: 2001,
          ids: {
            trakt: 1,
            slug: 'the-lord-of-the-rings-the-fellowship-of-the-ring-2001',
            imdb: 'tt0120737',
            tmdb: 120,
          },
        },
      },
    ];

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(mockResults)));

    await client.searchMovie('Lord of the Rings: Fellowship');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('/search/movie?query=');
    expect(url).toContain(encodeURIComponent('Lord of the Rings: Fellowship'));
    expect(url).not.toContain(' ');
  });

  it('should handle rate limiting with retry', async () => {
    const rateLimitResponse = new Response('Rate limited', {
      status: 429,
      headers: { 'Retry-After': '1' },
    });

    const successResponse = new Response(JSON.stringify([]));

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rateLimitResponse)
      .mockResolvedValueOnce(successResponse);

    const result = await client.getCollection();
    expect(result).toEqual([]);
  });

  it('should throw on non-429 errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' })
    );

    await expect(client.getCollection()).rejects.toThrow(
      'Trakt API error: 404 Not Found'
    );
  });
});
