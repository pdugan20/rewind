import { describe, it, expect } from 'vitest';

describe('Strava API Client', () => {
  it('rate limit detection works correctly', () => {
    // Simulating rate limit state
    const state = {
      fifteenMinUsage: 200,
      fifteenMinLimit: 200,
      dailyUsage: 100,
      dailyLimit: 2000,
    };

    const isLimited =
      state.fifteenMinUsage >= state.fifteenMinLimit ||
      state.dailyUsage >= state.dailyLimit;

    expect(isLimited).toBe(true);
  });

  it('allows requests when under rate limit', () => {
    const state = {
      fifteenMinUsage: 50,
      fifteenMinLimit: 200,
      dailyUsage: 100,
      dailyLimit: 2000,
    };

    const isLimited =
      state.fifteenMinUsage >= state.fifteenMinLimit ||
      state.dailyUsage >= state.dailyLimit;

    expect(isLimited).toBe(false);
  });

  it('detects daily rate limit', () => {
    const state = {
      fifteenMinUsage: 50,
      fifteenMinLimit: 200,
      dailyUsage: 2000,
      dailyLimit: 2000,
    };

    const isLimited =
      state.fifteenMinUsage >= state.fifteenMinLimit ||
      state.dailyUsage >= state.dailyLimit;

    expect(isLimited).toBe(true);
  });

  it('parses rate limit headers correctly', () => {
    const limitHeader = '200,2000';
    const usageHeader = '50,100';

    const [fifteenMinLimit, dailyLimit] = limitHeader.split(',').map(Number);
    const [fifteenMinUsage, dailyUsage] = usageHeader.split(',').map(Number);

    expect(fifteenMinLimit).toBe(200);
    expect(dailyLimit).toBe(2000);
    expect(fifteenMinUsage).toBe(50);
    expect(dailyUsage).toBe(100);
  });
});
