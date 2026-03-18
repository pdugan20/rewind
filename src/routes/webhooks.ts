import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses } from '../lib/schemas/common.js';
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
import { runPipeline } from '../services/images/pipeline.js';

const webhooks = createOpenAPIApp();

// --- Schemas ---

const StravaSubscriptionQuerySchema = z.object({
  'hub.mode': z.string().optional(),
  'hub.challenge': z.string().optional(),
  'hub.verify_token': z.string().optional(),
});

const StravaSubscriptionResponseSchema = z.object({
  'hub.challenge': z.string(),
});

const StravaWebhookEventSchema = z.object({
  aspect_type: z.enum(['create', 'update', 'delete']),
  event_time: z.number(),
  object_id: z.number(),
  object_type: z.enum(['activity', 'athlete']),
  owner_id: z.number(),
  subscription_id: z.number(),
  updates: z.record(z.string(), z.unknown()),
});

const StatusOkResponseSchema = z.object({
  status: z.literal('ok'),
});

const PlexWebhookResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

// --- Routes ---

const stravaValidationRoute = createRoute({
  method: 'get',
  path: '/webhooks/strava',
  operationId: 'validateStravaWebhook',
  tags: ['Webhooks'],
  summary: 'Strava webhook subscription validation',
  description:
    'Validates a Strava webhook subscription by echoing back the hub.challenge parameter. No auth required.',
  'x-internal': true,
  request: {
    query: StravaSubscriptionQuerySchema,
  },
  responses: {
    200: {
      description: 'Subscription validation successful',
      content: {
        'application/json': {
          schema: StravaSubscriptionResponseSchema,
        },
      },
    },
    ...errorResponses(400),
  },
});

webhooks.openapi(stravaValidationRoute, (c) => {
  const query = {
    'hub.mode': c.req.query('hub.mode'),
    'hub.challenge': c.req.query('hub.challenge'),
    'hub.verify_token': c.req.query('hub.verify_token'),
  };

  const result = validateSubscription(query, c.env.STRAVA_WEBHOOK_VERIFY_TOKEN);

  if (!result) {
    return c.json(
      { error: 'Invalid subscription validation', status: 400 },
      400
    ) as any;
  }

  return c.json(result, 200);
});

const stravaEventRoute = createRoute({
  method: 'post',
  path: '/webhooks/strava',
  operationId: 'receiveStravaWebhook',
  tags: ['Webhooks'],
  summary: 'Strava webhook event receiver',
  description:
    'Receives Strava webhook events for activity creates, updates, and deletes. Must respond within 2 seconds. No auth required.',
  'x-internal': true,
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: StravaWebhookEventSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Event received successfully',
      content: {
        'application/json': {
          schema: StatusOkResponseSchema,
        },
      },
    },
  },
});

webhooks.openapi(stravaEventRoute, async (c) => {
  const event = await c.req.json<StravaWebhookEvent>();
  const db = createDb(c.env.DB);

  await processWebhookEvent(event, c.env, db, c.executionCtx);

  // Must respond with 200 within 2 seconds
  return c.json({ status: 'ok' as const });
});

const plexWebhookRoute = createRoute({
  method: 'post',
  path: '/webhooks/plex',
  operationId: 'receivePlexWebhook',
  tags: ['Webhooks'],
  summary: 'Plex webhook event receiver',
  description:
    'Receives Plex webhook events (multipart/form-data). No auth required -- uses its own verification via PLEX_WEBHOOK_SECRET. Body is parsed manually to avoid double-consumption.',
  'x-internal': true,
  responses: {
    200: {
      description: 'Webhook processed successfully',
      content: {
        'application/json': {
          schema: PlexWebhookResponseSchema,
        },
      },
    },
    ...errorResponses(400, 403),
  },
});

webhooks.openapi(plexWebhookRoute, async (c) => {
  const payload = await parsePlexWebhook(c.req.raw);

  if (!payload) {
    return c.json(
      { error: 'Invalid webhook payload', status: 400 },
      400
    ) as any;
  }

  // Verify webhook source
  if (
    c.env.PLEX_WEBHOOK_SECRET &&
    !verifyPlexWebhook(payload, c.env.PLEX_WEBHOOK_SECRET)
  ) {
    console.log('[ERROR] Plex webhook verification failed');
    return c.json(
      { error: 'Webhook verification failed', status: 403 },
      403
    ) as any;
  }

  const db = createDb(c.env.DB);
  const tmdbClient = new TmdbClient(c.env.TMDB_API_KEY);

  const result = await handlePlexWebhook(db, payload, tmdbClient);

  // Process image in the background so artwork is available immediately
  if (result.entity) {
    const { type, id, tmdbId } = result.entity;
    c.executionCtx.waitUntil(
      runPipeline(db, c.env, {
        domain: 'watching',
        entityType: type,
        entityId: id,
        tmdbId,
      }).catch((error) => {
        console.log(
          `[ERROR] Webhook image pipeline failed for ${type}/${id}: ${error instanceof Error ? error.message : String(error)}`
        );
      })
    );
  }

  return c.json(
    {
      success: result.success,
      message: result.message,
    },
    200
  );
});

export default webhooks;
