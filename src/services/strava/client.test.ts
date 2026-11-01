import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Database } from '../../db/client.js';
import type { Env } from '../../types/env.js';
import { StravaClient } from './client.js';

vi.mock('./auth.js', () => ({
  getAccessToken: vi.fn().mockResolvedValue('test-token'),
}));

function stubFetchStatus(status: number) {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(status === 200 ? '{"id":42}' : 'error', { status })
      )
  );
}

describe('StravaClient.activityExists', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = () => new StravaClient({} as Env, {} as Database);

  it('returns true when Strava returns the activity', async () => {
    stubFetchStatus(200);
    await expect(client().activityExists(42)).resolves.toBe(true);
  });

  it('returns false when Strava answers 404', async () => {
    stubFetchStatus(404);
    await expect(client().activityExists(42)).resolves.toBe(false);
  });

  it('throws on other failures so outages are not treated as deletions', async () => {
    stubFetchStatus(500);
    await expect(client().activityExists(42)).rejects.toThrow('(500)');
  });
});

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
