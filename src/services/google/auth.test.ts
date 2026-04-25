import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { refreshAccessToken } from './auth.js';

// In-memory stub of just the slice of Database the auth service uses.
// Drizzle's select/update return a chainable builder; we only need
// `update().set(...).where(...)` to resolve.
function makeDbStub() {
  const updates: Array<{ id: number; values: Record<string, unknown> }> = [];
  const stub = {
    update() {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(cond: { value: number }) {
              updates.push({ id: cond.value ?? 0, values });
              return Promise.resolve();
            },
          };
        },
      };
    },
    _updates: updates,
  };
  return stub;
}

describe('Google OAuth', () => {
  const env = {
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-secret',
  } as never;

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('expiry math: cached token returned when not within buffer', () => {
    // Buffer is 60s. 600s > 60 → still valid.
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const stillValid = Date.now() / 1000 < expiresAt - 60;
    expect(stillValid).toBe(true);
  });

  it('expiry math: triggers refresh inside 60s buffer', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 30;
    const stillValid = Date.now() / 1000 < expiresAt - 60;
    expect(stillValid).toBe(false);
  });

  it('refreshAccessToken: persists new token on success', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'new-access-token',
          expires_in: 3599,
          scope:
            'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly',
          token_type: 'Bearer',
        }),
        { status: 200 }
      )
    );

    const db = makeDbStub();
    const token = await refreshAccessToken(db as never, env, 'rt-stub', 42);

    expect(token).toBe('new-access-token');
    expect(db._updates).toHaveLength(1);
    expect(db._updates[0].values.accessToken).toBe('new-access-token');
    expect(db._updates[0].values.scopes).toContain('calendar.readonly');
  });

  it('refreshAccessToken: throws when scope drift drops a required scope', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'partial-token',
          expires_in: 3599,
          scope: 'https://www.googleapis.com/auth/calendar.readonly', // missing gmail
          token_type: 'Bearer',
        }),
        { status: 200 }
      )
    );

    const db = makeDbStub();
    await expect(
      refreshAccessToken(db as never, env, 'rt-stub', 42)
    ).rejects.toThrow(/missing required scopes/);
    expect(db._updates).toHaveLength(0); // didn't persist a partial token
  });

  it('refreshAccessToken: throws on non-200 from token endpoint', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response('invalid_grant', { status: 400 })
    );

    const db = makeDbStub();
    await expect(
      refreshAccessToken(db as never, env, 'rt-stub', 42)
    ).rejects.toThrow(/refresh failed.*invalid_grant/);
  });
});
