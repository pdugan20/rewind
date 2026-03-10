import type { Context } from 'hono';

// In-memory sliding window per isolate. Resets naturally when the isolate is recycled.
const windows = new Map<string, { count: number; resetAt: number }>();

const WINDOW_MS = 60_000;

/**
 * Check if a request is within the rate limit for a given key hash.
 * Returns true if allowed, false if rate limited.
 */
export function checkRateLimit(
  keyHash: string,
  limitRpm: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = windows.get(keyHash);

  if (!entry || now >= entry.resetAt) {
    windows.set(keyHash, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: limitRpm - 1, resetAt: now + WINDOW_MS };
  }

  entry.count++;

  if (entry.count > limitRpm) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  return {
    allowed: true,
    remaining: limitRpm - entry.count,
    resetAt: entry.resetAt,
  };
}

/**
 * Set rate limit response headers.
 */
export function setRateLimitHeaders(
  c: Context,
  limit: number,
  remaining: number,
  resetAt: number
) {
  c.header('X-RateLimit-Limit', String(limit));
  c.header('X-RateLimit-Remaining', String(Math.max(0, remaining)));
  c.header('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
}
