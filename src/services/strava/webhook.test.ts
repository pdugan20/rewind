import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { env as testEnv } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import { webhookEvents } from '../../db/schema/system.js';
import { setupTestDb } from '../../test-helpers.js';
import type { Env } from '../../types/env.js';
import {
  MAX_WEBHOOK_ATTEMPTS,
  handleWebhookEvent,
  processWebhookEvent,
  retryPendingWebhookEvents,
  validateSubscription,
} from './webhook.js';
import type { StravaWebhookEvent } from './webhook.js';

const mocks = vi.hoisted(() => ({
  activityExists: vi.fn(),
  deleteActivity: vi.fn(),
  syncSingleActivity: vi.fn(),
}));

vi.mock('./client.js', () => ({
  StravaClient: class {
    activityExists = mocks.activityExists;
  },
}));

vi.mock('./sync.js', () => ({
  deleteActivity: mocks.deleteActivity,
  syncSingleActivity: mocks.syncSingleActivity,
}));

const env = {} as Env;
const db = createDb(testEnv.DB);

function deleteEvent(
  objectId: number,
  eventTime = 1_700_000_000
): StravaWebhookEvent {
  return {
    aspect_type: 'delete',
    event_time: eventTime,
    object_id: objectId,
    object_type: 'activity',
    owner_id: 1,
    subscription_id: 1,
    updates: {},
  };
}

/** Collects waitUntil work so tests can await the background attempt. */
function backgroundContext() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
    settle: () => Promise.all(pending),
  };
}

async function storedEvent(objectId: number) {
  const rows = await db.select().from(webhookEvents);
  return rows.find((row) => row.eventId.startsWith(`${objectId}_`));
}

const FAR_FUTURE = Date.parse('2100-01-01T00:00:00Z');

describe('Strava Webhook', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.activityExists.mockReset();
    await db.delete(webhookEvents);
  });

  describe('validateSubscription', () => {
    it('returns challenge when valid', () => {
      const query = {
        'hub.mode': 'subscribe',
        'hub.challenge': 'abc123',
        'hub.verify_token': 'my-token',
      };

      const result = validateSubscription(query, 'my-token');
      expect(result).toEqual({ 'hub.challenge': 'abc123' });
    });

    it('returns null for wrong verify token', () => {
      const query = {
        'hub.mode': 'subscribe',
        'hub.challenge': 'abc123',
        'hub.verify_token': 'wrong-token',
      };

      const result = validateSubscription(query, 'my-token');
      expect(result).toBeNull();
    });

    it('returns null for wrong mode', () => {
      const query = {
        'hub.mode': 'unsubscribe',
        'hub.challenge': 'abc123',
        'hub.verify_token': 'my-token',
      };

      const result = validateSubscription(query, 'my-token');
      expect(result).toBeNull();
    });

    it('returns null for missing challenge', () => {
      const query = {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'my-token',
      };

      const result = validateSubscription(query, 'my-token');
      expect(result).toBeNull();
    });

    it('returns null for missing params', () => {
      const result = validateSubscription({}, 'my-token');
      expect(result).toBeNull();
    });
  });

  describe('handleWebhookEvent delete', () => {
    it('soft-deletes when Strava confirms the activity is gone', async () => {
      mocks.activityExists.mockResolvedValue(false);

      await handleWebhookEvent(deleteEvent(42), env, db);

      expect(mocks.activityExists).toHaveBeenCalledWith(42);
      expect(mocks.deleteActivity).toHaveBeenCalledWith(db, 42);
    });

    it('ignores a delete for an activity that still exists', async () => {
      mocks.activityExists.mockResolvedValue(true);

      await handleWebhookEvent(deleteEvent(42), env, db);

      expect(mocks.deleteActivity).not.toHaveBeenCalled();
    });

    it('throws without deleting when Strava cannot be reached', async () => {
      mocks.activityExists.mockRejectedValue(new Error('Strava API failed'));

      await expect(
        handleWebhookEvent(deleteEvent(42), env, db)
      ).rejects.toThrow('Strava API failed');

      expect(mocks.deleteActivity).not.toHaveBeenCalled();
    });
  });

  describe('durable retry', () => {
    it('marks an event done once it applies', async () => {
      mocks.activityExists.mockResolvedValue(false);
      const { ctx, settle } = backgroundContext();

      expect(await processWebhookEvent(deleteEvent(7), env, db, ctx)).toBe(
        true
      );
      await settle();

      const row = await storedEvent(7);
      expect(row).toMatchObject({
        status: 'done',
        attempts: 1,
        lastError: null,
      });
      expect(mocks.deleteActivity).toHaveBeenCalledWith(db, 7);
    });

    it('retries a failed delete and applies it on a later run', async () => {
      mocks.activityExists.mockRejectedValueOnce(
        new Error('Strava API /activities/8 failed (429)')
      );
      const { ctx, settle } = backgroundContext();

      await processWebhookEvent(deleteEvent(8), env, db, ctx);
      await settle();

      const failed = await storedEvent(8);
      expect(failed).toMatchObject({ status: 'pending', attempts: 1 });
      expect(failed?.lastError).toContain('429');
      expect(Date.parse(failed!.nextAttemptAt!)).toBeGreaterThan(Date.now());
      expect(mocks.deleteActivity).not.toHaveBeenCalled();

      // Not due yet, so an immediate cron run leaves it alone.
      expect(await retryPendingWebhookEvents(env, db)).toBe(0);

      mocks.activityExists.mockResolvedValue(false);
      expect(await retryPendingWebhookEvents(env, db, FAR_FUTURE)).toBe(1);

      expect(await storedEvent(8)).toMatchObject({
        status: 'done',
        attempts: 2,
      });
      expect(mocks.deleteActivity).toHaveBeenCalledWith(db, 8);
    });

    it('rejects a redelivered event as a duplicate', async () => {
      mocks.activityExists.mockResolvedValue(false);
      const { ctx, settle } = backgroundContext();

      expect(await processWebhookEvent(deleteEvent(9), env, db, ctx)).toBe(
        true
      );
      expect(await processWebhookEvent(deleteEvent(9), env, db, ctx)).toBe(
        false
      );
      await settle();

      expect(mocks.deleteActivity).toHaveBeenCalledTimes(1);
    });

    it('marks an event failed after the last attempt', async () => {
      mocks.activityExists.mockRejectedValue(
        new Error('Strava API down (503)')
      );
      const { ctx, settle } = backgroundContext();

      await processWebhookEvent(deleteEvent(10), env, db, ctx);
      await settle();
      const row = await storedEvent(10);
      await db
        .update(webhookEvents)
        .set({ attempts: MAX_WEBHOOK_ATTEMPTS - 1 })
        .where(eq(webhookEvents.id, row!.id));

      await retryPendingWebhookEvents(env, db, FAR_FUTURE);

      expect(await storedEvent(10)).toMatchObject({
        status: 'failed',
        attempts: MAX_WEBHOOK_ATTEMPTS,
        nextAttemptAt: null,
      });
      expect(await retryPendingWebhookEvents(env, db, FAR_FUTURE)).toBe(0);
      expect(mocks.deleteActivity).not.toHaveBeenCalled();
    });
  });
});
