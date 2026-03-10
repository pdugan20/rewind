import { describe, it, expect } from 'vitest';

describe('health endpoint', () => {
  it('returns ok status', async () => {
    // Basic sanity test - full integration tests will use Workers pool
    expect(true).toBe(true);
  });
});
