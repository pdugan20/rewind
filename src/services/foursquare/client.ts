const BASE_URL = 'https://api.foursquare.com';
// Foursquare v2 versioning parameter: a frozen date the client is known
// to work against. Bump deliberately after verifying response shapes.
const API_VERSION = '20250101';

// Foursquare sits behind bot protection that rejects obviously
// programmatic User-Agents; send a browser-like one.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface FoursquareCategory {
  name: string;
  primary?: boolean;
}

export interface FoursquareVenueLocation {
  city?: string;
  state?: string;
  country?: string;
  lat?: number;
  lng?: number;
}

export interface FoursquareVenue {
  id: string;
  name: string;
  categories?: FoursquareCategory[];
  location?: FoursquareVenueLocation;
}

export interface FoursquareCheckin {
  id: string;
  /** Epoch seconds. */
  createdAt: number;
  shout?: string;
  /** Missing on some legacy checkins — the sync skips and counts those. */
  venue?: FoursquareVenue;
}

export interface FoursquareCheckinsPage {
  items: FoursquareCheckin[];
  /** Total checkin count for the user, from the API envelope. */
  count: number;
}

export interface FoursquareCheckinsOptions {
  offset?: number;
  limit?: number;
}

interface FoursquareEnvelope<T> {
  meta: { code: number; requestId?: string };
  response: T;
}

export class FoursquareClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 10000;
      console.log(
        `[INFO] Foursquare rate limited, waiting ${waitMs}ms before retry`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.request<T>(path);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[ERROR] Foursquare API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const envelope = (await response.json()) as FoursquareEnvelope<T>;
    return envelope.response;
  }

  /**
   * Get a page of the user's checkin history, oldest first. The
   * oldestfirst sort makes `offset` a natively resumable cursor.
   */
  async getCheckins(
    options: FoursquareCheckinsOptions = {}
  ): Promise<FoursquareCheckinsPage> {
    const params = new URLSearchParams({
      oauth_token: this.accessToken,
      v: API_VERSION,
      sort: 'oldestfirst',
      limit: String(options.limit ?? 250),
      offset: String(options.offset ?? 0),
    });
    const data = await this.request<{
      checkins: { count: number; items: FoursquareCheckin[] };
    }>(`/v2/users/self/checkins?${params.toString()}`);
    return { items: data.checkins.items, count: data.checkins.count };
  }
}
