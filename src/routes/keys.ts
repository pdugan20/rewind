import { createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { apiKeys } from '../db/schema/system.js';
import { clearAuthCache } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { setCache } from '../lib/cache.js';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses } from '../lib/schemas/common.js';

const keys = createOpenAPIApp();

// --- Schemas ---

const CreateKeyBodySchema = z.object({
  name: z.string().optional(),
  scope: z.string().optional(),
});

const CreatedKeySchema = z.object({
  id: z.number(),
  key: z.string(),
  name: z.string(),
  scope: z.string(),
  key_prefix: z.string(),
  key_hint: z.string(),
  created_at: z.string(),
  message: z.string(),
});

const KeyItemSchema = z.object({
  id: z.number(),
  name: z.string(),
  scope: z.string(),
  key_prefix: z.string(),
  key_hint: z.string(),
  rate_limit_rpm: z.number().nullable(),
  last_used_at: z.string().nullable(),
  request_count: z.number().nullable(),
  expires_at: z.string().nullable(),
  is_active: z.boolean(),
  created_at: z.string(),
});

const KeyListSchema = z.object({
  data: z.array(KeyItemSchema),
});

const KeyIdParamSchema = z.object({
  id: z.string(),
});

const KeyRevokedSchema = z.object({
  message: z.string(),
  id: z.number(),
});

// --- Routes ---

const createKeyRoute = createRoute({
  method: 'post',
  path: '/',
  operationId: 'createAdminKey',
  tags: ['Admin'],
  summary: 'Create API key',
  description:
    'Generate a new API key. The raw key is returned once and cannot be retrieved again.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateKeyBodySchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'API key created successfully',
      content: {
        'application/json': {
          schema: CreatedKeySchema,
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

const listKeysRoute = createRoute({
  method: 'get',
  path: '/',
  operationId: 'listAdminKeys',
  tags: ['Admin'],
  summary: 'List API keys',
  description:
    'List all API keys with prefix and hint only. Key hashes are never exposed.',
  responses: {
    200: {
      description: 'List of API keys',
      content: {
        'application/json': {
          schema: KeyListSchema,
        },
      },
    },
    ...errorResponses(401),
  },
});

const deleteKeyRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  operationId: 'deleteAdminKey',
  tags: ['Admin'],
  summary: 'Revoke API key',
  description: 'Soft-delete an API key by setting is_active to false.',
  request: {
    params: KeyIdParamSchema,
  },
  responses: {
    200: {
      description: 'Key revoked successfully',
      content: {
        'application/json': {
          schema: KeyRevokedSchema,
        },
      },
    },
    ...errorResponses(400, 401, 404),
  },
});

// --- Handlers ---

// POST /v1/admin/keys -- create new API key
keys.openapi(createKeyRoute, async (c) => {
  setCache(c, 'none');

  let body: { name?: string; scope?: string };
  try {
    body = await c.req.json();
  } catch {
    return badRequest(c, 'Invalid JSON body') as any;
  }

  const name = body.name;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return badRequest(c, 'Field "name" is required') as any;
  }

  const scope = body.scope || 'read';
  if (scope !== 'read' && scope !== 'admin') {
    return badRequest(c, 'Field "scope" must be "read" or "admin"') as any;
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
keys.openapi(listKeysRoute, async (c) => {
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

keys.openapi(deleteKeyRoute, async (c) => {
  setCache(c, 'none');

  const idParam = c.req.param('id');
  const id = parseInt(idParam, 10);
  if (isNaN(id)) {
    return badRequest(c, 'Invalid key ID') as any;
  }

  const db = drizzle(c.env.DB);

  const [existing] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.id, id));

  if (!existing) {
    return notFound(c, 'API key not found') as any;
  }

  await db.update(apiKeys).set({ isActive: 0 }).where(eq(apiKeys.id, id));
  clearAuthCache();

  return c.json({ message: 'Key revoked' as const, id });
});

export default keys;
