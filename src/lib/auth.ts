import { eq, and } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { createMiddleware } from 'hono/factory';
import { apiKeys } from '../db/schema/system.js';
import type { Env } from '../types/env.js';
import { checkRateLimit, setRateLimitHeaders } from './rate-limit.js';

/**
 * In-memory auth cache. Caches keyHash -> key record for 60s.
 * Resets when the isolate is recycled (standard Workers behavior).
 */
interface CachedKey {
  id: number;
  scope: string;
  rateLimitRpm: number;
  requestCount: number;
  expiresAt: string | null;
  cachedAt: number;
}

const AUTH_CACHE_TTL_MS = 60_000;
const authCache = new Map<string, CachedKey>();

function getCachedKey(keyHash: string): CachedKey | null {
  const entry = authCache.get(keyHash);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > AUTH_CACHE_TTL_MS) {
    // eslint-disable-next-line drizzle/enforce-delete-with-where -- Map.delete(), not Drizzle
    authCache.delete(keyHash);
    return null;
  }
  return entry;
}

function setCachedKey(keyHash: string, key: CachedKey): void {
  authCache.set(keyHash, { ...key, cachedAt: Date.now() });
}

/**
 * Invalidate a cached key entry. Call when a key is revoked.
 */
export function invalidateAuthCache(keyHash: string): void {
  // eslint-disable-next-line drizzle/enforce-delete-with-where -- Map.delete(), not Drizzle
  authCache.delete(keyHash);
}

/**
 * Clear all cached entries. Useful for testing.
 */
export function clearAuthCache(): void {
  authCache.clear();
}

export const requireAuth = (requiredScope: 'read' | 'admin' = 'read') =>
  createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const header = c.req.header('Authorization');

    if (!header?.startsWith('Bearer rw_')) {
      return c.json({ error: 'Unauthorized', status: 401 }, 401);
    }

    const token = header.slice(7);
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(token)
    );
    const keyHash = [...new Uint8Array(hashBuffer)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Check cache first
    let keyData = getCachedKey(keyHash);

    if (!keyData) {
      // Cache miss: query DB
      const db = drizzle(c.env.DB);
      const [key] = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, 1)));

      if (!key) {
        return c.json({ error: 'Unauthorized', status: 401 }, 401);
      }

      keyData = {
        id: key.id,
        scope: key.scope,
        rateLimitRpm: key.rateLimitRpm,
        requestCount: key.requestCount,
        expiresAt: key.expiresAt,
        cachedAt: Date.now(),
      };
      setCachedKey(keyHash, keyData);
    }

    if (keyData.expiresAt && new Date(keyData.expiresAt) < new Date()) {
      return c.json({ error: 'Token expired', status: 401 }, 401);
    }

    if (requiredScope === 'admin' && keyData.scope !== 'admin') {
      return c.json({ error: 'Forbidden', status: 403 }, 403);
    }

    // Rate limiting
    const rateResult = checkRateLimit(keyHash, keyData.rateLimitRpm);
    setRateLimitHeaders(
      c,
      keyData.rateLimitRpm,
      rateResult.remaining,
      rateResult.resetAt
    );

    if (!rateResult.allowed) {
      const retryAfter = Math.ceil((rateResult.resetAt - Date.now()) / 1000);
      c.header('Retry-After', String(Math.max(1, retryAfter)));
      return c.json({ error: 'Too Many Requests', status: 429 }, 429);
    }

    // Update last_used_at and request_count asynchronously
    const db = drizzle(c.env.DB);
    c.executionCtx.waitUntil(
      db
        .update(apiKeys)
        .set({
          lastUsedAt: new Date().toISOString(),
          requestCount: keyData.requestCount + 1,
        })
        .where(eq(apiKeys.id, keyData.id))
    );

    await next();
  });
