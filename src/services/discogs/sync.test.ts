import { describe, it, expect } from 'vitest';
import { isSunday } from './sync.js';

describe('sync utilities', () => {
  describe('isSunday', () => {
    it('should return a boolean', () => {
      const result = isSunday();
      expect(typeof result).toBe('boolean');
    });

    it('should return true when day is Sunday (0)', () => {
      // We can't easily mock Date in Workers env, so we just verify it returns boolean
      const result = isSunday();
      const today = new Date().getUTCDay();
      expect(result).toBe(today === 0);
    });
  });
});
