import { createMiddleware } from 'hono/factory';
import { verifyWithJwks } from 'hono/jwt';
import { z } from 'zod';
import type { Env } from '../../types/env.js';
import type { ArtworkEnv } from './types.js';
import { boundedBytes } from './sources.js';
declare module 'hono' {
  interface ContextVariableMap {
    galleryHideReady: boolean;
  }
}

type Keys = NonNullable<Parameters<typeof verifyWithJwks>[1]['keys']>;
let certificateCache: { issuer: string; expires: number; keys: Keys } | null =
  null;
let certificateLoad: { issuer: string; promise: Promise<Keys> } | null = null;
export function clearGalleryCertificateCache() {
  certificateCache = null;
  certificateLoad = null;
}
async function certificates(issuer: string): Promise<Keys> {
  if (
    certificateCache?.issuer === issuer &&
    certificateCache.expires > Date.now()
  )
    return certificateCache.keys;
  if (certificateLoad?.issuer === issuer) return certificateLoad.promise;
  const promise = (async () => {
    const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Keys unavailable');
    const jwks = JSON.parse(
      new TextDecoder().decode(await boundedBytes(response, 64 * 1024))
    ) as { keys: Keys };
    if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 20)
      throw new Error('Invalid certificates');
    certificateCache = { issuer, expires: Date.now() + 60000, keys: jwks.keys };
    return jwks.keys;
  })();
  certificateLoad = { issuer, promise };
  try {
    return await promise;
  } finally {
    if (certificateLoad?.promise === promise) certificateLoad = null;
  }
}
const configuration = z
  .object({
    issuer: z.string().regex(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/),
    audience: z.string().regex(/^[a-f0-9]{64}$/),
    users: z.record(z.email(), z.number().int().positive()),
    hide_ready: z.boolean().default(false),
  })
  .strict();
// Store this configuration as one Worker secret; owner identities never enter
// public configuration or client bundles. Unconfigured galleries fail closed.
export const galleryAuth = createMiddleware<{ Bindings: Env & ArtworkEnv }>(
  async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', 'Cookie, Cf-Access-Jwt-Assertion');
    const parsed = configuration.safeParse(
      parseConfiguration(c.env.CD_GALLERY_ACCESS)
    );
    if (!parsed.success)
      return c.json(
        { error: 'Gallery access is not configured', status: 503 },
        503
      );
    const token = c.req.header('Cf-Access-Jwt-Assertion');
    if (!token || token.length > 16384)
      return c.json(
        { error: 'Sign in with Cloudflare Access', status: 401 },
        401
      );
    let userId: number | undefined;
    try {
      const config = parsed.data;
      const payload = await verifyWithJwks(token, {
        keys: await certificates(config.issuer),
        allowedAlgorithms: ['RS256'],
        verification: { iss: config.issuer, aud: config.audience },
      });
      if (
        typeof payload.exp !== 'number' ||
        typeof payload.email !== 'string' ||
        payload.type !== 'app'
      )
        throw new Error('Invalid identity');
      userId = config.users[payload.email.toLowerCase()];
    } catch {
      return c.json({ error: 'Invalid gallery session', status: 401 }, 401);
    }
    if (!userId) return c.json({ error: 'Forbidden', status: 403 }, 403);
    // Public API CORS allowances must not grant sibling sites access to the
    // owner's cookie-authenticated review notes or private source images.
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin)
      return c.json({ error: 'Invalid review origin', status: 403 }, 403);
    // Access uses cookies, so every mutation also needs an exact same-origin
    // request and custom header. Neither a spoofable email header nor an API key
    // grants gallery access. API clients retain their separate Bearer routes.
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      if (
        c.req.header('Origin') !== new URL(c.req.url).origin ||
        c.req.header('X-Artwork-Review') !== '1' ||
        !c.req.header('Content-Type')?.startsWith('application/json')
      )
        return c.json({ error: 'Invalid review origin', status: 403 }, 403);
    }
    c.set('userId', userId);
    c.set('galleryHideReady', parsed.data.hide_ready);
    await next();
  }
);
function parseConfiguration(value?: string) {
  try {
    return JSON.parse(value ?? 'null') as unknown;
  } catch {
    return null;
  }
}
