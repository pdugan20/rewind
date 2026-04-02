/**
 * Deezer API source client.
 * No authentication required. Returns album covers up to 1200x1200
 * and artist images up to 1000x1000.
 */

import type { ImageResult, SourceClient, SourceSearchParams } from './types.js';
import {
  cleanArtistName,
  cleanAlbumName,
  artistMatches,
  albumMatches,
} from './utils.js';

const ALBUM_URL = 'https://api.deezer.com/search/album';
const ARTIST_URL = 'https://api.deezer.com/search/artist';

export class DeezerClient implements SourceClient {
  name = 'deezer';

  async search(params: SourceSearchParams): Promise<ImageResult[]> {
    try {
      if (params.entityType === 'artists') {
        return this.searchArtists(params);
      }
      return this.searchAlbums(params);
    } catch (error) {
      console.log(
        `[ERROR] Deezer search failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  private async searchAlbums(
    params: SourceSearchParams
  ): Promise<ImageResult[]> {
    if (!params.artistName || !params.albumName) {
      return [];
    }

    const artist = cleanArtistName(params.artistName);
    const term = `${artist} ${cleanAlbumName(params.albumName)}`;
    const url = new URL(ALBUM_URL);
    url.searchParams.set('q', term);
    url.searchParams.set('limit', '5');

    const response = await fetch(url.toString());

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as DeezerAlbumResponse;
    const results: ImageResult[] = [];

    for (const album of data.data ?? []) {
      if (!album.cover_xl) continue;

      // Validate artist and album name match
      if (
        album.artist?.name &&
        !artistMatches(params.artistName, album.artist.name)
      ) {
        continue;
      }
      if (
        album.title &&
        !albumMatches(params.albumName, album.title, params.artistName)
      ) {
        continue;
      }

      // cover_xl is 1000x1000 by default; swap to 1200x1200
      const highRes = album.cover_xl.replace('1000x1000', '1200x1200');
      results.push({
        source: this.name,
        url: highRes,
        width: 1200,
        height: 1200,
      });
    }

    return results;
  }

  private async searchArtists(
    params: SourceSearchParams
  ): Promise<ImageResult[]> {
    if (!params.artistName) {
      return [];
    }

    const artist = cleanArtistName(params.artistName);
    const url = new URL(ARTIST_URL);
    url.searchParams.set('q', artist);
    url.searchParams.set('limit', '5');

    const response = await fetch(url.toString());

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as DeezerArtistResponse;
    const results: ImageResult[] = [];

    for (const item of data.data ?? []) {
      if (!item.picture_xl) continue;

      // Validate artist name match
      if (item.name && !artistMatches(params.artistName, item.name)) {
        continue;
      }

      results.push({
        source: this.name,
        url: item.picture_xl,
        width: 1000,
        height: 1000,
      });
    }

    return results;
  }
}

interface DeezerAlbumResponse {
  data?: Array<{
    title?: string;
    artist?: { name?: string };
    cover_xl?: string;
  }>;
}

interface DeezerArtistResponse {
  data?: Array<{
    name?: string;
    picture_xl?: string;
  }>;
}
