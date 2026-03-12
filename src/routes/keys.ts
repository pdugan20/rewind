import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../types/env.js';
import { apiKeys } from '../db/schema/system.js';
import { badRequest, notFound } from '../lib/errors.js';
import { setCache } from '../lib/cache.js';
import { invalidateAuthCache } from '../lib/auth.js';

const keys = new Hono<{ Bindings: Env }>();

// POST /v1/admin/keys -- create new API key
keys.post('/', async (c) => {
  setCache(c, 'none');

  let body: { name?: string; scope?: string };
  try {
    body = await c.req.json();
  } catch {
    return badRequest(c, 'Invalid JSON body');
  }

  const name = body.name;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return badRequest(c, 'Field "name" is required');
  }

  const scope = body.scope || 'read';
  if (scope !== 'read' && scope !== 'admin') {
    return badRequest(c, 'Field "scope" must be "read" or "admin"');
  }

  // Generate a random API key
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const randomHex = [...randomBytes]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const rawKey = `rw_${randomHex}`;

  // SHA-256 hash for storage
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(rawKey)
  );
  const keyHash = [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Prefix (first 10 chars) and hint (last 4 chars)
  const keyPrefix = rawKey.slice(0, 10);
  const keyHint = rawKey.slice(-4);

  const db = drizzle(c.env.DB);

  const [inserted] = await db
    .insert(apiKeys)
    .values({
      userId: 1,
      keyHash,
      keyPrefix,
      keyHint,
      name: name.trim(),
      scope,
      createdAt: new Date().toISOString(),
    })
    .returning();

  // Return the raw key ONCE -- it cannot be retrieved again
  return c.json(
    {
      id: inserted.id,
      key: rawKey,
      name: inserted.name,
      scope: inserted.scope,
      key_prefix: inserted.keyPrefix,
      key_hint: inserted.keyHint,
      created_at: inserted.createdAt,
      message:
        'Store this key securely. It cannot be retrieved again after this response.',
    },
    201
  );
});

// GET /v1/admin/keys -- list all keys (prefix + hint only, never expose hash)
keys.get('/', async (c) => {
  setCache(c, 'none');

  const db = drizzle(c.env.DB);

  const allKeys = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      scope: apiKeys.scope,
      keyPrefix: apiKeys.keyPrefix,
      keyHint: apiKeys.keyHint,
      rateLimitRpm: apiKeys.rateLimitRpm,
      lastUsedAt: apiKeys.lastUsedAt,
      requestCount: apiKeys.requestCount,
      expiresAt: apiKeys.expiresAt,
      isActive: apiKeys.isActive,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, 1));

  return c.json({
    data: allKeys.map((k) => ({
      id: k.id,
      name: k.name,
      scope: k.scope,
      key_prefix: k.keyPrefix,
      key_hint: k.keyHint,
      rate_limit_rpm: k.rateLimitRpm,
      last_used_at: k.lastUsedAt,
      request_count: k.requestCount,
      expires_at: k.expiresAt,
      is_active: k.isActive === 1,
      created_at: k.createdAt,
    })),
  });
});

// DELETE /v1/admin/keys/:id -- revoke a key (soft delete via is_active)
// eslint-disable-next-line drizzle/enforce-delete-with-where
keys.delete('/:id', async (c) => {
  setCache(c, 'none');

  const idParam = c.req.param('id');
  const id = parseInt(idParam, 10);
  if (isNaN(id)) {
    return badRequest(c, 'Invalid key ID');
  }

  const db = drizzle(c.env.DB);

  const [existing] = await db
    .select({ id: apiKeys.id, keyHash: apiKeys.keyHash })
    .from(apiKeys)
    .where(eq(apiKeys.id, id));

  if (!existing) {
    return notFound(c, 'API key not found');
  }

  await db.update(apiKeys).set({ isActive: 0 }).where(eq(apiKeys.id, id));

  // Invalidate auth cache for this key
  invalidateAuthCache(existing.keyHash);

  return c.json({ message: 'Key revoked', id });
});

export default keys;
