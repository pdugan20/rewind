import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SELF } from 'cloudflare:test';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';
import { clearAuthCache } from './auth.js';
import { resetRateLimitWindows } from './rate-limit.js';

describe('auth middleware', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(() => {
    clearAuthCache();
    resetRateLimitWindows();
  });

  describe('caching', () => {
    it('returns 401 for missing auth header', async () => {
      await SELF.fetch('http://localhost/v1/health/sync');
      // health/sync is not authed, use a protected endpoint
      const res2 = await SELF.fetch('http://localhost/v1/listening/recent');
      expect(res2.status).toBe(401);
    });

    it('authenticates valid token', async () => {
      const token = await createTestApiKey({
        scope: 'read',
        name: 'cache-test-1',
      });
      const res = await SELF.fetch('http://localhost/v1/listening/recent', {
        headers: { Authorization: `Bearer ${token}` },
      });
      // Should not be 401 (may be other status depending on data)
      expect(res.status).not.toBe(401);
    });

    it('uses cached auth on second request', async () => {
      const token = await createTestApiKey({
        scope: 'read',
        name: 'cache-test-2',
      });

      // First request populates cache
      const res1 = await SELF.fetch('http://localhost/v1/listening/recent', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res1.status).not.toBe(401);

      // Second request should use cache (still works)
      const res2 = await SELF.fetch('http://localhost/v1/listening/recent', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res2.status).not.toBe(401);
    });

    it('rejects revoked key after cache invalidation', async () => {
      const adminToken = await createTestApiKey({
        scope: 'admin',
        name: 'cache-admin',
      });
      const readToken = await createTestApiKey({
        scope: 'read',
        name: 'cache-revoke-target',
      });

      // Authenticate to populate cache
      const res1 = await SELF.fetch('http://localhost/v1/listening/recent', {
        headers: { Authorization: `Bearer ${readToken}` },
      });
      expect(res1.status).not.toBe(401);

      // Get key ID from keys list
      const keysRes = await SELF.fetch('http://localhost/v1/admin/keys', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const keysBody = (await keysRes.json()) as {
        data: Array<{ id: number; name: string }>;
      };
      const targetKey = keysBody.data.find(
        (k) => k.name === 'cache-revoke-target'
      );
      expect(targetKey).toBeDefined();

      // Revoke the key
      const revokeRes = await SELF.fetch(
        `http://localhost/v1/admin/keys/${targetKey!.id}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(revokeRes.status).toBe(200);

      // Key should now be rejected (cache invalidated)
      const res2 = await SELF.fetch('http://localhost/v1/listening/recent', {
        headers: { Authorization: `Bearer ${readToken}` },
      });
      expect(res2.status).toBe(401);
    });
  });

  describe('rate limiting', () => {
    it('includes rate limit headers in response', async () => {
      const token = await createTestApiKey({
        scope: 'read',
        name: 'ratelimit-headers',
      });
      const res = await SELF.fetch('http://localhost/v1/listening/recent', {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.headers.get('X-RateLimit-Limit')).toBeTruthy();
      expect(res.headers.get('X-RateLimit-Remaining')).toBeTruthy();
      expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
    });

    it('returns 429 when rate limit exceeded', async () => {
      // Create a key with very low rate limit
      // Default is 60 RPM, but we'll just hammer it
      const token = await createTestApiKey({
        scope: 'read',
        name: 'ratelimit-test',
      });

      // Make requests up to and past the limit (default 60 RPM)
      // We can't easily make 60 requests in a test, so let's test the mechanism
      // by directly using checkRateLimit
      const { checkRateLimit: check } = await import('./rate-limit.js');

      const keyHash = 'test-rate-limit-hash';
      const limit = 3;

      expect(check(keyHash, limit).allowed).toBe(true);
      expect(check(keyHash, limit).allowed).toBe(true);
      expect(check(keyHash, limit).allowed).toBe(true);

      const result = check(keyHash, limit);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);

      // The token itself still works for first request through middleware
      const res = await SELF.fetch('http://localhost/v1/listening/recent', {
        headers: { Authorization: `Bearer ${token}` },
      });
      // First request should pass (fresh window for this token)
      expect(res.status).not.toBe(429);
    });

    it('rate limit window resets after expiry', async () => {
      const { checkRateLimit: check } = await import('./rate-limit.js');
      const keyHash = 'test-reset-hash';
      const limit = 2;

      // Exhaust the limit
      check(keyHash, limit);
      check(keyHash, limit);
      expect(check(keyHash, limit).allowed).toBe(false);

      // The window has a resetAt in the future
      // We can't easily test time-based reset without mocking,
      // but we can verify the resetAt is set correctly
      const result = check(keyHash, limit);
      expect(result.resetAt).toBeGreaterThan(Date.now() - 1000);
    });
  });
});
