const BASE_URL = 'https://api.discogs.com';
const USER_AGENT = 'RewindAPI/1.0';
const RATE_LIMIT_RPM = 60;
const RATE_LIMIT_INTERVAL_MS = (60 / RATE_LIMIT_RPM) * 1000; // ~1000ms between requests

export interface DiscogsCollectionItem {
  instance_id: number;
  folder_id: number;
  rating: number;
  date_added: string;
  notes?: Array<{ field_id: number; value: string }>;
  basic_information: {
    id: number;
    title: string;
    year: number;
    resource_url: string;
    thumb: string;
    cover_image: string;
    artists: Array<{ id: number; name: string; resource_url: string }>;
    labels: Array<{ name: string; catno: string }>;
    formats: Array<{
      name: string;
      qty: string;
      descriptions?: string[];
    }>;
    genres: string[];
    styles: string[];
  };
}

export interface DiscogsWantlistItem {
  id: number;
  rating: number;
  notes: string;
  date_added: string;
  basic_information: {
    id: number;
    title: string;
    year: number;
    resource_url: string;
    thumb: string;
    cover_image: string;
    artists: Array<{ id: number; name: string }>;
    formats: Array<{
      name: string;
      qty: string;
      descriptions?: string[];
    }>;
    genres: string[];
    styles: string[];
  };
}

export interface DiscogsRelease {
  id: number;
  title: string;
  year: number;
  uri: string;
  artists: Array<{ id: number; name: string; resource_url: string }>;
  labels: Array<{ name: string; catno: string }>;
  formats: Array<{
    name: string;
    qty: string;
    descriptions?: string[];
  }>;
  genres: string[];
  styles: string[];
  tracklist: Array<{
    position: string;
    title: string;
    duration: string;
  }>;
  images?: Array<{
    type: string;
    uri: string;
    width: number;
    height: number;
  }>;
  country: string;
  community: {
    have: number;
    want: number;
  };
  lowest_price: number | null;
  num_for_sale: number;
}

export interface DiscogsPaginatedResponse<T> {
  pagination: {
    page: number;
    pages: number;
    per_page: number;
    items: number;
  };
  releases?: T[];
  wants?: T[];
}

export class DiscogsClient {
  private token: string;
  private username: string;
  private lastRequestTime: number = 0;

  constructor(token: string, username: string) {
    this.token = token;
    this.username = username;
  }

  private async rateLimitedFetch(url: string): Promise<Response> {
    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;
    if (timeSinceLast < RATE_LIMIT_INTERVAL_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, RATE_LIMIT_INTERVAL_MS - timeSinceLast)
      );
    }
    this.lastRequestTime = Date.now();

    const response = await fetch(url, {
      headers: {
        Authorization: `Discogs token=${this.token}`,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
      console.log(
        `[INFO] Discogs rate limited, waiting ${waitMs}ms before retry`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.rateLimitedFetch(url);
    }

    if (!response.ok) {
      throw new Error(
        `Discogs API error: ${response.status} ${response.statusText}`
      );
    }

    return response;
  }

  async getCollectionPage(
    page: number = 1,
    perPage: number = 100
  ): Promise<DiscogsPaginatedResponse<DiscogsCollectionItem>> {
    const url = `${BASE_URL}/users/${this.username}/collection/folders/0/releases?page=${page}&per_page=${perPage}&sort=added&sort_order=desc`;
    const response = await this.rateLimitedFetch(url);
    return response.json();
  }

  async getAllCollectionItems(): Promise<DiscogsCollectionItem[]> {
    const items: DiscogsCollectionItem[] = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const data = await this.getCollectionPage(page);
      totalPages = data.pagination.pages;
      if (data.releases) {
        items.push(...data.releases);
      }
      console.log(
        `[INFO] Fetched collection page ${page}/${totalPages} (${items.length} items so far)`
      );
      page++;
    }

    return items;
  }

  async getWantlistPage(
    page: number = 1,
    perPage: number = 100
  ): Promise<DiscogsPaginatedResponse<DiscogsWantlistItem>> {
    const url = `${BASE_URL}/users/${this.username}/wants?page=${page}&per_page=${perPage}`;
    const response = await this.rateLimitedFetch(url);
    return response.json();
  }

  async getAllWantlistItems(): Promise<DiscogsWantlistItem[]> {
    const items: DiscogsWantlistItem[] = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const data = await this.getWantlistPage(page);
      totalPages = data.pagination.pages;
      if (data.wants) {
        items.push(...data.wants);
      }
      console.log(
        `[INFO] Fetched wantlist page ${page}/${totalPages} (${items.length} items so far)`
      );
      page++;
    }

    return items;
  }

  async getReleaseDetail(releaseId: number): Promise<DiscogsRelease> {
    const url = `${BASE_URL}/releases/${releaseId}`;
    const response = await this.rateLimitedFetch(url);
    return response.json();
  }
}
