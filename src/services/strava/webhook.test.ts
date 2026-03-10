import { describe, it, expect } from 'vitest';
import { validateSubscription } from './webhook.js';

describe('Strava Webhook', () => {
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
});
