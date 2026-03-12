/**
 * Unified admin sync endpoints.
 *
 * Canonical paths: POST /v1/admin/sync/:domain
 * Old paths redirect here for backwards compatibility.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses } from '../lib/schemas/common.js';
import { createDb } from '../db/client.js';
import { LastfmClient } from '../services/lastfm/client.js';
import { syncListening } from '../services/lastfm/sync.js';
import { syncRunning, recomputeStats, deleteActivity } from '../services/strava/sync.js';
import { syncWatching } from '../services/plex/sync.js';
import { syncLetterboxd } from '../services/letterboxd/sync.js';
import { syncCollecting } from '../services/discogs/sync.js';
import { syncTraktCollection } from '../services/trakt/sync.js';
import { badRequest } from '../lib/errors.js';

const adminSync = createOpenAPIApp();

// ─── Schemas ────────────────────────────────────────────────────────

const SyncCompletedResponse = z
  .object({
    status: z.literal('completed'),
    items_synced: z.number().int().openapi({ example: 42 }),
    timestamp: z.string().datetime().optional(),
  })
  .openapi('SyncCompletedResponse');

const SyncStatusResponse = z
  .object({
    status: z.literal('completed'),
    timestamp: z.string().datetime().optional(),
  })
  .openapi('SyncStatusResponse');

const ListeningSyncBody = z.object({
  type: z
    .enum(['scrobbles', 'top_lists', 'stats', 'full', 'backfill'])
    .optional()
    .default('scrobbles')
    .openapi({ example: 'scrobbles' }),
});

const WatchingSyncQuery = z.object({
  source: z
    .enum(['plex', 'letterboxd'])
    .optional()
    .default('plex')
    .openapi({ example: 'plex' }),
});

const WatchingPlexResponse = z
  .object({
    success: z.literal(true),
    source: z.literal('plex'),
    movies_synced: z.number().int(),
    shows_synced: z.number().int(),
  })
  .openapi('WatchingPlexSyncResponse');

const WatchingLetterboxdResponse = z
  .object({
    success: z.literal(true),
    source: z.literal('letterboxd'),
    synced: z.number().int(),
    skipped: z.number().int(),
  })
  .openapi('WatchingLetterboxdSyncResponse');

const WatchingSyncResponse = z
  .union([WatchingPlexResponse, WatchingLetterboxdResponse])
  .openapi('WatchingSyncResponse');

const ActivityIdParam = z.object({
  id: z.string().openapi({ example: '12345', description: 'Strava activity ID' }),
});

const DeletedResponse = z
  .object({
    status: z.literal('deleted'),
    strava_id: z.number().int().openapi({ example: 12345 }),
  })
  .openapi('ActivityDeletedResponse');

// ─── Routes ─────────────────────────────────────────────────────────

// POST /v1/admin/sync/listening
const syncListeningRoute = createRoute({
  method: 'post',
  path: '/admin/sync/listening',
  tags: ['Admin'],
  summary: 'Trigger Last.fm sync',
  description:
    'Manually trigger a Last.fm listening sync. Supports scrobbles, top_lists, stats, full, and backfill sync types.',
  request: {
    body: {
      content: { 'application/json': { schema: ListeningSyncBody } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SyncCompletedResponse } },
      description: 'Sync completed successfully',
    },
    ...errorResponses(400, 401, 500),
  },
});

adminSync.openapi(syncListeningRoute, async (c) => {
  const db = createDb(c.env.DB);
  const client = new LastfmClient(c.env.LASTFM_API_KEY, c.env.LASTFM_USERNAME);

  const body = await c.req
    .json<{ type?: string }>()
    .catch(() => ({ type: undefined }));
  const syncType = (body.type ?? 'scrobbles') as
    | 'scrobbles'
    | 'top_lists'
    | 'stats'
    | 'full'
    | 'backfill';

  const validTypes = ['scrobbles', 'top_lists', 'stats', 'full', 'backfill'];
  if (!validTypes.includes(syncType)) {
    return badRequest(c, `Invalid sync type. Valid: ${validTypes.join(', ')}`) as any;
  }

  try {
    const result = await syncListening(db, client, { type: syncType });
    return c.json({
      status: 'completed' as const,
      items_synced: result.itemsSynced,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// POST /v1/admin/sync/running
const syncRunningRoute = createRoute({
  method: 'post',
  path: '/admin/sync/running',
  tags: ['Admin'],
  summary: 'Trigger Strava sync',
  description: 'Manually trigger a Strava running activities sync.',
  responses: {
    200: {
      content: { 'application/json': { schema: SyncCompletedResponse } },
      description: 'Sync completed successfully',
    },
    ...errorResponses(401, 500),
  },
});

adminSync.openapi(syncRunningRoute, async (c) => {
  const db = createDb(c.env.DB);

  try {
    const itemsSynced = await syncRunning(c.env, db);
    return c.json({
      status: 'completed' as const,
      items_synced: itemsSynced,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// POST /v1/admin/sync/watching
const syncWatchingRoute = createRoute({
  method: 'post',
  path: '/admin/sync/watching',
  tags: ['Admin'],
  summary: 'Trigger watching sync',
  description:
    'Manually trigger a watching sync from Plex or Letterboxd. Use the source query parameter to select the source.',
  request: {
    query: WatchingSyncQuery,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: WatchingSyncResponse } },
      description: 'Sync completed successfully',
    },
    ...errorResponses(401, 500),
  },
});

adminSync.openapi(syncWatchingRoute, async (c) => {
  const db = createDb(c.env.DB);
  const source = c.req.query('source') || 'plex';

  try {
    if (source === 'letterboxd') {
      const result = await syncLetterboxd(db, c.env);
      return c.json({
        success: true as const,
        source: 'letterboxd' as const,
        synced: result.synced,
        skipped: result.skipped,
      });
    } else {
      const result = await syncWatching(db, c.env);
      return c.json({
        success: true as const,
        source: 'plex' as const,
        movies_synced: result.moviesSynced,
        shows_synced: result.showsSynced,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// POST /v1/admin/sync/collecting
const syncCollectingRoute = createRoute({
  method: 'post',
  path: '/admin/sync/collecting',
  tags: ['Admin'],
  summary: 'Trigger Discogs collection sync',
  description: 'Manually trigger a Discogs collection sync.',
  responses: {
    200: {
      content: { 'application/json': { schema: SyncStatusResponse } },
      description: 'Sync completed successfully',
    },
    ...errorResponses(401, 500),
  },
});

adminSync.openapi(syncCollectingRoute, async (c) => {
  try {
    await syncCollecting(c.env);
    return c.json({ status: 'completed' as const });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[ERROR] POST /admin/sync/collecting: ${message}`);
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// POST /v1/admin/sync/trakt
const syncTraktRoute = createRoute({
  method: 'post',
  path: '/admin/sync/trakt',
  tags: ['Admin'],
  summary: 'Trigger Trakt collection sync',
  description: 'Manually trigger a Trakt collection sync.',
  responses: {
    200: {
      content: { 'application/json': { schema: SyncStatusResponse } },
      description: 'Sync completed successfully',
    },
    ...errorResponses(401, 500),
  },
});

adminSync.openapi(syncTraktRoute, async (c) => {
  try {
    await syncTraktCollection(c.env);
    return c.json({ status: 'completed' as const });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[ERROR] POST /admin/sync/trakt: ${message}`);
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// DELETE /v1/admin/running/activities/:id
const deleteActivityRoute = createRoute({
  method: 'delete',
  path: '/admin/running/activities/{id}',
  tags: ['Admin'],
  summary: 'Soft-delete a Strava activity',
  description:
    'Soft-delete a Strava activity by its ID and recompute running stats.',
  request: {
    params: ActivityIdParam,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: DeletedResponse } },
      description: 'Activity soft-deleted',
    },
    ...errorResponses(400, 401, 500),
  },
});

adminSync.openapi(deleteActivityRoute, async (c) => {
  const stravaId = parseInt(c.req.param('id'), 10);
  if (isNaN(stravaId)) {
    return badRequest(c, 'Invalid activity ID') as any;
  }

  const db = createDb(c.env.DB);
  try {
    await deleteActivity(db, stravaId);
    return c.json({ status: 'deleted' as const, strava_id: stravaId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// POST /v1/admin/running/recompute
const recomputeRoute = createRoute({
  method: 'post',
  path: '/admin/running/recompute',
  tags: ['Admin'],
  summary: 'Recompute running stats',
  description:
    'Recompute all running year summaries from activity data. Useful after bulk imports or corrections.',
  responses: {
    200: {
      content: { 'application/json': { schema: SyncStatusResponse } },
      description: 'Recomputation completed',
    },
    ...errorResponses(401, 500),
  },
});

adminSync.openapi(recomputeRoute, async (c) => {
  const db = createDb(c.env.DB);
  try {
    await recomputeStats(db);
    return c.json({
      status: 'completed' as const,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// --- Redirects from old paths ---
// These handle requests to the legacy paths and redirect to the canonical ones.

adminSync.all('/listening/admin/sync', (c) => {
  return c.redirect('/v1/admin/sync/listening', 301);
});

adminSync.all('/running/admin/sync', (c) => {
  return c.redirect('/v1/admin/sync/running', 301);
});

adminSync.all('/watching/admin/sync/watching', (c) => {
  const source = c.req.query('source');
  const url = source
    ? `/v1/admin/sync/watching?source=${source}`
    : '/v1/admin/sync/watching';
  return c.redirect(url, 301);
});

export default adminSync;
