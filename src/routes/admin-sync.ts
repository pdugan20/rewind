/**
 * Unified admin sync endpoints.
 *
 * Canonical paths: POST /v1/admin/sync/:domain
 * Old paths redirect here for backwards compatibility.
 */
import { Hono } from 'hono';
import type { Env } from '../types/env.js';
import { createDb } from '../db/client.js';
import { LastfmClient } from '../services/lastfm/client.js';
import { syncListening } from '../services/lastfm/sync.js';
import { syncRunning, recomputeStats, deleteActivity } from '../services/strava/sync.js';
import { syncWatching } from '../services/plex/sync.js';
import { syncLetterboxd } from '../services/letterboxd/sync.js';
import { syncCollecting } from '../services/discogs/sync.js';
import { syncTraktCollection } from '../services/trakt/sync.js';
import { badRequest } from '../lib/errors.js';

const adminSync = new Hono<{ Bindings: Env }>();

// POST /v1/admin/sync/listening
adminSync.post('/admin/sync/listening', async (c) => {
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
    return badRequest(c, `Invalid sync type. Valid: ${validTypes.join(', ')}`);
  }

  try {
    const result = await syncListening(db, client, { type: syncType });
    return c.json({
      status: 'completed',
      items_synced: result.itemsSynced,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, status: 500 }, 500);
  }
});

// POST /v1/admin/sync/running
adminSync.post('/admin/sync/running', async (c) => {
  const db = createDb(c.env.DB);

  try {
    const itemsSynced = await syncRunning(c.env, db);
    return c.json({
      status: 'completed',
      items_synced: itemsSynced,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, status: 500 }, 500);
  }
});

// POST /v1/admin/sync/watching
adminSync.post('/admin/sync/watching', async (c) => {
  const db = createDb(c.env.DB);
  const source = c.req.query('source') || 'plex';

  try {
    if (source === 'letterboxd') {
      const result = await syncLetterboxd(db, c.env);
      return c.json({
        success: true,
        source: 'letterboxd',
        synced: result.synced,
        skipped: result.skipped,
      });
    } else {
      const result = await syncWatching(db, c.env);
      return c.json({
        success: true,
        source: 'plex',
        movies_synced: result.moviesSynced,
        shows_synced: result.showsSynced,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, status: 500 }, 500);
  }
});

// POST /v1/admin/sync/collecting
adminSync.post('/admin/sync/collecting', async (c) => {
  try {
    await syncCollecting(c.env);
    return c.json({ status: 'completed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[ERROR] POST /admin/sync/collecting: ${message}`);
    return c.json({ error: message, status: 500 }, 500);
  }
});

// POST /v1/admin/sync/trakt
adminSync.post('/admin/sync/trakt', async (c) => {
  try {
    await syncTraktCollection(c.env);
    return c.json({ status: 'completed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[ERROR] POST /admin/sync/trakt: ${message}`);
    return c.json({ error: message, status: 500 }, 500);
  }
});

// --- Missing Admin Endpoints ---

// DELETE /v1/admin/running/activities/:id
adminSync.delete('/admin/running/activities/:id', async (c) => {
  const stravaId = parseInt(c.req.param('id'), 10);
  if (isNaN(stravaId)) {
    return badRequest(c, 'Invalid activity ID');
  }

  const db = createDb(c.env.DB);
  try {
    await deleteActivity(db, stravaId);
    return c.json({ status: 'deleted', strava_id: stravaId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, status: 500 }, 500);
  }
});

// POST /v1/admin/running/recompute
adminSync.post('/admin/running/recompute', async (c) => {
  const db = createDb(c.env.DB);
  try {
    await recomputeStats(db);
    return c.json({
      status: 'completed',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, status: 500 }, 500);
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
