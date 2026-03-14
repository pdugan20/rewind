/**
 * TMDB source client.
 * Primary source for movie posters and backdrops.
 * Uses poster_path/backdrop_path from TMDB API responses.
 */

import type { ImageResult, SourceClient, SourceSearchParams } from './types.js';

const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';
const API_BASE_URL = 'https://api.themoviedb.org/3';

export class TmdbClient implements SourceClient {
  name = 'tmdb';

  constructor(private apiKey: string) {}

  async search(params: SourceSearchParams): Promise<ImageResult[]> {
    if (!this.apiKey) {
      return [];
    }

    if (params.domain !== 'watching') {
      return [];
    }

    try {
      const tmdbId = params.tmdbId || params.entityId;

      if (params.entityType === 'movies') {
        return this.searchMovieImages(tmdbId);
      }

      if (params.entityType === 'shows') {
        return this.searchTvImages(tmdbId);
      }

      return [];
    } catch (error) {
      console.log(
        `[ERROR] TMDB image search failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  private async searchMovieImages(tmdbId: string): Promise<ImageResult[]> {
    const url = `${API_BASE_URL}/movie/${tmdbId}/images?include_image_language=en,null`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      // Fallback: try to get the movie detail for poster_path
      return this.getMoviePoster(tmdbId);
    }

    const data = (await response.json()) as TmdbImagesResponse;
    const results: ImageResult[] = [];

    // Posters: English first (has movie title text), then null as fallback
    const sortedPosters = sortByLanguage(data.posters ?? [], 'poster');
    for (const poster of sortedPosters.slice(0, 3)) {
      results.push({
        source: this.name,
        url: `${IMAGE_BASE_URL}/w780${poster.file_path}`,
        width: poster.width,
        height: poster.height,
      });
    }

    // Backdrops: textless (null) first, then English
    const sortedBackdrops = sortByLanguage(data.backdrops ?? [], 'backdrop');
    for (const backdrop of sortedBackdrops.slice(0, 2)) {
      results.push({
        source: this.name,
        url: `${IMAGE_BASE_URL}/w780${backdrop.file_path}`,
        width: backdrop.width,
        height: backdrop.height,
      });
    }

    return results;
  }

  private async getMoviePoster(tmdbId: string): Promise<ImageResult[]> {
    const url = `${API_BASE_URL}/movie/${tmdbId}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as TmdbMovieDetail;
    const results: ImageResult[] = [];

    if (data.poster_path) {
      results.push({
        source: this.name,
        url: `${IMAGE_BASE_URL}/w780${data.poster_path}`,
        width: null,
        height: null,
      });
    }

    if (data.backdrop_path) {
      results.push({
        source: this.name,
        url: `${IMAGE_BASE_URL}/w780${data.backdrop_path}`,
        width: null,
        height: null,
      });
    }

    return results;
  }

  private async searchTvImages(tmdbId: string): Promise<ImageResult[]> {
    const url = `${API_BASE_URL}/tv/${tmdbId}/images?include_image_language=en,null`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as TmdbImagesResponse;
    const results: ImageResult[] = [];

    const sortedPosters = sortByLanguage(data.posters ?? [], 'poster');
    for (const poster of sortedPosters.slice(0, 3)) {
      results.push({
        source: this.name,
        url: `${IMAGE_BASE_URL}/w780${poster.file_path}`,
        width: poster.width,
        height: poster.height,
      });
    }

    return results;
  }
}

interface TmdbImageEntry {
  file_path: string;
  width: number;
  height: number;
  iso_639_1: string | null;
}

interface TmdbImagesResponse {
  posters?: TmdbImageEntry[];
  backdrops?: TmdbImageEntry[];
}

interface TmdbMovieDetail {
  poster_path: string | null;
  backdrop_path: string | null;
}

/**
 * Sort images by language preference.
 * Posters: English first (has title text), then null (textless), then others.
 * Backdrops: null first (textless preferred), then English, then others.
 */
function sortByLanguage(
  images: TmdbImageEntry[],
  type: 'poster' | 'backdrop'
): TmdbImageEntry[] {
  return [...images].sort((a, b) => {
    const rank = (lang: string | null) => {
      if (type === 'poster') {
        return lang === 'en' ? 0 : lang === null ? 1 : 2;
      }
      return lang === null ? 0 : lang === 'en' ? 1 : 2;
    };
    return rank(a.iso_639_1) - rank(b.iso_639_1);
  });
}
