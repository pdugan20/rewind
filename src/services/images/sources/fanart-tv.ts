/**
 * Fanart.tv source client.
 * Used for artist backgrounds/thumbnails and movie backgrounds/logos.
 * Requires FANART_TV_API_KEY.
 */

import type { ImageResult, SourceClient, SourceSearchParams } from './types.js';

const BASE_URL = 'https://webservice.fanart.tv/v3';

export class FanartTvClient implements SourceClient {
  name = 'fanart-tv';

  constructor(private apiKey: string) {}

  async search(params: SourceSearchParams): Promise<ImageResult[]> {
    if (!this.apiKey) {
      return [];
    }

    try {
      if (
        params.domain === 'listening' &&
        params.entityType === 'artists' &&
        params.mbid
      ) {
        return this.searchMusicArtist(params.mbid);
      }

      if (
        params.domain === 'watching' &&
        params.entityType === 'movies' &&
        params.tmdbId
      ) {
        return this.searchMovie(params.tmdbId);
      }

      return [];
    } catch (error) {
      console.log(
        `[ERROR] Fanart.tv search failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  private async searchMusicArtist(mbid: string): Promise<ImageResult[]> {
    const url = `${BASE_URL}/music/${mbid}?api_key=${this.apiKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as FanartMusicResponse;
    const results: ImageResult[] = [];

    // Artist thumbnails (1000x1000)
    if (data.artistthumb) {
      for (const thumb of data.artistthumb.slice(0, 3)) {
        results.push({
          source: this.name,
          url: thumb.url,
          width: 1000,
          height: 1000,
        });
      }
    }

    // Artist backgrounds (1920x1080)
    if (data.artistbackground) {
      for (const bg of data.artistbackground.slice(0, 2)) {
        results.push({
          source: this.name,
          url: bg.url,
          width: 1920,
          height: 1080,
        });
      }
    }

    return results;
  }

  private async searchMovie(tmdbId: string): Promise<ImageResult[]> {
    const url = `${BASE_URL}/movies/${tmdbId}?api_key=${this.apiKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as FanartMovieResponse;
    const results: ImageResult[] = [];

    // Movie posters
    if (data.movieposter) {
      for (const poster of data.movieposter.slice(0, 3)) {
        results.push({
          source: this.name,
          url: poster.url,
          width: 1000,
          height: 1426,
        });
      }
    }

    // Movie backgrounds
    if (data.moviebackground) {
      for (const bg of data.moviebackground.slice(0, 2)) {
        results.push({
          source: this.name,
          url: bg.url,
          width: 1920,
          height: 1080,
        });
      }
    }

    return results;
  }
}

interface FanartImage {
  id: string;
  url: string;
  likes: string;
}

interface FanartMusicResponse {
  artistthumb?: FanartImage[];
  artistbackground?: FanartImage[];
  hdmusiclogo?: FanartImage[];
  musicbanner?: FanartImage[];
}

interface FanartMovieResponse {
  movieposter?: FanartImage[];
  moviebackground?: FanartImage[];
  hdmovielogo?: FanartImage[];
  moviedisc?: FanartImage[];
  moviebanner?: FanartImage[];
}
