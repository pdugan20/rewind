/**
 * Instapaper Full API client.
 * Uses OAuth 1.0a request signing (tokens obtained via xAuth).
 */

const API_BASE = 'https://www.instapaper.com/api';
const RATE_LIMIT_MS = 200;

export interface InstapaperBookmark {
  type: 'bookmark';
  bookmark_id: number;
  url: string;
  title: string;
  description: string;
  time: number;
  starred: string; // "0" or "1"
  private_source: string;
  hash: string;
  progress: number;
  progress_timestamp: number;
  tags: { id: number; name: string }[];
}

export interface InstapaperHighlight {
  highlight_id: number;
  bookmark_id: number;
  text: string;
  position: number;
  time: number;
}

export interface InstapaperFolder {
  folder_id: number;
  title: string;
  slug: string;
  display_title: string;
  sync_to_mobile: number;
  position: number;
}

export interface InstapaperUser {
  type: 'user';
  user_id: number;
  username: string;
}

type InstapaperItem =
  | InstapaperBookmark
  | InstapaperUser
  | { type: 'meta' }
  | { type: 'error'; error_code: number; message: string };

export interface BookmarkListOptions {
  folderId?: string;
  limit?: number;
  /** Comma-separated list of "bookmarkId:hash" pairs the client already has */
  have?: string;
  /** Dash-separated list of highlight IDs the client already has */
  highlights?: string;
  /** Filter by tag name (only when folderId is not provided) */
  tag?: string;
}

export interface BookmarkListResult {
  bookmarks: InstapaperBookmark[];
  highlights: InstapaperHighlight[];
  deleteIds: number[];
  user: InstapaperUser | null;
}

export class InstapaperClient {
  private consumerKey: string;
  private consumerSecret: string;
  private accessToken: string;
  private accessTokenSecret: string;
  private lastRequestTime = 0;

  constructor(
    consumerKey: string,
    consumerSecret: string,
    accessToken: string,
    accessTokenSecret: string
  ) {
    this.consumerKey = consumerKey;
    this.consumerSecret = consumerSecret;
    this.accessToken = accessToken;
    this.accessTokenSecret = accessTokenSecret;
  }

  /**
   * List bookmarks in a folder.
   * Supports delta sync via `have` (bookmark hashes) and `highlights` (known highlight IDs).
   */
  async listBookmarks(
    options: BookmarkListOptions = {}
  ): Promise<BookmarkListResult> {
    const { folderId = 'unread', limit = 500, have, highlights, tag } = options;

    const body: Record<string, string> = {
      folder_id: folderId,
      limit: String(limit),
    };
    if (have) body.have = have;
    if (highlights) body.highlights = highlights;
    if (tag) body.tag = tag;

    const response = await this.request('/1/bookmarks/list', body);
    const items = JSON.parse(response) as (
      | InstapaperItem
      | InstapaperHighlight
      | { type: 'delete'; id: number }
    )[];

    const bookmarks: InstapaperBookmark[] = [];
    const returnedHighlights: InstapaperHighlight[] = [];
    const deleteIds: number[] = [];
    let user: InstapaperUser | null = null;

    for (const item of items) {
      if ('type' in item) {
        if (item.type === 'bookmark')
          bookmarks.push(item as InstapaperBookmark);
        else if (item.type === 'user') user = item as InstapaperUser;
        else if (item.type === 'delete') deleteIds.push(item.id);
      } else if ('highlight_id' in item) {
        returnedHighlights.push(item as InstapaperHighlight);
      }
    }

    return { bookmarks, highlights: returnedHighlights, deleteIds, user };
  }

  /**
   * List bookmarks in a folder (simple version, returns bookmarks only).
   * @deprecated Use listBookmarks() with BookmarkListOptions instead.
   */
  async listBookmarksSimple(
    folderId: string = 'unread',
    limit: number = 500
  ): Promise<InstapaperBookmark[]> {
    const result = await this.listBookmarks({ folderId, limit });
    return result.bookmarks;
  }

  /**
   * Get processed article text (HTML).
   */
  async getText(bookmarkId: number): Promise<string> {
    return this.request('/1/bookmarks/get_text', {
      bookmark_id: String(bookmarkId),
    });
  }

  /**
   * List highlights for a bookmark.
   */
  async listHighlights(bookmarkId: number): Promise<InstapaperHighlight[]> {
    const response = await this.request(
      `/1.1/bookmarks/${bookmarkId}/highlights`,
      {}
    );
    return JSON.parse(response) as InstapaperHighlight[];
  }

  /**
   * Verify the current OAuth credentials are valid.
   * Returns the authenticated user on success.
   */
  async verifyCredentials(): Promise<InstapaperUser> {
    const response = await this.request('/1/account/verify_credentials', {});
    const items = JSON.parse(response) as InstapaperItem[];
    const user = items.find(
      (item): item is InstapaperUser => item.type === 'user'
    );
    if (!user)
      throw new Error('Instapaper verify_credentials returned no user');
    return user;
  }

  /**
   * List user-created folders.
   */
  async listFolders(): Promise<InstapaperFolder[]> {
    const response = await this.request('/1/folders/list', {});
    return JSON.parse(response) as InstapaperFolder[];
  }

  // ─── OAuth 1.0a request signing ──────────────────────────────────

  private async request(
    path: string,
    body: Record<string, string>
  ): Promise<string> {
    await this.rateLimit();

    const url = `${API_BASE}${path}`;

    const oauthParams: Record<string, string> = {
      oauth_consumer_key: this.consumerKey,
      oauth_nonce: this.generateNonce(),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_token: this.accessToken,
      oauth_version: '1.0',
    };

    const allParams = { ...oauthParams, ...body };
    const signature = await this.generateSignature('POST', url, allParams);
    oauthParams.oauth_signature = signature;

    const authHeader =
      'OAuth ' +
      Object.keys(oauthParams)
        .sort()
        .map(
          (k) =>
            `${this.percentEncode(k)}="${this.percentEncode(oauthParams[k])}"`
        )
        .join(', ');

    const formBody = new URLSearchParams(body).toString();

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Instapaper API error ${response.status}: ${text.slice(0, 200)}`
      );
    }

    return response.text();
  }

  private async generateSignature(
    method: string,
    url: string,
    params: Record<string, string>
  ): Promise<string> {
    const sortedParams = Object.keys(params)
      .sort()
      .map((k) => `${this.percentEncode(k)}=${this.percentEncode(params[k])}`)
      .join('&');

    const baseString = `${method}&${this.percentEncode(url)}&${this.percentEncode(sortedParams)}`;
    const signingKey = `${this.percentEncode(this.consumerSecret)}&${this.percentEncode(this.accessTokenSecret)}`;

    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(signingKey),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      encoder.encode(baseString)
    );

    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  private generateNonce(): string {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  private percentEncode(str: string): string {
    return encodeURIComponent(str).replace(
      /[!'()*]/g,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
    );
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < RATE_LIMIT_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, RATE_LIMIT_MS - elapsed)
      );
    }
    this.lastRequestTime = Date.now();
  }
}
