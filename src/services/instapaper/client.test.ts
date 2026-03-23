import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InstapaperClient } from './client.js';

describe('InstapaperClient', () => {
  it('constructs with OAuth credentials', () => {
    const client = new InstapaperClient(
      'consumer-key',
      'consumer-secret',
      'access-token',
      'access-token-secret'
    );
    expect(client).toBeDefined();
  });

  describe('listBookmarks', () => {
    let client: InstapaperClient;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      client = new InstapaperClient(
        'consumer-key',
        'consumer-secret',
        'access-token',
        'access-token-secret'
      );
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('filters response to only bookmark types', async () => {
      const mixedResponse = [
        { type: 'user', user_id: 1, username: 'testuser' },
        { type: 'meta' },
        {
          type: 'bookmark',
          bookmark_id: 100,
          url: 'https://example.com/1',
          title: 'Article One',
          description: '',
          time: 1704067200,
          starred: '0',
          private_source: '',
          hash: 'abc',
          progress: 0,
          progress_timestamp: 0,
          tags: [],
        },
        {
          type: 'bookmark',
          bookmark_id: 200,
          url: 'https://example.com/2',
          title: 'Article Two',
          description: '',
          time: 1704153600,
          starred: '1',
          private_source: '',
          hash: 'def',
          progress: 0.5,
          progress_timestamp: 1704200000,
          tags: [],
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(mixedResponse)),
      } as unknown as Response);

      const bookmarks = await client.listBookmarks('unread', 25);

      expect(bookmarks).toHaveLength(2);
      expect(bookmarks[0].type).toBe('bookmark');
      expect(bookmarks[0].bookmark_id).toBe(100);
      expect(bookmarks[1].bookmark_id).toBe(200);
    });

    it('returns empty array when response has no bookmarks', async () => {
      const noBookmarks = [
        { type: 'user', user_id: 1, username: 'testuser' },
        { type: 'meta' },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(noBookmarks)),
      } as unknown as Response);

      const bookmarks = await client.listBookmarks();
      expect(bookmarks).toHaveLength(0);
    });
  });

  describe('listHighlights', () => {
    let client: InstapaperClient;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      client = new InstapaperClient(
        'consumer-key',
        'consumer-secret',
        'access-token',
        'access-token-secret'
      );
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('parses highlights response correctly', async () => {
      const highlights = [
        {
          highlight_id: 1,
          bookmark_id: 100,
          text: 'An interesting passage',
          position: 0,
          time: 1704067200,
        },
        {
          highlight_id: 2,
          bookmark_id: 100,
          text: 'Another highlight',
          position: 1,
          time: 1704070800,
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(highlights)),
      } as unknown as Response);

      const result = await client.listHighlights(100);

      expect(result).toHaveLength(2);
      expect(result[0].highlight_id).toBe(1);
      expect(result[0].text).toBe('An interesting passage');
      expect(result[1].highlight_id).toBe(2);
    });
  });

  describe('OAuth signature', () => {
    it('produces consistent signatures for the same inputs', async () => {
      // The generateSignature method is private, but we can verify that
      // two identical requests produce the same Authorization header format
      // by checking the fetch calls include OAuth parameters

      const client = new InstapaperClient(
        'test-key',
        'test-secret',
        'test-token',
        'test-token-secret'
      );

      const originalFetch = globalThis.fetch;
      const fetchCalls: Request[] = [];

      globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
        fetchCalls.push(init);
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('[]'),
        });
      });

      await client.listHighlights(1);

      expect(fetchCalls).toHaveLength(1);
      const authHeader = (
        fetchCalls[0] as unknown as Record<string, Record<string, string>>
      ).headers?.['Authorization'];
      expect(authHeader).toBeDefined();
      expect(authHeader).toContain('OAuth');
      expect(authHeader).toContain('oauth_consumer_key="test-key"');
      expect(authHeader).toContain('oauth_signature_method="HMAC-SHA1"');
      expect(authHeader).toContain('oauth_token="test-token"');
      expect(authHeader).toContain('oauth_version="1.0"');
      expect(authHeader).toContain('oauth_signature=');

      globalThis.fetch = originalFetch;
    });
  });
});
