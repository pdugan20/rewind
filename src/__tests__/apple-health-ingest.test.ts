import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  env,
  SELF,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import worker from '../index.js';
import {
  stravaActivities,
  stravaSplits,
  stravaPersonalRecords,
} from '../db/schema/strava.js';
import {
  activityFeed,
  revalidationHooks,
  syncRuns,
} from '../db/schema/system.js';
import { healthActivityId } from '../services/apple-health/transforms.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';

const TOKEN = 'pulso-test-token';
const BASE = 'https://test/v1/webhooks/apple-health';
const RUN_UUID = '0A1B2C3D-4E5F-4061-8273-94A5B6C7D8E9';

function run(uuid: string, start: string, end: string) {
  const startSec = Date.parse(start) / 1000;
  const route: Array<[number, number, number, number, number]> = [];
  for (let s = 0; s <= 1200; s += 2) {
    route.push([startSec + s, 47.6 + (s * 3) / 111195, -122.3, 20, 5]);
  }
  return {
    uuid,
    type: 'workout',
    workoutActivityType: 'running',
    start,
    end,
    source: 'Nike Run Club',
    duration: 1200,
    totalDistance: 3600,
    totalEnergyBurned: 250,
    averageHeartRate: 151,
    maximumHeartRate: 171,
    route,
    heartRateSeries: [[startSec + 60, 150]],
  };
}

async function gzip(value: unknown): Promise<ArrayBuffer> {
  const stream = new Blob([JSON.stringify(value)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

async function call(path: string, init: RequestInit = {}, token = TOKEN) {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', 'Bearer ' + token);
  const response = await worker.fetch(
    new Request(BASE + path, { ...init, headers }),
    { ...env, APPLE_HEALTH_INGEST_TOKEN: TOKEN },
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function ingest(batch: unknown[]) {
  return call('/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    body: await gzip(batch),
  });
}

async function searchEntries(activityId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM search_index WHERE domain = 'running' AND entity_id = ?"
  )
    .bind(String(activityId))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('Apple Health ingest (/v1/webhooks/apple-health)', () => {
  let readKey: string;

  beforeAll(async () => {
    await setupTestDb();
    readKey = await createTestApiKey({ name: 'health-read', scope: 'read' });
  });

  beforeEach(async () => {
    const db = drizzle(env.DB);
    await db.delete(stravaSplits);
    await db.delete(stravaPersonalRecords);
    await db.delete(stravaActivities);
    await db.delete(syncRuns);
    await db.delete(activityFeed);
    await env.DB.prepare(
      "DELETE FROM search_index WHERE domain = 'running'"
    ).run();
  });

  it('answers the Test Connection probe without a token', async () => {
    const res = await call('/health', {}, '');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('fails closed while the ingest token is not configured', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(BASE + '/latest', {
        headers: { Authorization: 'Bearer ' + TOKEN },
      }),
      { ...env, APPLE_HEALTH_INGEST_TOKEN: undefined },
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
  });

  it('rejects a wrong token and Rewind API keys', async () => {
    expect((await call('/latest', {}, 'wrong')).status).toBe(401);
    expect((await call('/latest', {}, readKey)).status).toBe(401);
  });

  it('stores runs, ignores other workouts, and reports the newest run', async () => {
    expect(await (await call('/latest')).json()).toEqual({});

    const res = await ingest([
      run(RUN_UUID, '2026-09-05T08:00:00-07:00', '2026-09-05T08:21:00-07:00'),
      {
        uuid: '11111111-2222-4333-8444-555555555555',
        type: 'workout',
        workoutActivityType: 'traditionalStrengthTraining',
        start: '2026-09-05T18:00:00-07:00',
        end: '2026-09-05T18:40:00-07:00',
        source: 'Apple Watch',
      },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      received: 2,
      new: 1,
      updated: 0,
      matched: 0,
      deleted: 0,
      ignored: 1,
    });

    const id = healthActivityId(RUN_UUID);
    const db = drizzle(env.DB);
    const [row] = await db
      .select()
      .from(stravaActivities)
      .where(eq(stravaActivities.stravaId, id));
    expect(row.source).toBe('apple_health');
    expect(row.sourceId).toBe(RUN_UUID);
    expect(row.name).toBe('Saturday Morning Run');
    expect(row.averageHeartrate).toBe(151);
    const splits = await db
      .select()
      .from(stravaSplits)
      .where(eq(stravaSplits.activityStravaId, id));
    expect(splits.length).toBe(3);
    const records = await db.select().from(stravaPersonalRecords);
    expect(records.map((r) => r.distance)).toContain('mile');
    const [syncRun] = await db.select().from(syncRuns);
    expect(syncRun).toMatchObject({
      domain: 'running',
      syncType: 'apple_health',
      status: 'completed',
    });

    expect(await (await call('/latest')).json()).toEqual({
      workout: '2026-09-05T15:21:00Z',
    });

    // The run is served by the existing running API under its new id.
    const detail = await SELF.fetch(
      'https://test/v1/running/activities/' + id,
      {
        headers: { Authorization: 'Bearer ' + readKey },
      }
    );
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id, distance_mi: 2.24, strava_url: null });
  });

  it('is idempotent when a batch is re-sent', async () => {
    const batch = [
      run(RUN_UUID, '2026-09-05T08:00:00-07:00', '2026-09-05T08:21:00-07:00'),
    ];
    await ingest(batch);
    const res = await ingest(batch);
    expect(await res.json()).toMatchObject({ new: 0, updated: 1 });
    const rows = await drizzle(env.DB).select().from(stravaActivities);
    expect(rows.length).toBe(1);
  });

  it('matches a run Strava already delivered and fills in its heart rate', async () => {
    const db = drizzle(env.DB);
    await db.insert(stravaActivities).values({
      stravaId: 19948948137,
      name: 'Nike Run Club: Saturday Morning Run',
      distanceMeters: 3600,
      distanceMiles: 2.24,
      startDate: '2026-09-05T15:00:36Z',
      startDateLocal: '2026-09-05T08:00:36Z',
    });

    const res = await ingest([
      run(RUN_UUID, '2026-09-05T08:00:00-07:00', '2026-09-05T08:21:00-07:00'),
    ]);
    expect(await res.json()).toMatchObject({ new: 0, matched: 1 });

    const rows = await db.select().from(stravaActivities);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      source: 'strava',
      averageHeartrate: 151,
      maxHeartrate: 171,
    });
  });

  it('soft deletes a run removed from Apple Health', async () => {
    await ingest([
      run(RUN_UUID, '2026-09-05T08:00:00-07:00', '2026-09-05T08:21:00-07:00'),
    ]);
    const res = await ingest([{ deleted: [RUN_UUID, 'not-a-uuid'] }]);
    expect(await res.json()).toMatchObject({ deleted: 1 });
    const [row] = await drizzle(env.DB).select().from(stravaActivities);
    expect(row.isDeleted).toBe(1);
  });

  it('drops the personal records a deleted run held', async () => {
    const db = drizzle(env.DB);
    await ingest([
      run(RUN_UUID, '2026-09-05T08:00:00-07:00', '2026-09-05T08:21:00-07:00'),
    ]);
    expect(
      (await db.select().from(stravaPersonalRecords)).length
    ).toBeGreaterThan(0);

    await ingest([{ deleted: [RUN_UUID] }]);
    expect(await db.select().from(stravaPersonalRecords)).toEqual([]);
  });

  it('sets no records for a run deleted in the same batch', async () => {
    const res = await ingest([
      run(RUN_UUID, '2026-09-05T08:00:00-07:00', '2026-09-05T08:21:00-07:00'),
      { deleted: [RUN_UUID] },
    ]);
    expect(await res.json()).toMatchObject({ new: 1, deleted: 1 });
    expect(await drizzle(env.DB).select().from(stravaPersonalRecords)).toEqual(
      []
    );
    expect(await searchEntries(healthActivityId(RUN_UUID))).toBe(0);
    expect(await drizzle(env.DB).select().from(activityFeed)).toEqual([]);
  });

  it('removes a deleted run from search and the feed', async () => {
    const id = healthActivityId(RUN_UUID);
    await ingest([
      run(RUN_UUID, '2026-09-05T08:00:00-07:00', '2026-09-05T08:21:00-07:00'),
    ]);
    expect(await searchEntries(id)).toBe(1);
    expect((await drizzle(env.DB).select().from(activityFeed)).length).toBe(1);

    await ingest([{ deleted: [RUN_UUID] }]);
    expect(await searchEntries(id)).toBe(0);
    expect(await drizzle(env.DB).select().from(activityFeed)).toEqual([]);
  });

  it('clears the records of a re-sent run that lost its route', async () => {
    const db = drizzle(env.DB);
    const original = run(
      RUN_UUID,
      '2026-09-05T08:00:00-07:00',
      '2026-09-05T08:21:00-07:00'
    );
    await ingest([original]);
    expect(
      (await db.select().from(stravaPersonalRecords)).length
    ).toBeGreaterThan(0);

    const res = await ingest([{ ...original, route: undefined }]);
    expect(await res.json()).toMatchObject({ updated: 1 });
    expect(await db.select().from(stravaPersonalRecords)).toEqual([]);
  });

  it('fires revalidation hooks for a batch that only deletes a run', async () => {
    const db = drizzle(env.DB);
    await ingest([
      run(RUN_UUID, '2026-09-05T08:00:00-07:00', '2026-09-05T08:21:00-07:00'),
    ]);
    await db.insert(revalidationHooks).values({
      url: 'https://example.com/revalidate',
      domain: 'running',
      secret: 'test-secret',
    });
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await ingest([{ deleted: [RUN_UUID] }]);
    } finally {
      vi.unstubAllGlobals();
      await db.delete(revalidationHooks);
    }
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/revalidate',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('rejects a body that is not a JSON array', async () => {
    const res = await call('/ingest', {
      method: 'POST',
      body: JSON.stringify({ not: 'an array' }),
    });
    expect(res.status).toBe(400);
  });
});
