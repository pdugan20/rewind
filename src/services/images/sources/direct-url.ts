/**
 * Direct URL image source.
 *
 * Pass-through for callers that already have a fully-resolved image URL
 * (e.g. Letterboxd embeds a poster URL in the RSS description; the
 * Letterboxd sync passes that URL through `directImageUrl` so
 * TMDB-orphan TV entries still get a thumbnail).
 *
 * Domain-agnostic: returns the URL whenever `directImageUrl` is set,
 * regardless of which entity type is being processed.
 */

import type { ImageResult, SourceClient, SourceSearchParams } from './types.js';

export class DirectUrlClient implements SourceClient {
  name = 'direct-url';

  async search(params: SourceSearchParams): Promise<ImageResult[]> {
    if (!params.directImageUrl) return [];
    return [
      {
        source: this.name,
        url: params.directImageUrl,
        width: null,
        height: null,
      },
    ];
  }
}
