import { eq, and } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { createMiddleware } from 'hono/factory';
import { apiKeys } from '../db/schema/system.js';
import type { Env } from '../types/env.js';

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

    const db = drizzle(c.env.DB);
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, 1)));

    if (!key) {
      return c.json({ error: 'Unauthorized', status: 401 }, 401);
    }

    if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
      return c.json({ error: 'Token expired', status: 401 }, 401);
    }

    if (requiredScope === 'admin' && key.scope !== 'admin') {
      return c.json({ error: 'Forbidden', status: 403 }, 403);
    }

    // Update last_used_at and request_count asynchronously
    c.executionCtx.waitUntil(
      db
        .update(apiKeys)
        .set({
          lastUsedAt: new Date().toISOString(),
          requestCount: key.requestCount + 1,
        })
        .where(eq(apiKeys.id, key.id))
    );

    await next();
  });
