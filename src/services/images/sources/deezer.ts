/**
 * Deezer API source client.
 * No authentication required. Returns album covers up to 1800x1800.
 * Used as primary fallback when Apple Music is unavailable.
 */

import type { ImageResult, SourceClient, SourceSearchParams } from './types.js';
import { cleanArtistName } from './utils.js';

const BASE_URL = 'https://api.deezer.com/search/album';

export class DeezerClient implements SourceClient {
  name = 'deezer';

  async search(params: SourceSearchParams): Promise<ImageResult[]> {
    if (!params.artistName || !params.albumName) {
      return [];
    }

    try {
      const artist = cleanArtistName(params.artistName);
      const term = `${artist} ${params.albumName}`;
      const url = new URL(BASE_URL);
      url.searchParams.set('q', term);
      url.searchParams.set('limit', '3');

      const response = await fetch(url.toString());

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as DeezerResponse;
      const results: ImageResult[] = [];

      for (const album of data.data ?? []) {
        if (album.cover_xl) {
          // cover_xl is 1000x1000 by default; swap to 1200x1200
          const highRes = album.cover_xl.replace('1000x1000', '1200x1200');
          results.push({
            source: this.name,
            url: highRes,
            width: 1200,
            height: 1200,
          });
        }
      }

      return results;
    } catch (error) {
      console.log(
        `[ERROR] Deezer search failed for "${params.artistName} - ${params.albumName}": ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }
}

interface DeezerResponse {
  data?: Array<{
    title?: string;
    artist?: { name?: string };
    cover_xl?: string;
  }>;
}
