import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIApp } from '../lib/openapi.js';
import { movieExclusions, policyKey } from '../services/lately/policy.js';
import { LatelySnapshot } from '../services/lately/schema.js';

const lately = createOpenAPIApp();
const ErrorResponse = z.object({ error: z.string(), status: z.number() });
const route = createRoute({
  method: 'get',
  path: '/',
  operationId: 'getLately',
  tags: ['Feed'],
  summary: 'Prepared latest music and movie',
  description:
    'Returns one prepared pair for the authenticated user. No live provider requests. Keep the whole response fixed for the page visit; refresh only for a new visit. Music is the last completed scrobble, not live playback. Returns 503 until the first background publication.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Prepared snapshot',
      content: { 'application/json': { schema: LatelySnapshot } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    503: {
      description: 'Snapshot not ready',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

lately.openapi(route, async (c) => {
  // Auth runs before this read. Next may explicitly cache its server-side
  // fetch; HTTP shared caches must never reuse the response across keys/users.
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Authorization');
  try {
    const policy = policyKey(movieExclusions(c.env.LATELY_EXCLUDED_MOVIE_IDS));
    const row = await c.env.DB.prepare(
      `SELECT snapshot FROM lately_snapshots
      WHERE user_id = ? AND policy = ? AND snapshot IS NOT NULL`
    )
      .bind(c.get('userId'), policy)
      .first<{ snapshot: string }>();
    if (row) {
      const snapshot = LatelySnapshot.parse(JSON.parse(row.snapshot));
      return c.json(snapshot, 200);
    }
  } catch {
    // Fail closed for unavailable schema/configuration. Never serialize raw
    // database/provider errors or fall back to the owner's live endpoint.
    console.log('[ERROR] Lately snapshot unavailable');
  }
  c.header('Retry-After', '60');
  return c.json({ error: 'Lately snapshot not ready', status: 503 }, 503);
});

export default lately;
