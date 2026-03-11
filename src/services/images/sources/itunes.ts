/**
 * iTunes Search API source client.
 * Fallback source for album art. Searches by artist + album name.
 * No authentication required. Rate limit ~20 req/min.
 */

import type { ImageResult, SourceClient, SourceSearchParams } from './types.js';

const BASE_URL = 'https://itunes.apple.com/search';

export class ITunesClient implements SourceClient {
  name = 'itunes';

  async search(params: SourceSearchParams): Promise<ImageResult[]> {
    if (!params.artistName || !params.albumName) {
      return [];
    }

    try {
      const term = `${params.artistName} ${params.albumName}`;
      const url = new URL(BASE_URL);
      url.searchParams.set('term', term);
      url.searchParams.set('media', 'music');
      url.searchParams.set('entity', 'album');
      url.searchParams.set('limit', '3');

      const response = await fetch(url.toString());

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as ITunesResponse;
      const results: ImageResult[] = [];

      for (const result of data.results) {
        if (result.artworkUrl100) {
          // Replace 100x100 with high-res versions
          const highRes = result.artworkUrl100.replace(
            '100x100bb',
            '600x600bb'
          );
          results.push({
            source: this.name,
            url: highRes,
            width: 600,
            height: 600,
          });
        }
      }

      return results;
    } catch (error) {
      console.log(
        `[ERROR] iTunes search failed for "${params.artistName} - ${params.albumName}": ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }
}

interface ITunesResponse {
  resultCount: number;
  results: Array<{
    artworkUrl100?: string;
    collectionName?: string;
    artistName?: string;
  }>;
}
