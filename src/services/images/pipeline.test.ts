import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveImage, resolveAlternatives } from './pipeline.js';
import type { PipelineEnv } from './pipeline.js';

describe('pipeline', () => {
  let env: PipelineEnv;

  beforeEach(() => {
    vi.restoreAllMocks();
    env = {
      IMAGES: {} as R2Bucket,
      IMAGE_TRANSFORMS: {} as ImagesBinding,
      APPLE_MUSIC_DEVELOPER_TOKEN: 'test-apple-token',
      FANART_TV_API_KEY: 'test-fanart-key',
      TMDB_API_KEY: 'test-tmdb-key',
      PLEX_URL: 'https://plex.example.com',
      PLEX_TOKEN: 'test-plex-token',
    };
  });

  describe('resolveImage', () => {
    it('returns first successful result from waterfall', async () => {
      const appleMusicResponse = {
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
          json: () => Promise.resolve(appleMusicResponse),
        })
      );

      const result = await resolveImage(
        {
          domain: 'listening',
          entityType: 'albums',
          entityId: 'test-id',
          artistName: 'Test Artist',
          albumName: 'Test Album',
        },
        env
      );

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].source).toBe('apple-music');
    });

    it('falls through to next source when first fails', async () => {
      const itunesResponse = {
        resultCount: 1,
        results: [
          {
            artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100bb.jpg',
          },
        ],
      };

      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          // Apple Music fails
          .mockResolvedValueOnce({ ok: false, status: 500 })
          // Deezer fails
          .mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ data: [] }),
          })
          // iTunes succeeds
          .mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(itunesResponse),
          })
      );

      const result = await resolveImage(
        {
          domain: 'listening',
          entityType: 'albums',
          entityId: 'test-id',
          artistName: 'Test Artist',
          albumName: 'Test Album',
        },
        env
      );

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].source).toBe('itunes');
    });

    it('returns empty array when no sources match', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 404 })
      );

      const result = await resolveImage(
        {
          domain: 'listening',
          entityType: 'albums',
          entityId: 'test-id',
        },
        env
      );

      expect(result).toEqual([]);
    });

    it('uses TMDB for watching/movies domain', async () => {
      const tmdbResponse = {
        posters: [{ file_path: '/poster.jpg', width: 2000, height: 3000 }],
        backdrops: [],
      };

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(tmdbResponse),
        })
      );

      const result = await resolveImage(
        {
          domain: 'watching',
          entityType: 'movies',
          entityId: '27205',
          tmdbId: '27205',
        },
        env
      );

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].source).toBe('tmdb');
    });
  });

  describe('resolveAlternatives', () => {
    it('collects results from all sources', async () => {
      // Mock all sources returning results
      // Order: Apple Music, Deezer, iTunes
      let callCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // Apple Music
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  results: {
                    albums: {
                      data: [
                        {
                          attributes: {
                            artwork: {
                              url: 'https://apple.com/{w}x{h}bb.jpg',
                              width: 3000,
                              height: 3000,
                            },
                          },
                        },
                      ],
                    },
                  },
                }),
            });
          }
          if (callCount === 2) {
            // Deezer
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  data: [
                    {
                      cover_xl:
                        'https://cdn-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg',
                    },
                  ],
                }),
            });
          }
          // iTunes
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                resultCount: 1,
                results: [
                  {
                    artworkUrl100: 'https://itunes.com/100x100bb.jpg',
                  },
                ],
              }),
          });
        })
      );

      const results = await resolveAlternatives(
        {
          domain: 'listening',
          entityType: 'albums',
          entityId: 'test-id',
          artistName: 'Test Artist',
          albumName: 'Test Album',
        },
        env
      );

      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });
});
