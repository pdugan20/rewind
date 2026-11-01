import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database } from '../../db/client.js';
import type { Env } from '../../types/env.js';
import { handleWebhookEvent, validateSubscription } from './webhook.js';
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
const db = {} as Database;

function deleteEvent(objectId: number): StravaWebhookEvent {
  return {
    aspect_type: 'delete',
    event_time: 1_700_000_000,
    object_id: objectId,
    object_type: 'activity',
    owner_id: 1,
    subscription_id: 1,
    updates: {},
  };
}

describe('Strava Webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    it('keeps the activity when Strava cannot be reached', async () => {
      mocks.activityExists.mockRejectedValue(new Error('Strava API failed'));

      await handleWebhookEvent(deleteEvent(42), env, db);

      expect(mocks.deleteActivity).not.toHaveBeenCalled();
    });
  });
});
