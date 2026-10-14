import { createRoute, z } from '@hono/zod-openapi';
import { createDb } from '../db/client.js';
import { createOpenAPIApp } from '../lib/openapi.js';
import { DiscmanSnapshot } from '../services/discman/schema.js';
import {
  publishDiscmanSnapshot,
  readDiscmanSnapshot,
} from '../services/discman/snapshot.js';

const discman = createOpenAPIApp();
const ErrorResponse = z.object({ error: z.string(), status: z.number() });
const route = createRoute({
  method: 'get',
  path: '/',
  operationId: 'getListeningDiscman',
  tags: ['Listening'],
  summary: 'Prepared recent albums with tracklists',
  description:
    'Returns up to 12 most recently played distinct albums that have accepted CD artwork, newest first, with no time window. Albums whose disc art is missing, pending, or hidden are skipped, so a shelf can reach past newer listening. Each album includes its Apple Music catalog tracklist in disc/track order when stored (otherwise the songs played from it), previews, Apple Music links, artist image, all image sizes, and per-track play counts and last-played times. Prepared after each 15-minute scrobble sync, so newly accepted art appears at the next rebuild; no live provider requests. Supports If-None-Match.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Prepared shelf',
      content: { 'application/json': { schema: DiscmanSnapshot } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    503: {
      description: 'Shelf unavailable',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

discman.openapi(route, async (c) => {
  // The shelf changes at most once per scrobble sync. Private: auth-scoped.
  c.header('Cache-Control', 'private, max-age=60');
  c.header('Vary', 'Authorization');
  const db = createDb(c.env.DB);
  const userId = c.get('userId');
  try {
    // Before the first sync publishes, build once inline from stored data.
    const snapshot =
      (await readDiscmanSnapshot(db, userId)) ??
      (await publishDiscmanSnapshot(db, userId));
    return c.json(snapshot, 200);
  } catch {
    console.log('[ERROR] Discman snapshot unavailable');
    c.header('Cache-Control', 'no-store');
    c.header('Retry-After', '60');
    return c.json({ error: 'Discman shelf unavailable', status: 503 }, 503);
  }
});

export default discman;
