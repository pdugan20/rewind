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
  verifyPlexWebhookToken,
  handlePlexWebhook,
} from '../services/plex/webhook.js';
import { TmdbClient } from '../services/watching/tmdb.js';
import { runPipeline } from '../services/images/pipeline.js';
import {
  ingestHealthBatch,
  latestRunEnd,
} from '../services/apple-health/ingest.js';
import type { Env } from '../types/env.js';

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
  'x-hidden': true,
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
  'x-hidden': true,
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
  'x-hidden': true,
  tags: ['Webhooks'],
  summary: 'Plex webhook event receiver',
  description:
    'Receives Plex webhook events (multipart/form-data). No auth required -- verified by the secret token in the webhook URL (PLEX_WEBHOOK_TOKEN). Body is parsed manually to avoid double-consumption.',
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

  // Plex doesn't sign webhooks, so the secret token in the configured webhook
  // URL is the only proof of origin. Fails closed when PLEX_WEBHOOK_TOKEN is unset.
  if (!verifyPlexWebhookToken(c.req.query('token'), c.env.PLEX_WEBHOOK_TOKEN)) {
    console.log(
      c.env.PLEX_WEBHOOK_TOKEN
        ? '[ERROR] Plex webhook verification failed'
        : '[ERROR] Plex webhook rejected: PLEX_WEBHOOK_TOKEN is not set'
    );
    return c.json(
      { error: 'Webhook verification failed', status: 403 },
      403
    ) as any;
  }

  const db = createDb(c.env.DB);
  const tmdbClient = new TmdbClient(c.env.TMDB_API_KEY);

  const result = await handlePlexWebhook(
    db,
    payload,
    tmdbClient,
    c.env.PLEX_OWNER_ACCOUNT_TITLE
  );

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

// --- Apple Health (Pulso iPhone app) ---
//
// Pulso appends /health, /latest, and /ingest to the base URL configured in
// the app: https://api.rewind.rest/v1/webhooks/apple-health. /latest and
// /ingest require APPLE_HEALTH_INGEST_TOKEN as a bearer token; that token
// only grants this ingest, never Rewind's read or admin API.

const PulsoHealthResponseSchema = z.object({ status: z.literal('ok') });
const PulsoLatestResponseSchema = z.record(z.string(), z.string());
const PulsoIngestResponseSchema = z.object({
  received: z.number(),
  new: z.number(),
  updated: z.number(),
  matched: z.number(),
  deleted: z.number(),
  ignored: z.number(),
});

/** Largest batch accepted after decompression (Pulso caps batches at 8 MB). */
const MAX_INGEST_BYTES = 16 * 1024 * 1024;

type IngestAuth = 'ok' | 'unconfigured' | 'unauthorized';

async function verifyIngestToken(
  env: Env,
  header: string | undefined
): Promise<IngestAuth> {
  const expected = env.APPLE_HEALTH_INGEST_TOKEN;
  if (!expected) return 'unconfigured';
  const provided = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  // Compare fixed-length digests without an early exit.
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0 ? 'ok' : 'unauthorized';
}

function ingestAuthError(auth: Exclude<IngestAuth, 'ok'>) {
  return auth === 'unconfigured'
    ? {
        body: { error: 'Apple Health ingest is not configured', status: 503 },
        status: 503 as const,
      }
    : { body: { error: 'Unauthorized', status: 401 }, status: 401 as const };
}

/** Pulso always gzips; plain JSON is accepted too, for curl and tests. */
async function readIngestBody(request: Request): Promise<unknown> {
  const raw = new Uint8Array(await request.arrayBuffer());
  let bytes = raw;
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    const stream = new Blob([raw])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (bytes.length > MAX_INGEST_BYTES) {
    throw new Error('Batch too large');
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

const appleHealthCheckRoute = createRoute({
  method: 'get',
  path: '/webhooks/apple-health/health',
  operationId: 'checkAppleHealthIngest',
  'x-hidden': true,
  tags: ['Webhooks'],
  summary: 'Apple Health ingest liveness',
  description:
    "Liveness probe for the Pulso app's Test Connection button. No auth required.",
  'x-internal': true,
  responses: {
    200: {
      description: 'Ingest endpoint is reachable',
      content: { 'application/json': { schema: PulsoHealthResponseSchema } },
    },
  },
});

webhooks.openapi(appleHealthCheckRoute, (c) =>
  c.json({ status: 'ok' as const }, 200)
);

const appleHealthLatestRoute = createRoute({
  method: 'get',
  path: '/webhooks/apple-health/latest',
  operationId: 'getAppleHealthLatest',
  'x-hidden': true,
  tags: ['Webhooks'],
  summary: 'Newest run Rewind holds',
  description:
    'Returns { "workout": <end time of the newest run> } so a fresh Pulso install only sends recent runs. Requires APPLE_HEALTH_INGEST_TOKEN.',
  'x-internal': true,
  responses: {
    200: {
      description: 'Newest stored timestamp per Pulso type',
      content: { 'application/json': { schema: PulsoLatestResponseSchema } },
    },
    ...errorResponses(401),
  },
});

webhooks.openapi(appleHealthLatestRoute, async (c) => {
  const auth = await verifyIngestToken(c.env, c.req.header('Authorization'));
  if (auth !== 'ok') {
    const error = ingestAuthError(auth);
    return c.json(error.body, error.status) as any;
  }
  const db = createDb(c.env.DB);
  return c.json(await latestRunEnd(db), 200);
});

const appleHealthIngestRoute = createRoute({
  method: 'post',
  path: '/webhooks/apple-health/ingest',
  operationId: 'receiveAppleHealthBatch',
  'x-hidden': true,
  tags: ['Webhooks'],
  summary: 'Apple Health batch receiver',
  description:
    'Receives Pulso batches (a JSON array of samples and deletion tombstones, usually gzipped) and stores running workouts. Requires APPLE_HEALTH_INGEST_TOKEN. Body is parsed manually to support gzip.',
  'x-internal': true,
  responses: {
    200: {
      description: 'Batch stored',
      content: { 'application/json': { schema: PulsoIngestResponseSchema } },
    },
    ...errorResponses(400, 401),
  },
});

webhooks.openapi(appleHealthIngestRoute, async (c) => {
  const auth = await verifyIngestToken(c.env, c.req.header('Authorization'));
  if (auth !== 'ok') {
    const error = ingestAuthError(auth);
    return c.json(error.body, error.status) as any;
  }

  let body: unknown;
  try {
    body = await readIngestBody(c.req.raw);
  } catch (error) {
    console.log(
      '[ERROR] Apple Health batch unreadable: ' +
        (error instanceof Error ? error.message : String(error))
    );
    return c.json({ error: 'Invalid batch', status: 400 }, 400) as any;
  }
  if (!Array.isArray(body)) {
    return c.json(
      { error: 'Batch must be a JSON array', status: 400 },
      400
    ) as any;
  }

  const db = createDb(c.env.DB);
  const result = await ingestHealthBatch(db, body);
  return c.json(result, 200);
});

export default webhooks;
