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
import {
  syncRunning,
  recomputeStats,
  deleteActivity,
} from '../services/strava/sync.js';
import { syncWatching } from '../services/plex/sync.js';
import { syncLetterboxd } from '../services/letterboxd/sync.js';
import { syncCollecting } from '../services/discogs/sync.js';
import { syncTraktCollection } from '../services/trakt/sync.js';
import { syncReading } from '../services/instapaper/sync.js';
import {
  processReadingImages,
  processWatchingImages,
} from '../services/images/sync-images.js';
import { backfillAttending } from '../services/attending/backfill.js';
import { getGoogleAccessToken } from '../services/google/auth.js';
import { googleTokens } from '../db/schema/google.js';
import { eq } from 'drizzle-orm';
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
    .enum([
      'scrobbles',
      'top_lists',
      'stats',
      'full',
      'backfill',
      'artist_tags',
      'artist_bios',
      'artist_similar',
    ])
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
  id: z
    .string()
    .openapi({ example: '12345', description: 'Strava activity ID' }),
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
  operationId: 'adminSyncListening',
  'x-hidden': true,
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
    | 'backfill'
    | 'artist_tags'
    | 'artist_bios'
    | 'artist_similar';

  const validTypes = [
    'scrobbles',
    'top_lists',
    'stats',
    'full',
    'backfill',
    'artist_tags',
    'artist_bios',
    'artist_similar',
  ];
  if (!validTypes.includes(syncType)) {
    return badRequest(
      c,
      `Invalid sync type. Valid: ${validTypes.join(', ')}`
    ) as any;
  }

  try {
    const result = await syncListening(db, client, { type: syncType });
    return c.json({
      status: 'completed' as const,
      items_synced: result.itemsSynced,
      ...(result.remaining !== undefined && { remaining: result.remaining }),
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
  operationId: 'adminSyncRunning',
  'x-hidden': true,
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
  operationId: 'adminSyncWatching',
  'x-hidden': true,
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
      // Fetch posters for any newly-added movies in the background. The cron
      // path dedups against the Plex run; a manual sync should always process.
      c.executionCtx.waitUntil(
        processWatchingImages(db, c.env).catch((err) =>
          console.log(
            `[ERROR] Watching image processing failed: ${err instanceof Error ? err.message : String(err)}`
          )
        )
      );
      return c.json({
        success: true as const,
        source: 'letterboxd' as const,
        synced: result.synced,
        skipped: result.skipped,
      });
    } else {
      const result = await syncWatching(db, c.env);
      c.executionCtx.waitUntil(
        processWatchingImages(db, c.env).catch((err) =>
          console.log(
            `[ERROR] Watching image processing failed: ${err instanceof Error ? err.message : String(err)}`
          )
        )
      );
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
  operationId: 'adminSyncDiscogsCollection',
  'x-hidden': true,
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
  operationId: 'adminSyncTraktCollection',
  'x-hidden': true,
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

// POST /v1/admin/sync/reading
const syncReadingRoute = createRoute({
  method: 'post',
  path: '/admin/sync/reading',
  operationId: 'adminSyncReading',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Trigger Instapaper sync',
  description: 'Manually trigger an Instapaper reading sync.',
  responses: {
    200: {
      content: { 'application/json': { schema: SyncCompletedResponse } },
      description: 'Sync completed successfully',
    },
    ...errorResponses(401, 500),
  },
});

adminSync.openapi(syncReadingRoute, async (c) => {
  const db = createDb(c.env.DB);
  try {
    const result = await syncReading(db, c.env);
    // Process images in the background
    c.executionCtx.waitUntil(
      processReadingImages(db, c.env).catch((err) =>
        console.log(
          `[ERROR] Reading image processing failed: ${err instanceof Error ? err.message : String(err)}`
        )
      )
    );
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

// DELETE /v1/admin/running/activities/:id
const deleteActivityRoute = createRoute({
  method: 'delete',
  path: '/admin/running/activities/{id}',
  operationId: 'adminDeleteRunningActivity',
  'x-hidden': true,
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
  operationId: 'adminRecomputeRunningStats',
  'x-hidden': true,
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

// POST /v1/admin/sync/attending
const AttendingBackfillBody = z
  .object({
    source: z.enum(['gcal', 'gmail', 'all']).optional().default('all'),
    dry_run: z.boolean().optional().default(false),
    from: z.string().optional().openapi({ example: '2018-01-01' }),
    to: z.string().optional().openapi({ example: '2026-04-25' }),
  })
  .openapi('AttendingBackfillBody');

const AttendingCandidateSchema = z
  .object({
    source_ref: z.string(),
    event_date: z.string().nullable(),
    event_datetime: z.string().nullable(),
    summary: z.string().nullable(),
    location: z.string().nullable(),
    status: z.string().nullable(),
    html_link: z.string().nullable(),
  })
  .openapi('AttendingCandidate');

const AttendingBackfillResponse = z
  .object({
    status: z.literal('completed'),
    candidates_found: z.number().int(),
    events_loaded: z.number().int(),
    sources: z.object({
      gcal: z.number().int(),
      gmail: z.number().int(),
    }),
    dry_run: z.boolean(),
    timestamp: z.string().datetime(),
    gcal: z
      .object({
        scanned: z.number().int(),
        matched: z.number().int(),
        inserted: z.number().int(),
        candidates: z.array(AttendingCandidateSchema).optional(),
        resynced_from_expiry: z.boolean().optional(),
      })
      .optional(),
    gmail: z
      .object({
        scanned: z.number().int(),
        fetched: z.number().int(),
        parsed: z.number().int(),
        inserted: z.number().int(),
        skipped_subject: z.number().int(),
        skipped_no_jsonld: z.number().int(),
        candidates: z.array(z.any()).optional(),
      })
      .optional(),
    enriched: z.array(z.any()).optional(),
    load: z
      .object({
        enriched: z.number().int(),
        inserted: z.number().int(),
        updated: z.number().int(),
        failed: z.number().int(),
        ticket_inserts: z.number().int(),
        performer_inserts: z.number().int(),
      })
      .optional(),
  })
  .openapi('AttendingBackfillResponse');

const syncAttendingRoute = createRoute({
  method: 'post',
  path: '/admin/sync/attending',
  operationId: 'adminSyncAttending',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Trigger attending backfill',
  description:
    'Run the attending backfill pipeline against Google Calendar and Gmail. Pass dry_run=true to inspect candidates without writing.',
  request: {
    body: {
      content: { 'application/json': { schema: AttendingBackfillBody } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AttendingBackfillResponse } },
      description: 'Backfill completed',
    },
    ...errorResponses(400, 401, 500),
  },
});

adminSync.openapi(syncAttendingRoute, async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req
    .json<{
      source?: 'gcal' | 'gmail' | 'all';
      dry_run?: boolean;
      from?: string;
      to?: string;
    }>()
    .catch(() => ({}));

  try {
    const result = await backfillAttending(db, c.env, body);
    return c.json({
      status: 'completed' as const,
      candidates_found: result.candidates_found,
      events_loaded: result.events_loaded,
      sources: result.sources,
      dry_run: result.dry_run,
      timestamp: new Date().toISOString(),
      ...(result.gcal && { gcal: result.gcal }),
      ...(result.gmail && { gmail: result.gmail }),
      ...(result.enriched && { enriched: result.enriched }),
      ...(result.load && { load: result.load }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[ERROR] POST /admin/sync/attending: ${message}`);
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// POST /v1/admin/google/test -- end-to-end auth smoke test.
// Refreshes the access token if needed, then calls Gmail's getProfile
// (gated by gmail.readonly, which we requested). Returns the authenticated
// email + total messages count + granted scopes so misconfigurations show
// up immediately.
const GoogleTestResponse = z
  .object({
    email: z.string(),
    messages_total: z.number().int(),
    scopes: z.array(z.string()),
    expires_at: z.number().int(),
  })
  .openapi('GoogleTestResponse');

const googleTestRoute = createRoute({
  method: 'post',
  path: '/admin/google/test',
  operationId: 'adminGoogleTest',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Smoke test Google auth',
  description:
    'Runs the Google token refresh flow and hits userinfo to confirm end-to-end OAuth works. Used during attending-domain setup.',
  responses: {
    200: {
      content: { 'application/json': { schema: GoogleTestResponse } },
      description: 'Google auth working',
    },
    ...errorResponses(401, 500),
  },
});

adminSync.openapi(googleTestRoute, async (c) => {
  const db = createDb(c.env.DB);
  try {
    const accessToken = await getGoogleAccessToken(db, c.env);
    const res = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
      const text = await res.text();
      return c.json(
        { error: `gmail.profile ${res.status}: ${text}`, status: 500 },
        500
      ) as any;
    }
    const info = (await res.json()) as {
      emailAddress: string;
      messagesTotal: number;
    };

    const [row] = await db
      .select()
      .from(googleTokens)
      .where(eq(googleTokens.userId, 1))
      .limit(1);

    return c.json({
      email: info.emailAddress,
      messages_total: info.messagesTotal,
      scopes: (row?.scopes ?? '').split(' ').filter(Boolean),
      expires_at: row?.expiresAt ?? 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[ERROR] POST /admin/google/test: ${message}`);
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// POST /v1/admin/sync/apple-music-albums
// Backfill released_year + total_tracks on lastfm_albums by querying
// Apple Music's catalog API for every album that has an apple_music_id
// and is missing or stale (>90d) on apple_music_enriched_at. Bounded
// per call so a heavy library doesn't time the worker out — re-run
// until `remaining: 0`.
const AppleMusicAlbumsResponse = z
  .object({
    status: z.literal('completed'),
    items_synced: z.number().int(),
    skipped: z.number().int(),
    timestamp: z.string(),
  })
  .openapi('AppleMusicAlbumsResponse');

const syncAppleMusicAlbumsRoute = createRoute({
  method: 'post',
  path: '/admin/sync/apple-music-albums',
  operationId: 'adminSyncAppleMusicAlbums',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Backfill Apple Music album metadata',
  description:
    'Walks lastfm_albums.apple_music_id for albums missing released_year / total_tracks (or stale >90d), calls Apple Music catalog, and persists. Bounded; re-run until remaining: 0.',
  responses: {
    200: {
      content: { 'application/json': { schema: AppleMusicAlbumsResponse } },
      description: 'Backfill batch completed',
    },
    ...errorResponses(401, 500),
  },
});

adminSync.openapi(syncAppleMusicAlbumsRoute, async (c) => {
  const db = createDb(c.env.DB);
  const token = c.env.APPLE_MUSIC_DEVELOPER_TOKEN;
  if (!token) {
    return c.json(
      { error: 'APPLE_MUSIC_DEVELOPER_TOKEN not set', status: 500 },
      500
    ) as any;
  }
  try {
    const { backfillAppleMusicAlbums } =
      await import('../services/apple-music/album.js');
    const result = await backfillAppleMusicAlbums(db, token);
    return c.json({
      status: 'completed' as const,
      items_synced: result.filled,
      skipped: result.skipped,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[ERROR] POST /admin/sync/apple-music-albums: ${message}`);
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
