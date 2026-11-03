const BASE_URL = 'https://api.trakt.tv';
const API_VERSION = '2';
const COLLECTION_PAGE_LIMIT = 250;

export interface TraktMovieIds {
  trakt: number;
  slug: string;
  imdb: string;
  tmdb: number;
}

export interface TraktCollectionItem {
  collected_at: string;
  updated_at: string;
  movie: {
    title: string;
    year: number;
    ids: TraktMovieIds;
  };
  metadata: {
    media_type: string;
    resolution: string;
    hdr: string;
    audio: string;
    audio_channels: string;
    '3d': boolean;
  };
}

export interface TraktCollectionInput {
  ids: { tmdb?: number; imdb?: string; trakt?: number };
  media_type: string;
  resolution?: string;
  hdr?: string;
  audio?: string;
  audio_channels?: string;
  collected_at?: string;
}

export interface TraktSyncResult {
  added: { movies: number };
  updated: { movies: number };
  existing: { movies: number };
  not_found: { movies: { ids: Record<string, unknown> }[] };
}

export interface TraktSearchResult {
  type: string;
  score: number;
  movie: {
    title: string;
    year: number;
    ids: TraktMovieIds;
  };
}

export class TraktClient {
  private accessToken: string;
  private clientId: string;

  constructor(accessToken: string, clientId: string) {
    this.accessToken = accessToken;
    this.clientId = clientId;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const { data } = await this.requestWithHeaders<T>(path, options);
    return data;
  }

  private async requestWithHeaders<T>(
    path: string,
    options?: RequestInit
  ): Promise<{ data: T; headers: Headers }> {
    const url = `${BASE_URL}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Rewind/1.0 (personal data aggregator)',
        'trakt-api-version': API_VERSION,
        'trakt-api-key': this.clientId,
        Authorization: `Bearer ${this.accessToken}`,
        ...options?.headers,
      },
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 10000;
      console.log(
        `[INFO] Trakt rate limited, waiting ${waitMs}ms before retry`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.requestWithHeaders<T>(path, options);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[ERROR] Trakt API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    return { data: (await response.json()) as T, headers: response.headers };
  }

  /**
   * Get the user's full movie collection with metadata (format, resolution, HDR, audio).
   * Trakt paginates this endpoint (100 items by default, 250 max), so every page
   * is fetched; a partial list would make the sync delete the missing items.
   */
  async getCollection(): Promise<TraktCollectionItem[]> {
    const items: TraktCollectionItem[] = [];
    let page = 1;
    let pageCount: number;
    do {
      const { data, headers } = await this.requestWithHeaders<
        TraktCollectionItem[]
      >(
        `/sync/collection/movies?extended=metadata&page=${page}&limit=${COLLECTION_PAGE_LIMIT}`
      );
      items.push(...data);
      pageCount = Number(headers.get('x-pagination-page-count')) || 1;
      page++;
    } while (page <= pageCount);
    return items;
  }

  /**
   * Add movies to the user's collection with physical media metadata.
   */
  async addToCollection(
    items: TraktCollectionInput[]
  ): Promise<TraktSyncResult> {
    return this.request<TraktSyncResult>('/sync/collection', {
      method: 'POST',
      body: JSON.stringify({
        movies: items.map((item) => ({
          ids: item.ids,
          media_type: item.media_type,
          resolution: item.resolution,
          hdr: item.hdr,
          audio: item.audio,
          audio_channels: item.audio_channels,
          collected_at: item.collected_at || new Date().toISOString(),
        })),
      }),
    });
  }

  /**
   * Remove movies from the user's collection.
   */
  async removeFromCollection(
    items: TraktCollectionInput[]
  ): Promise<TraktSyncResult> {
    return this.request<TraktSyncResult>('/sync/collection/remove', {
      method: 'POST',
      body: JSON.stringify({
        movies: items.map((item) => ({
          ids: item.ids,
          media_type: item.media_type,
        })),
      }),
    });
  }

  /**
   * Search for a movie by title.
   */
  async searchMovie(query: string): Promise<TraktSearchResult[]> {
    const encoded = encodeURIComponent(query);
    return this.request<TraktSearchResult[]>(`/search/movie?query=${encoded}`);
  }
}
