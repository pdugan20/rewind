import { Hono } from 'hono';
import type { Env } from '../types/env.js';
import { createDb } from '../db/client.js';
import {
  validateSubscription,
  processWebhookEvent,
} from '../services/strava/webhook.js';
import type { StravaWebhookEvent } from '../services/strava/webhook.js';
import {
  parsePlexWebhook,
  verifyPlexWebhook,
  handlePlexWebhook,
} from '../services/plex/webhook.js';
import { TmdbClient } from '../services/watching/tmdb.js';
import { badRequest } from '../lib/errors.js';

const webhooks = new Hono<{ Bindings: Env }>();

// Strava webhook subscription validation (no auth required)
webhooks.get('/webhooks/strava', (c) => {
  const query = {
    'hub.mode': c.req.query('hub.mode'),
    'hub.challenge': c.req.query('hub.challenge'),
    'hub.verify_token': c.req.query('hub.verify_token'),
  };

  const result = validateSubscription(query, c.env.STRAVA_WEBHOOK_VERIFY_TOKEN);

  if (!result) {
    return badRequest(c, 'Invalid subscription validation');
  }

  return c.json(result);
});

// Strava webhook event receiver (no auth required)
webhooks.post('/webhooks/strava', async (c) => {
  const event = await c.req.json<StravaWebhookEvent>();
  const db = createDb(c.env.DB);

  await processWebhookEvent(event, c.env, db, c.executionCtx);

  // Must respond with 200 within 2 seconds
  return c.json({ status: 'ok' });
});

/**
 * POST /v1/webhooks/plex
 * Receives Plex webhook events (multipart/form-data).
 * No auth required -- uses its own verification.
 */
webhooks.post('/webhooks/plex', async (c) => {
  const payload = await parsePlexWebhook(c.req.raw);

  if (!payload) {
    return c.json({ error: 'Invalid webhook payload', status: 400 }, 400);
  }

  // Verify webhook source
  if (
    c.env.PLEX_WEBHOOK_SECRET &&
    !verifyPlexWebhook(payload, c.env.PLEX_WEBHOOK_SECRET)
  ) {
    console.log('[ERROR] Plex webhook verification failed');
    return c.json({ error: 'Webhook verification failed', status: 403 }, 403);
  }

  const db = createDb(c.env.DB);
  const tmdbClient = new TmdbClient(c.env.TMDB_API_KEY);

  const result = await handlePlexWebhook(db, payload, tmdbClient);

  return c.json({
    success: result.success,
    message: result.message,
  });
});

export default webhooks;
