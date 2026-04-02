/**
 * Apple Music API source client.
 * Used for artist images and high-res album art.
 * Requires APPLE_MUSIC_DEVELOPER_TOKEN (JWT).
 */

import type { ImageResult, SourceClient, SourceSearchParams } from './types.js';
import {
  cleanArtistName,
  cleanAlbumName,
  artistMatches,
  albumMatches,
} from './utils.js';

const BASE_URL = 'https://api.music.apple.com/v1';

export class AppleMusicClient implements SourceClient {
  name = 'apple-music';

  constructor(private token: string) {}

  async search(params: SourceSearchParams): Promise<ImageResult[]> {
    if (!this.token) {
      return [];
    }

    try {
      if (params.entityType === 'artists') {
        return this.searchArtists(params);
      }
      if (params.entityType === 'albums') {
        return this.searchAlbums(params);
      }
      return [];
    } catch (error) {
      console.log(
        `[ERROR] Apple Music search failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  private async searchArtists(
    params: SourceSearchParams
  ): Promise<ImageResult[]> {
    const name = params.artistName;
    if (!name) return [];

    const url = new URL(`${BASE_URL}/catalog/us/search`);
    url.searchParams.set('types', 'artists');
    url.searchParams.set('term', name);
    url.searchParams.set('limit', '5');

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      console.log(
        `[ERROR] Apple Music artist search failed: ${response.status} ${response.statusText}`
      );
      return [];
    }

    const data = (await response.json()) as AppleMusicSearchResponse;
    const artists = data.results?.artists?.data ?? [];
    const results: ImageResult[] = [];

    for (const artist of artists) {
      const artwork = artist.attributes?.artwork;
      if (!artwork?.url) continue;

      // Validate artist name match
      if (
        artist.attributes?.name &&
        !artistMatches(name, artist.attributes.name)
      ) {
        continue;
      }

      const imageUrl = artwork.url
        .replace('{w}', '1000')
        .replace('{h}', '1000');
      results.push({
        source: this.name,
        url: imageUrl,
        width: 1000,
        height: 1000,
      });
    }

    return results;
  }

  private async searchAlbums(
    params: SourceSearchParams
  ): Promise<ImageResult[]> {
    const artist = params.artistName
      ? cleanArtistName(params.artistName)
      : undefined;
    const album = params.albumName
      ? cleanAlbumName(params.albumName)
      : undefined;
    const term = artist && album ? `${artist} ${album}` : (album ?? artist);
    if (!term) return [];

    const url = new URL(`${BASE_URL}/catalog/us/search`);
    url.searchParams.set('types', 'albums');
    url.searchParams.set('term', term);
    url.searchParams.set('limit', '5');

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.log(
        `[ERROR] Apple Music album search failed: ${response.status} ${response.statusText} - ${body.slice(0, 500)}`
      );
      return [];
    }

    const data = (await response.json()) as AppleMusicSearchResponse;
    const albums = data.results?.albums?.data ?? [];
    const results: ImageResult[] = [];

    for (const album of albums) {
      const artwork = album.attributes?.artwork;
      if (!artwork?.url) continue;

      // Validate artist and album name match
      if (
        params.artistName &&
        album.attributes?.artistName &&
        !artistMatches(params.artistName, album.attributes.artistName)
      ) {
        continue;
      }
      if (
        params.albumName &&
        album.attributes?.name &&
        !albumMatches(
          params.albumName,
          album.attributes.name,
          params.artistName
        )
      ) {
        continue;
      }

      const imageUrl = artwork.url
        .replace('{w}', '1200')
        .replace('{h}', '1200');
      results.push({
        source: this.name,
        url: imageUrl,
        width: 1200,
        height: 1200,
      });
    }

    return results;
  }
}

interface AppleMusicSearchResponse {
  results?: {
    artists?: {
      data: Array<{
        attributes?: {
          name?: string;
          artwork?: {
            url: string;
            width: number;
            height: number;
          };
        };
      }>;
    };
    albums?: {
      data: Array<{
        attributes?: {
          name?: string;
          artistName?: string;
          artwork?: {
            url: string;
            width: number;
            height: number;
          };
        };
      }>;
    };
  };
}
