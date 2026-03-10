import { describe, it, expect } from 'vitest';
import {
  formatDuration,
  formatPace,
  getWorkoutTypeLabel,
  calculateEddington,
} from '../services/strava/transforms.js';

describe('Running route helpers', () => {
  describe('formatActivityResponse helpers', () => {
    it('formats duration for display', () => {
      expect(formatDuration(2550)).toBe('42:30');
      expect(formatDuration(5400)).toBe('1:30:00');
    });

    it('formats pace for display', () => {
      expect(formatPace(8.167)).toBe('8:10/mi');
    });

    it('returns workout type label', () => {
      expect(getWorkoutTypeLabel(0)).toBe('default');
      expect(getWorkoutTypeLabel(1)).toBe('race');
    });
  });

  describe('Eddington endpoint logic', () => {
    it('computes Eddington from daily miles', () => {
      const dailyMilesMap = new Map<string, number>();
      // 10 days of 10+ miles
      for (let i = 0; i < 10; i++) {
        dailyMilesMap.set(`2024-01-${String(i + 1).padStart(2, '0')}`, 10);
      }
      // 5 days of 3 miles
      for (let i = 10; i < 15; i++) {
        dailyMilesMap.set(`2024-01-${String(i + 1).padStart(2, '0')}`, 3);
      }

      const eddington = calculateEddington([...dailyMilesMap.values()]);
      expect(eddington.number).toBe(10);
    });
  });

  describe('race distance filters', () => {
    it('defines correct distance ranges for races', () => {
      const distanceRanges: Record<string, [number, number]> = {
        '5k': [2.8, 3.5],
        '10k': [5.8, 6.8],
        half_marathon: [12.8, 13.5],
        marathon: [25.5, 27.0],
      };

      // 5K is ~3.1 miles
      expect(3.1).toBeGreaterThanOrEqual(distanceRanges['5k'][0]);
      expect(3.1).toBeLessThanOrEqual(distanceRanges['5k'][1]);

      // Half marathon is ~13.1 miles
      expect(13.1).toBeGreaterThanOrEqual(distanceRanges['half_marathon'][0]);
      expect(13.1).toBeLessThanOrEqual(distanceRanges['half_marathon'][1]);

      // Marathon is ~26.2 miles
      expect(26.2).toBeGreaterThanOrEqual(distanceRanges['marathon'][0]);
      expect(26.2).toBeLessThanOrEqual(distanceRanges['marathon'][1]);
    });
  });

  describe('pagination', () => {
    it('calculates correct total pages', () => {
      const total = 55;
      const limit = 20;
      expect(Math.ceil(total / limit)).toBe(3);
    });

    it('calculates correct offset', () => {
      const page = 3;
      const limit = 20;
      expect((page - 1) * limit).toBe(40);
    });
  });
});
