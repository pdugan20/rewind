import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createDb, type Database } from '../../db/client.js';
import {
  stravaActivities,
  stravaYearSummaries,
  stravaLifetimeStats,
} from '../../db/schema/strava.js';
import { setupTestDb } from '../../test-helpers.js';
import { recomputeStats } from './sync.js';
import { eq } from 'drizzle-orm';

function makeActivity(overrides: {
  stravaId: number;
  startDateLocal: string;
  distanceMiles: number;
  movingTimeSeconds: number;
  elevationFeet?: number;
  isRace?: boolean;
}) {
  return {
    stravaId: overrides.stravaId,
    name: `Run ${overrides.stravaId}`,
    sportType: 'Run',
    distanceMeters: overrides.distanceMiles * 1609.34,
    distanceMiles: overrides.distanceMiles,
    movingTimeSeconds: overrides.movingTimeSeconds,
    elapsedTimeSeconds: overrides.movingTimeSeconds + 60,
    totalElevationGainMeters: (overrides.elevationFeet ?? 100) / 3.28084,
    totalElevationGainFeet: overrides.elevationFeet ?? 100,
    startDate: overrides.startDateLocal,
    startDateLocal: overrides.startDateLocal,
    isRace: overrides.isRace ? 1 : 0,
    isDeleted: 0,
  };
}

describe('recomputeStats incremental vs full', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(stravaActivities);
    await db.delete(stravaYearSummaries);
    await db.delete(stravaLifetimeStats);
  });

  it('full recompute produces correct year summaries', async () => {
    await db.insert(stravaActivities).values([
      makeActivity({
        stravaId: 1,
        startDateLocal: '2024-03-15T07:00:00',
        distanceMiles: 5.0,
        movingTimeSeconds: 2400,
      }),
      makeActivity({
        stravaId: 2,
        startDateLocal: '2024-06-20T07:00:00',
        distanceMiles: 10.0,
        movingTimeSeconds: 5000,
        isRace: true,
      }),
      makeActivity({
        stravaId: 3,
        startDateLocal: '2023-09-01T07:00:00',
        distanceMiles: 3.0,
        movingTimeSeconds: 1500,
      }),
    ]);

    await recomputeStats(db);

    const summaries = await db
      .select()
      .from(stravaYearSummaries)
      .where(eq(stravaYearSummaries.userId, 1));

    expect(summaries).toHaveLength(2);

    const y2024 = summaries.find((s) => s.year === 2024)!;
    expect(y2024.totalRuns).toBe(2);
    expect(y2024.totalDistanceMiles).toBe(15.0);
    expect(y2024.raceCount).toBe(1);

    const y2023 = summaries.find((s) => s.year === 2023)!;
    expect(y2023.totalRuns).toBe(1);
    expect(y2023.totalDistanceMiles).toBe(3.0);
  });

  it('full recompute produces correct lifetime stats', async () => {
    await db.insert(stravaActivities).values([
      makeActivity({
        stravaId: 1,
        startDateLocal: '2024-03-15T07:00:00',
        distanceMiles: 5.0,
        movingTimeSeconds: 2400,
      }),
      makeActivity({
        stravaId: 2,
        startDateLocal: '2023-09-01T07:00:00',
        distanceMiles: 3.0,
        movingTimeSeconds: 1500,
      }),
    ]);

    await recomputeStats(db);

    const [lifetime] = await db
      .select()
      .from(stravaLifetimeStats)
      .where(eq(stravaLifetimeStats.userId, 1));

    expect(lifetime.totalRuns).toBe(2);
    expect(lifetime.totalDistanceMiles).toBe(8.0);
    expect(lifetime.yearsActive).toBe(2);
  });

  it('incremental recompute for a single year matches full recompute', async () => {
    // Seed with 2023 data and do a full recompute
    await db.insert(stravaActivities).values([
      makeActivity({
        stravaId: 1,
        startDateLocal: '2023-06-15T07:00:00',
        distanceMiles: 5.0,
        movingTimeSeconds: 2400,
      }),
    ]);
    await recomputeStats(db);

    // Add a 2024 activity and do an incremental recompute for just 2024
    await db.insert(stravaActivities).values([
      makeActivity({
        stravaId: 2,
        startDateLocal: '2024-03-15T07:00:00',
        distanceMiles: 10.0,
        movingTimeSeconds: 5000,
      }),
    ]);
    await recomputeStats(db, new Set([2024]));

    // Get incremental results
    const incrementalSummaries = await db
      .select()
      .from(stravaYearSummaries)
      .where(eq(stravaYearSummaries.userId, 1));
    const [incrementalLifetime] = await db
      .select()
      .from(stravaLifetimeStats)
      .where(eq(stravaLifetimeStats.userId, 1));

    // Now do a full recompute and compare
    await recomputeStats(db);

    const fullSummaries = await db
      .select()
      .from(stravaYearSummaries)
      .where(eq(stravaYearSummaries.userId, 1));
    const [fullLifetime] = await db
      .select()
      .from(stravaLifetimeStats)
      .where(eq(stravaLifetimeStats.userId, 1));

    // Year summaries should match
    expect(incrementalSummaries).toHaveLength(fullSummaries.length);
    for (const fullYear of fullSummaries) {
      const incYear = incrementalSummaries.find(
        (s) => s.year === fullYear.year
      )!;
      expect(incYear.totalRuns).toBe(fullYear.totalRuns);
      expect(incYear.totalDistanceMiles).toBe(fullYear.totalDistanceMiles);
      expect(incYear.totalElevationFeet).toBe(fullYear.totalElevationFeet);
      expect(incYear.totalDurationSeconds).toBe(fullYear.totalDurationSeconds);
      expect(incYear.raceCount).toBe(fullYear.raceCount);
    }

    // Lifetime stats should match
    expect(incrementalLifetime.totalRuns).toBe(fullLifetime.totalRuns);
    expect(incrementalLifetime.totalDistanceMiles).toBe(
      fullLifetime.totalDistanceMiles
    );
    expect(incrementalLifetime.yearsActive).toBe(fullLifetime.yearsActive);
    expect(incrementalLifetime.totalDurationSeconds).toBe(
      fullLifetime.totalDurationSeconds
    );
  });

  it('incremental recompute handles multiple changed years', async () => {
    // Seed with existing data and full recompute
    await db.insert(stravaActivities).values([
      makeActivity({
        stravaId: 1,
        startDateLocal: '2022-01-15T07:00:00',
        distanceMiles: 4.0,
        movingTimeSeconds: 2000,
      }),
    ]);
    await recomputeStats(db);

    // Add activities in 2023 and 2024
    await db.insert(stravaActivities).values([
      makeActivity({
        stravaId: 2,
        startDateLocal: '2023-06-15T07:00:00',
        distanceMiles: 6.0,
        movingTimeSeconds: 3000,
      }),
      makeActivity({
        stravaId: 3,
        startDateLocal: '2024-03-15T07:00:00',
        distanceMiles: 8.0,
        movingTimeSeconds: 4000,
      }),
    ]);

    // Incremental for 2023 + 2024
    await recomputeStats(db, new Set([2023, 2024]));
    const [incLifetime] = await db
      .select()
      .from(stravaLifetimeStats)
      .where(eq(stravaLifetimeStats.userId, 1));

    // Full recompute for comparison
    await recomputeStats(db);
    const [fullLifetime] = await db
      .select()
      .from(stravaLifetimeStats)
      .where(eq(stravaLifetimeStats.userId, 1));

    expect(incLifetime.totalRuns).toBe(fullLifetime.totalRuns);
    expect(incLifetime.totalDistanceMiles).toBe(
      fullLifetime.totalDistanceMiles
    );
    expect(incLifetime.yearsActive).toBe(fullLifetime.yearsActive);
  });

  it('incremental recompute handles year with all activities deleted', async () => {
    await db.insert(stravaActivities).values([
      makeActivity({
        stravaId: 1,
        startDateLocal: '2023-06-15T07:00:00',
        distanceMiles: 5.0,
        movingTimeSeconds: 2400,
      }),
      makeActivity({
        stravaId: 2,
        startDateLocal: '2024-03-15T07:00:00',
        distanceMiles: 10.0,
        movingTimeSeconds: 5000,
      }),
    ]);
    await recomputeStats(db);

    // Soft-delete the 2024 activity
    await db
      .update(stravaActivities)
      .set({ isDeleted: 1 })
      .where(eq(stravaActivities.stravaId, 2));

    // Incremental recompute for 2024 (now empty)
    await recomputeStats(db, new Set([2024]));

    const summaries = await db
      .select()
      .from(stravaYearSummaries)
      .where(eq(stravaYearSummaries.userId, 1));

    // 2024 summary should be removed
    expect(summaries).toHaveLength(1);
    expect(summaries[0].year).toBe(2023);

    // Lifetime stats should reflect only 2023
    const [lifetime] = await db
      .select()
      .from(stravaLifetimeStats)
      .where(eq(stravaLifetimeStats.userId, 1));

    expect(lifetime.totalRuns).toBe(1);
    expect(lifetime.totalDistanceMiles).toBe(5.0);
    expect(lifetime.yearsActive).toBe(1);
  });
});
