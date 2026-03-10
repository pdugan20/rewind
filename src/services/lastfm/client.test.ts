import { describe, it, expect } from 'vitest';
import { LastfmClient, LASTFM_PERIODS } from './client.js';

describe('LastfmClient', () => {
  it('exports all 6 time periods', () => {
    expect(LASTFM_PERIODS).toEqual([
      '7day',
      '1month',
      '3month',
      '6month',
      '12month',
      'overall',
    ]);
  });

  it('constructs with api key and username', () => {
    const client = new LastfmClient('test-key', 'test-user');
    expect(client).toBeDefined();
  });
});
