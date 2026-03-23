/**
 * Shared types for image source clients.
 */

export interface ImageResult {
  source: string;
  url: string;
  width: number | null;
  height: number | null;
}

export interface SourceClient {
  name: string;
  search(params: SourceSearchParams): Promise<ImageResult[]>;
}

export interface SourceSearchParams {
  domain: string;
  entityType: string;
  entityId: string;
  /** Artist name for music lookups */
  artistName?: string;
  /** Album name for music lookups */
  albumName?: string;
  /** MusicBrainz ID */
  mbid?: string;
  /** TMDB ID for movie lookups */
  tmdbId?: string;
  /** IMDB ID for movie lookups */
  imdbId?: string;
  /** Plex thumb path for Plex fallback */
  plexThumbPath?: string;
  /** Article URL for OG image extraction */
  articleUrl?: string;
  /** Pre-resolved image URL (skips source client lookup) */
  directImageUrl?: string;
}
