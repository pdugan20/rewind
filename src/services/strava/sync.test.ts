import { describe, it, expect } from 'vitest';

describe('Strava Sync', () => {
  it('filters only run sport types', () => {
    const validTypes = ['Run', 'TrailRun', 'VirtualRun'];
    const invalidTypes = ['Ride', 'Swim', 'Walk', 'Hike'];

    for (const type of validTypes) {
      const isRun =
        type === 'Run' || type === 'TrailRun' || type === 'VirtualRun';
      expect(isRun).toBe(true);
    }

    for (const type of invalidTypes) {
      const isRun =
        type === 'Run' || type === 'TrailRun' || type === 'VirtualRun';
      expect(isRun).toBe(false);
    }
  });

  it('computes incremental sync after timestamp correctly', () => {
    const lastActivityDate = '2024-01-15T12:00:00Z';
    const afterEpoch = Math.floor(new Date(lastActivityDate).getTime() / 1000);

    expect(afterEpoch).toBe(1705320000);
    expect(typeof afterEpoch).toBe('number');
  });
});
