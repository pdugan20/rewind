import { eq, and, asc, lte } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { webhookEvents } from '../../db/schema/system.js';
import type { Env } from '../../types/env.js';
import { StravaClient } from './client.js';
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

/** Attempts before an event is marked failed and left for manual review. */
export const MAX_WEBHOOK_ATTEMPTS = 8;

/**
 * How long an attempt owns a pending event. A Worker killed mid-attempt
 * leaves the event pending, and the retry cron picks it up once this lapses.
 */
const ATTEMPT_LEASE_MS = 15 * 60 * 1000;

/** Events retried per cron run, to stay well inside Strava's rate limits. */
const RETRY_BATCH_SIZE = 10;

const MAX_RETRY_DELAY_MS = 12 * 60 * 60 * 1000;

/** 15 min after the first failure, doubling up to 12 h. */
function retryDelayMs(attempts: number): number {
  return Math.min(ATTEMPT_LEASE_MS * 2 ** (attempts - 1), MAX_RETRY_DELAY_MS);
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
 * Records the event as pending before acknowledging it, then applies it in
 * the background. Strava won't redeliver after a 200, so a failed attempt is
 * retried from the recorded payload by retryPendingWebhookEvents.
 * Returns true if the event was recorded, false if it was ignored or a duplicate.
 */
export async function processWebhookEvent(
  event: StravaWebhookEvent,
  env: Env,
  db: Database,
  ctx: Pick<ExecutionContext, 'waitUntil'>
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

  const [recorded] = await db
    .insert(webhookEvents)
    .values({
      eventSource: 'strava',
      eventId,
      eventType: event.aspect_type,
      status: 'pending',
      payload: JSON.stringify(event),
      // Count the attempt before it runs, so one that's killed mid-run
      // still counts toward MAX_WEBHOOK_ATTEMPTS.
      attempts: 1,
      nextAttemptAt: new Date(Date.now() + ATTEMPT_LEASE_MS).toISOString(),
    })
    .returning({ id: webhookEvents.id });

  // Process asynchronously to respond within 2 seconds
  ctx.waitUntil(attemptRecordedEvent(env, db, recorded.id, event, 1));

  return true;
}

/**
 * Retry pending Strava events whose next attempt is due. Each row is claimed
 * before it runs so overlapping cron runs don't process it twice, and the
 * claim counts the attempt so interrupted runs still reach the limit.
 * Returns the number of events attempted.
 */
export async function retryPendingWebhookEvents(
  env: Env,
  db: Database,
  now: number = Date.now()
): Promise<number> {
  const nowIso = new Date(now).toISOString();
  const due = and(
    eq(webhookEvents.eventSource, 'strava'),
    eq(webhookEvents.status, 'pending'),
    lte(webhookEvents.nextAttemptAt, nowIso)
  );

  const rows = await db
    .select({
      id: webhookEvents.id,
      payload: webhookEvents.payload,
      attempts: webhookEvents.attempts,
    })
    .from(webhookEvents)
    .where(due)
    .orderBy(asc(webhookEvents.nextAttemptAt))
    .limit(RETRY_BATCH_SIZE);

  let attempted = 0;
  for (const row of rows) {
    if (row.attempts >= MAX_WEBHOOK_ATTEMPTS) {
      // Every attempt was interrupted before it could record an outcome.
      await markFailed(
        db,
        row.id,
        `Gave up after ${row.attempts} interrupted attempts`
      );
      continue;
    }

    const attempts = row.attempts + 1;
    const claimed = await db
      .update(webhookEvents)
      .set({
        attempts,
        nextAttemptAt: new Date(now + ATTEMPT_LEASE_MS).toISOString(),
      })
      .where(
        and(
          eq(webhookEvents.id, row.id),
          eq(webhookEvents.attempts, row.attempts),
          due
        )
      )
      .returning({ id: webhookEvents.id });
    if (claimed.length === 0) continue;

    const event = parsePayload(row.payload);
    if (!event) {
      await markFailed(db, row.id, 'Unreadable event payload');
      continue;
    }

    await attemptRecordedEvent(env, db, row.id, event, attempts);
    attempted++;
  }

  if (attempted > 0) {
    console.log(`[SYNC] Retried ${attempted} pending Strava webhook events`);
  }
  return attempted;
}

async function markFailed(
  db: Database,
  id: number,
  reason: string
): Promise<void> {
  await db
    .update(webhookEvents)
    .set({ status: 'failed', nextAttemptAt: null, lastError: reason })
    .where(eq(webhookEvents.id, id));
  console.log(`[ERROR] Strava webhook event ${id} failed: ${reason}`);
}

function parsePayload(payload: string | null): StravaWebhookEvent | null {
  if (!payload) return null;
  try {
    const event = JSON.parse(payload) as StravaWebhookEvent;
    return typeof event.object_id === 'number' ? event : null;
  } catch {
    return null;
  }
}

/**
 * Run an already-counted attempt at a recorded event and store the outcome:
 * done on success, pending with backoff on failure, failed once attempts run out.
 */
async function attemptRecordedEvent(
  env: Env,
  db: Database,
  id: number,
  event: StravaWebhookEvent,
  attempts: number
): Promise<void> {
  try {
    await handleWebhookEvent(event, env, db);
    await db
      .update(webhookEvents)
      .set({ status: 'done', nextAttemptAt: null, lastError: null })
      .where(eq(webhookEvents.id, id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = attempts >= MAX_WEBHOOK_ATTEMPTS;
    try {
      await db
        .update(webhookEvents)
        .set({
          status: exhausted ? 'failed' : 'pending',
          nextAttemptAt: exhausted
            ? null
            : new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
          lastError: message.slice(0, 500),
        })
        .where(eq(webhookEvents.id, id));
    } catch (updateError) {
      // The lease still lapses, so the retry cron will pick the event up.
      console.log(
        `[ERROR] Could not record Strava webhook attempt for event ${id}: ${updateError}`
      );
    }
    console.log(
      exhausted
        ? `[ERROR] Strava webhook ${event.aspect_type} for activity ${event.object_id} failed after ${attempts} attempts: ${message}`
        : `[ERROR] Strava webhook ${event.aspect_type} for activity ${event.object_id} failed (attempt ${attempts}), will retry: ${message}`
    );
  }
}

/**
 * Apply a webhook event. Strava doesn't sign webhook requests, so delete
 * events are confirmed against the Strava API before any data changes.
 * Throws when the event couldn't be applied, so the caller can retry it.
 */
export async function handleWebhookEvent(
  event: StravaWebhookEvent,
  env: Env,
  db: Database
): Promise<void> {
  switch (event.aspect_type) {
    case 'create':
      console.log(`[SYNC] Webhook: new activity ${event.object_id}`);
      await syncSingleActivity(env, db, event.object_id);
      break;

    case 'update':
      console.log(`[SYNC] Webhook: updated activity ${event.object_id}`);
      await syncSingleActivity(env, db, event.object_id);
      break;

    case 'delete': {
      const client = new StravaClient(env, db);
      if (await client.activityExists(event.object_id)) {
        console.log(
          `[INFO] Ignoring delete webhook: activity ${event.object_id} still exists on Strava`
        );
        break;
      }
      console.log(`[SYNC] Webhook: deleted activity ${event.object_id}`);
      await deleteActivity(db, event.object_id);
      break;
    }

    default:
      console.log(`[INFO] Unknown webhook aspect_type: ${event.aspect_type}`);
  }
}
