import { Hono } from 'hono';
import type { Env } from '../types/env.js';
import { createDb } from '../db/client.js';
import {
  parsePlexWebhook,
  verifyPlexWebhook,
  handlePlexWebhook,
} from '../services/plex/webhook.js';
import { TmdbClient } from '../services/watching/tmdb.js';

const webhooks = new Hono<{ Bindings: Env }>();

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
