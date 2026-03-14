const BASE_URL = 'https://ws.audioscrobbler.com/2.0/';
const RATE_LIMIT_INTERVAL_MS = 200; // 5 requests per second

export interface LastfmRecentTrack {
  artist: { mbid: string; '#text': string };
  name: string;
  mbid: string;
  album: { mbid: string; '#text': string };
  url: string;
  date?: { uts: string; '#text': string };
  '@attr'?: { nowplaying: string };
  image: { size: string; '#text': string }[];
}

export interface LastfmTopArtist {
  name: string;
  playcount: string;
  mbid: string;
  url: string;
  '@attr': { rank: string };
}

export interface LastfmTopAlbum {
  name: string;
  playcount: string;
  mbid: string;
  url: string;
  artist: { name: string; mbid: string; url: string };
  '@attr': { rank: string };
  image: { size: string; '#text': string }[];
}

export interface LastfmTopTrack {
  name: string;
  playcount: string;
  mbid: string;
  url: string;
  artist: { name: string; mbid: string; url: string };
  duration: string;
  '@attr': { rank: string };
}

export interface LastfmTag {
  name: string;
  count: number;
  url: string;
}

export interface LastfmUserInfo {
  user: {
    playcount: string;
    registered: { unixtime: string; '#text': number };
    name: string;
    url: string;
    country: string;
  };
}

export type LastfmPeriod =
  | '7day'
  | '1month'
  | '3month'
  | '6month'
  | '12month'
  | 'overall';

export const LASTFM_PERIODS: LastfmPeriod[] = [
  '7day',
  '1month',
  '3month',
  '6month',
  '12month',
  'overall',
];

export class LastfmClient {
  private apiKey: string;
  private username: string;
  private lastRequestTime = 0;

  constructor(apiKey: string, username: string) {
    this.apiKey = apiKey;
    this.username = username;
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < RATE_LIMIT_INTERVAL_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, RATE_LIMIT_INTERVAL_MS - elapsed)
      );
    }
    this.lastRequestTime = Date.now();
  }

  private async request<T>(params: Record<string, string>): Promise<T> {
    await this.rateLimit();

    const url = new URL(BASE_URL);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('format', 'json');
    url.searchParams.set('user', this.username);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(
        `[ERROR] Last.fm API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as T;
    return data;
  }

  async getRecentTracks(options: {
    limit?: number;
    page?: number;
    from?: number;
    to?: number;
  }): Promise<{
    recenttracks: {
      track: LastfmRecentTrack[];
      '@attr': {
        page: string;
        perPage: string;
        total: string;
        totalPages: string;
      };
    };
  }> {
    const params: Record<string, string> = {
      method: 'user.getRecentTracks',
      limit: String(options.limit ?? 200),
      page: String(options.page ?? 1),
    };
    if (options.from) params.from = String(options.from);
    if (options.to) params.to = String(options.to);

    return this.request(params);
  }

  async getTopArtists(options: {
    period: LastfmPeriod;
    limit?: number;
    page?: number;
  }): Promise<{
    topartists: {
      artist: LastfmTopArtist[];
      '@attr': {
        page: string;
        perPage: string;
        total: string;
        totalPages: string;
      };
    };
  }> {
    return this.request({
      method: 'user.getTopArtists',
      period: options.period,
      limit: String(options.limit ?? 30),
      page: String(options.page ?? 1),
    });
  }

  async getTopAlbums(options: {
    period: LastfmPeriod;
    limit?: number;
    page?: number;
  }): Promise<{
    topalbums: {
      album: LastfmTopAlbum[];
      '@attr': {
        page: string;
        perPage: string;
        total: string;
        totalPages: string;
      };
    };
  }> {
    return this.request({
      method: 'user.getTopAlbums',
      period: options.period,
      limit: String(options.limit ?? 30),
      page: String(options.page ?? 1),
    });
  }

  async getTopTracks(options: {
    period: LastfmPeriod;
    limit?: number;
    page?: number;
  }): Promise<{
    toptracks: {
      track: LastfmTopTrack[];
      '@attr': {
        page: string;
        perPage: string;
        total: string;
        totalPages: string;
      };
    };
  }> {
    return this.request({
      method: 'user.getTopTracks',
      period: options.period,
      limit: String(options.limit ?? 30),
      page: String(options.page ?? 1),
    });
  }

  async getUserInfo(): Promise<LastfmUserInfo> {
    return this.request({
      method: 'user.getInfo',
    });
  }

  async getArtistTopTags(artist: string): Promise<{
    toptags: { tag: LastfmTag[]; '@attr': { artist: string } };
  }> {
    return this.request({
      method: 'artist.getTopTags',
      artist,
    });
  }
}
