import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveImage, resolveAlternatives } from './pipeline.js';
import type { PipelineEnv } from './pipeline.js';

describe('pipeline', () => {
  let env: PipelineEnv;

  beforeEach(() => {
    vi.restoreAllMocks();
    env = {
      IMAGES: {} as R2Bucket,
      APPLE_MUSIC_DEVELOPER_TOKEN: 'test-apple-token',
      FANART_TV_API_KEY: 'test-fanart-key',
      TMDB_API_KEY: 'test-tmdb-key',
      PLEX_URL: 'https://plex.example.com',
      PLEX_TOKEN: 'test-plex-token',
    };
  });

  describe('resolveImage', () => {
    it('returns first successful result from waterfall', async () => {
      const mockResponse = {
        images: [
          {
            front: true,
            image: 'https://coverartarchive.org/release/abc123/front.jpg',
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

      const result = await resolveImage(
        {
          domain: 'listening',
          entityType: 'albums',
          entityId: 'test-id',
          mbid: 'abc123',
        },
        env
      );

      expect(result).not.toBeNull();
      expect(result!.source).toBe('cover-art-archive');
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
          // CoverArtArchive returns 404
          .mockResolvedValueOnce({ ok: false, status: 404 })
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
          mbid: 'bad-mbid',
          artistName: 'Test Artist',
          albumName: 'Test Album',
        },
        env
      );

      expect(result).not.toBeNull();
      expect(result!.source).toBe('itunes');
    });

    it('returns null when no sources match', async () => {
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

      expect(result).toBeNull();
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

      expect(result).not.toBeNull();
      expect(result!.source).toBe('tmdb');
    });
  });

  describe('resolveAlternatives', () => {
    it('collects results from all sources', async () => {
      // Mock all sources returning results
      let callCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // CoverArtArchive
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  images: [
                    {
                      front: true,
                      image: 'https://caa.org/front.jpg',
                      thumbnails: {},
                    },
                  ],
                }),
            });
          }
          if (callCount === 2) {
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
          }
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
        })
      );

      const results = await resolveAlternatives(
        {
          domain: 'listening',
          entityType: 'albums',
          entityId: 'test-id',
          mbid: 'abc123',
          artistName: 'Test Artist',
          albumName: 'Test Album',
        },
        env
      );

      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });
});
