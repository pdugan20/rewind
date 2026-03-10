import { eq, and } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { webhookEvents } from '../../db/schema/system.js';
import type { Env } from '../../types/env.js';
import { syncSingleActivity, deleteActivity } from './sync.js';

export interface StravaWebhookEvent {
  aspect_type: 'create' | 'update' | 'delete';
  event_time: number;
  object_id: number;
  object_type: 'activity' | 'athlete';
  owner_id: number;
  subscription_id: number;
  updates: Record<string, unknown>;
}

/**
 * Validate a Strava webhook subscription request.
 * Returns the challenge response or null if validation fails.
 */
export function validateSubscription(
  query: {
    'hub.mode'?: string;
    'hub.challenge'?: string;
    'hub.verify_token'?: string;
  },
  verifyToken: string
): { 'hub.challenge': string } | null {
  if (
    query['hub.mode'] === 'subscribe' &&
    query['hub.verify_token'] === verifyToken &&
    query['hub.challenge']
  ) {
    return { 'hub.challenge': query['hub.challenge'] };
  }
  return null;
}

/**
 * Process a Strava webhook event.
 * Returns true if the event was processed, false if it was a duplicate.
 */
export async function processWebhookEvent(
  event: StravaWebhookEvent,
  env: Env,
  db: Database,
  ctx: ExecutionContext
): Promise<boolean> {
  // Only handle activity events
  if (event.object_type !== 'activity') {
    console.log(
      `[INFO] Ignoring non-activity webhook event: ${event.object_type}`
    );
    return false;
  }

  const eventId = `${event.object_id}_${event.aspect_type}_${event.event_time}`;

  // Check idempotency
  const [existing] = await db
    .select()
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.eventSource, 'strava'),
        eq(webhookEvents.eventId, eventId)
      )
    )
    .limit(1);

  if (existing) {
    console.log(`[INFO] Duplicate webhook event: ${eventId}`);
    return false;
  }

  // Record the event
  await db.insert(webhookEvents).values({
    eventSource: 'strava',
    eventId,
    eventType: event.aspect_type,
  });

  // Process asynchronously to respond within 2 seconds
  ctx.waitUntil(handleEvent(event, env, db));

  return true;
}

async function handleEvent(
  event: StravaWebhookEvent,
  env: Env,
  db: Database
): Promise<void> {
  try {
    switch (event.aspect_type) {
      case 'create':
        console.log(`[SYNC] Webhook: new activity ${event.object_id}`);
        await syncSingleActivity(env, db, event.object_id);
        break;

      case 'update':
        console.log(`[SYNC] Webhook: updated activity ${event.object_id}`);
        await syncSingleActivity(env, db, event.object_id);
        break;

      case 'delete':
        console.log(`[SYNC] Webhook: deleted activity ${event.object_id}`);
        await deleteActivity(db, event.object_id);
        break;

      default:
        console.log(`[INFO] Unknown webhook aspect_type: ${event.aspect_type}`);
    }
  } catch (error) {
    console.log(
      `[ERROR] Webhook handler failed for ${event.object_id}: ${error}`
    );
  }
}
