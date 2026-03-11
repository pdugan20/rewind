/**
 * Plex transcode source client.
 * Fallback source for movie/show art when other sources fail.
 * Requires PLEX_URL and PLEX_TOKEN.
 */

import type { ImageResult, SourceClient, SourceSearchParams } from './types.js';

export class PlexClient implements SourceClient {
  name = 'plex';

  constructor(
    private plexUrl: string,
    private plexToken: string
  ) {}

  async search(params: SourceSearchParams): Promise<ImageResult[]> {
    if (!this.plexUrl || !this.plexToken || !params.plexThumbPath) {
      return [];
    }

    try {
      // Build the Plex transcode URL for a high-quality version
      const url = new URL(`${this.plexUrl}/photo/:/transcode`);
      url.searchParams.set('url', params.plexThumbPath);
      url.searchParams.set('width', '1000');
      url.searchParams.set('height', '1500');
      url.searchParams.set('X-Plex-Token', this.plexToken);

      // Verify the image is accessible
      const response = await fetch(url.toString(), { method: 'HEAD' });

      if (!response.ok) {
        return [];
      }

      return [
        {
          source: this.name,
          url: url.toString(),
          width: 1000,
          height: 1500,
        },
      ];
    } catch (error) {
      console.log(
        `[ERROR] Plex image lookup failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }
}
