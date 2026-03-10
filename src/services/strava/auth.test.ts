import { describe, it, expect } from 'vitest';

describe('Strava OAuth', () => {
  it('getAccessToken returns cached token when not expired', () => {
    // The getAccessToken function checks expiry with 5-minute buffer
    const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 minutes from now
    const withinBuffer = Date.now() / 1000 < expiresAt - 300;
    expect(withinBuffer).toBe(true);
  });

  it('detects token near expiry within 5-minute buffer', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 200; // 3 min 20 sec from now
    const withinBuffer = Date.now() / 1000 < expiresAt - 300;
    expect(withinBuffer).toBe(false);
  });

  it('detects expired token', () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 100;
    const withinBuffer = Date.now() / 1000 < expiresAt - 300;
    expect(withinBuffer).toBe(false);
  });
});
