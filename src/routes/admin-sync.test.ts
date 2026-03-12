import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createDb } from '../db/client.js';
import { stravaActivities, stravaYearSummaries } from '../db/schema/strava.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';
import { eq } from 'drizzle-orm';

describe('admin-sync endpoints', () => {
  let adminToken: string;

  beforeAll(async () => {
    await setupTestDb();
    adminToken = await createTestApiKey({ scope: 'admin' });
  });

  describe('DELETE /v1/admin/running/activities/:id', () => {
    it('requires admin auth', async () => {
      const res = await SELF.fetch(
        'http://localhost/v1/admin/running/activities/12345',
        { method: 'DELETE' }
      );
      expect(res.status).toBe(401);
    });

    it('rejects invalid activity ID', async () => {
      const res = await SELF.fetch(
        'http://localhost/v1/admin/running/activities/abc',
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(res.status).toBe(400);
    });

    it('soft-deletes an activity and recomputes stats', async () => {
      const db = createDb(env.DB);

      // Insert a test activity
      await db.insert(stravaActivities).values({
        stravaId: 99999,
        name: 'Test Run',
        sportType: 'Run',
        distanceMeters: 5000,
        distanceMiles: 3.1,
        movingTimeSeconds: 1800,
        elapsedTimeSeconds: 1900,
        totalElevationGainMeters: 30,
        totalElevationGainFeet: 98.4,
        startDate: '2024-06-15T12:00:00Z',
        startDateLocal: '2024-06-15T07:00:00',
        isRace: 0,
        isDeleted: 0,
      });

      const res = await SELF.fetch(
        'http://localhost/v1/admin/running/activities/99999',
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; strava_id: number };
      expect(body.status).toBe('deleted');
      expect(body.strava_id).toBe(99999);

      // Verify soft-deleted
      const [activity] = await db
        .select({ isDeleted: stravaActivities.isDeleted })
        .from(stravaActivities)
        .where(eq(stravaActivities.stravaId, 99999));

      expect(activity.isDeleted).toBe(1);
    });
  });

  describe('POST /v1/admin/running/recompute', () => {
    it('requires admin auth', async () => {
      const res = await SELF.fetch(
        'http://localhost/v1/admin/running/recompute',
        { method: 'POST' }
      );
      expect(res.status).toBe(401);
    });

    it('triggers full stats recomputation', async () => {
      const db = createDb(env.DB);

      // Clean up and insert test activities
      await db.delete(stravaActivities);
      await db.delete(stravaYearSummaries);

      await db.insert(stravaActivities).values([
        {
          stravaId: 10001,
          name: 'Morning Run',
          sportType: 'Run',
          distanceMeters: 8046,
          distanceMiles: 5.0,
          movingTimeSeconds: 2400,
          elapsedTimeSeconds: 2500,
          totalElevationGainMeters: 30,
          totalElevationGainFeet: 98.4,
          startDate: '2024-03-15T12:00:00Z',
          startDateLocal: '2024-03-15T07:00:00',
          isRace: 0,
          isDeleted: 0,
        },
        {
          stravaId: 10002,
          name: 'Evening Run',
          sportType: 'Run',
          distanceMeters: 16093,
          distanceMiles: 10.0,
          movingTimeSeconds: 5000,
          elapsedTimeSeconds: 5200,
          totalElevationGainMeters: 60,
          totalElevationGainFeet: 196.8,
          startDate: '2024-06-20T20:00:00Z',
          startDateLocal: '2024-06-20T15:00:00',
          isRace: 0,
          isDeleted: 0,
        },
      ]);

      const res = await SELF.fetch(
        'http://localhost/v1/admin/running/recompute',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        timestamp: string;
      };
      expect(body.status).toBe('completed');
      expect(body.timestamp).toBeTruthy();

      // Verify year summaries were created
      const summaries = await db.select().from(stravaYearSummaries);
      expect(summaries.length).toBeGreaterThan(0);
      const y2024 = summaries.find((s) => s.year === 2024);
      expect(y2024).toBeDefined();
      expect(y2024!.totalRuns).toBe(2);
      expect(y2024!.totalDistanceMiles).toBe(15.0);
    });
  });
});
