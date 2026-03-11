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
    const url = `${API_BASE_URL}/movie/${tmdbId}/images`;
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

    // Add posters
    for (const poster of (data.posters ?? []).slice(0, 3)) {
      results.push({
        source: this.name,
        url: `${IMAGE_BASE_URL}/original${poster.file_path}`,
        width: poster.width,
        height: poster.height,
      });
    }

    // Add backdrops
    for (const backdrop of (data.backdrops ?? []).slice(0, 2)) {
      results.push({
        source: this.name,
        url: `${IMAGE_BASE_URL}/original${backdrop.file_path}`,
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
        url: `${IMAGE_BASE_URL}/original${data.poster_path}`,
        width: null,
        height: null,
      });
    }

    if (data.backdrop_path) {
      results.push({
        source: this.name,
        url: `${IMAGE_BASE_URL}/original${data.backdrop_path}`,
        width: null,
        height: null,
      });
    }

    return results;
  }

  private async searchTvImages(tmdbId: string): Promise<ImageResult[]> {
    const url = `${API_BASE_URL}/tv/${tmdbId}/images`;
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

    for (const poster of (data.posters ?? []).slice(0, 3)) {
      results.push({
        source: this.name,
        url: `${IMAGE_BASE_URL}/original${poster.file_path}`,
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
}

interface TmdbImagesResponse {
  posters?: TmdbImageEntry[];
  backdrops?: TmdbImageEntry[];
}

interface TmdbMovieDetail {
  poster_path: string | null;
  backdrop_path: string | null;
}
