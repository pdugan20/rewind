/**
 * Cover Art Archive source client.
 * Primary source for album art. Uses MusicBrainz release MBIDs.
 * No authentication required. Soft rate limit of 1 req/sec.
 */

import type { ImageResult, SourceClient, SourceSearchParams } from './types.js';

const BASE_URL = 'https://coverartarchive.org';

export class CoverArtArchiveClient implements SourceClient {
  name = 'cover-art-archive';

  async search(params: SourceSearchParams): Promise<ImageResult[]> {
    if (!params.mbid) {
      return [];
    }

    try {
      const response = await fetch(`${BASE_URL}/release/${params.mbid}`, {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as CoverArtResponse;
      const results: ImageResult[] = [];

      for (const image of data.images) {
        if (image.front) {
          // Prefer pre-sized thumbnails over originals — our largest served
          // preset is 780px, so 1200px is plenty with headroom. Originals
          // can be 10+ MB and exceed Workers CPU limits during decode.
          if (image.thumbnails['1200']) {
            results.push({
              source: this.name,
              url: image.thumbnails['1200'],
              width: 1200,
              height: 1200,
            });
          }

          if (image.thumbnails['500']) {
            results.push({
              source: this.name,
              url: image.thumbnails['500'],
              width: 500,
              height: 500,
            });
          }

          // Fall back to original only if no thumbnails available
          if (!image.thumbnails['1200'] && !image.thumbnails['500']) {
            results.push({
              source: this.name,
              url: image.image,
              width: null,
              height: null,
            });
          }
        }
      }

      return results;
    } catch (error) {
      console.log(
        `[ERROR] Cover Art Archive lookup failed for MBID ${params.mbid}: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }
}

interface CoverArtResponse {
  images: Array<{
    front: boolean;
    image: string;
    thumbnails: Record<string, string>;
  }>;
}
