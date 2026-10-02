import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createDb } from '../db/client.js';
import { latelySnapshots } from '../db/schema/lately.js';
import { createTestApiKey, setupTestDb } from '../test-helpers.js';
import { policyKey } from '../services/lately/policy.js';
import { LatelySnapshot } from '../services/lately/schema.js';

const saved = {
  schema_version: 1,
  version: 1,
  as_of: '2026-09-01T12:00:00.000Z',
  music_checked_at: '2026-09-01T12:00:00.000Z',
  movie_checked_at: '2026-09-01T12:00:00.000Z',
  music: {
    event_id: 'scrobble:test',
    track_id: 1,
    name: 'Test Song',
    artist: 'Test Artist',
    album: 'Test Album',
    scrobbled_at: '2026-09-01T11:59:00.000Z',
    image: null,
  },
  movie: null,
};

describe('GET /v1/lately', () => {
  let token: string;
  let otherToken: string;
  beforeAll(async () => {
    await setupTestDb();
    token = await createTestApiKey({ name: 'lately-owner', scope: 'read' });
    otherToken = await createTestApiKey({
      name: 'lately-other',
      scope: 'read',
      userId: 2,
    });
  });
  beforeEach(async () => {
    await createDb(env.DB).delete(latelySnapshots);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('External requests forbidden')
    );
  });
  afterEach(() => vi.restoreAllMocks());
  const request = (key = token) =>
    SELF.fetch('https://example.test/v1/lately', {
      headers: { Authorization: `Bearer ${key}` },
    });

  it('requires authentication before snapshot access', async () => {
    const res = await SELF.fetch('https://example.test/v1/lately');
    expect(res.status).toBe(401);
  });

  it('returns a retryable cold state without fetching providers or seeding a row', async () => {
    const res = await request();
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await createDb(env.DB).select().from(latelySnapshots)).toHaveLength(
      0
    );
  });

  it('serves the exact saved pair with no shared HTTP caching', async () => {
    await createDb(env.DB)
      .insert(latelySnapshots)
      .values({
        userId: 1,
        snapshot: JSON.stringify(saved),
        policy: policyKey([202]),
      });
    for (let i = 0; i < 2; i++) {
      const res = await request();
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(res.headers.get('Vary')).toContain('Authorization');
      expect(LatelySnapshot.parse(await res.json())).toEqual(saved);
    }
  });

  it('never returns the owner snapshot to another valid user, including cached auth', async () => {
    await createDb(env.DB)
      .insert(latelySnapshots)
      .values({
        userId: 1,
        snapshot: JSON.stringify(saved),
        policy: policyKey([202]),
      });
    expect((await request()).status).toBe(200);
    expect((await request(otherToken)).status).toBe(503);
    expect((await request(otherToken)).status).toBe(503);
  });

  it('fails closed when the stored exclusion policy is out of date', async () => {
    await createDb(env.DB)
      .insert(latelySnapshots)
      .values({
        userId: 1,
        snapshot: JSON.stringify(saved),
        policy: policyKey([]),
      });
    expect((await request()).status).toBe(503);
  });

  it('does not expose malformed saved content or database errors', async () => {
    await createDb(env.DB)
      .insert(latelySnapshots)
      .values({ userId: 1, snapshot: '{invalid', policy: policyKey([202]) });
    const res = await request();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Lately snapshot not ready',
      status: 503,
    });
  });
});
