import { eq, desc, and, sql, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { syncRuns } from '../../db/schema/system.js';
import {
  stravaActivities,
  stravaSplits,
  stravaGear,
  stravaPersonalRecords,
  stravaYearSummaries,
  stravaLifetimeStats,
} from '../../db/schema/strava.js';
import type { Env } from '../../types/env.js';
import { StravaClient } from './client.js';
import { afterSync } from '../../lib/after-sync.js';
import type { FeedItem, SearchItem } from '../../lib/after-sync.js';
import {
  transformActivity,
  transformSplits,
  extractPersonalRecords,
  computeYearSummaries,
  calculateStreaks,
  calculateEddington,
  metersToMiles,
  formatPace,
} from './transforms.js';

/**
 * Run incremental Strava sync: fetch new activities since last sync,
 * upsert them, sync gear, and recompute stats.
 */
export async function syncRunning(env: Env, db: Database): Promise<number> {
  const startedAt = new Date().toISOString();
  const [syncRun] = await db
    .insert(syncRuns)
    .values({
      domain: 'running',
      syncType: 'incremental',
      status: 'running',
      startedAt,
    })
    .returning();

  let itemsSynced = 0;
  const changedYears = new Set<number>();
  const newActivities: Array<{
    id: number;
    name: string;
    date: string;
    distanceMiles: number;
  }> = [];

  try {
    const client = new StravaClient(env, db);

    // Find the most recent activity to sync incrementally
    const [lastActivity] = await db
      .select({ startDate: stravaActivities.startDate })
      .from(stravaActivities)
      .where(eq(stravaActivities.isDeleted, 0))
      .orderBy(desc(stravaActivities.startDate))
      .limit(1);

    const after = lastActivity
      ? Math.floor(new Date(lastActivity.startDate).getTime() / 1000)
      : undefined;

    // Fetch activities page by page
    let page = 1;
    let hasMore = true;

    while (hasMore && !client.isRateLimited()) {
      const activities = await client.getActivities({
        after,
        page,
        perPage: 200,
      });

      if (activities.length === 0) {
        hasMore = false;
        break;
      }

      for (const activity of activities) {
        // Only sync runs
        if (
          activity.sport_type !== 'Run' &&
          activity.type !== 'Run' &&
          activity.sport_type !== 'TrailRun' &&
          activity.sport_type !== 'VirtualRun'
        ) {
          continue;
        }

        // Fetch full detail for best_efforts and splits
        let detailedActivity = activity;
        try {
          detailedActivity = await client.getActivity(activity.id);
        } catch (e) {
          console.log(
            `[ERROR] Failed to fetch detail for activity ${activity.id}: ${e}`
          );
        }

        const transformed = transformActivity(detailedActivity);

        // Track which years are affected
        changedYears.add(new Date(transformed.startDateLocal).getFullYear());

        // Upsert activity
        await db
          .insert(stravaActivities)
          .values(transformed)
          .onConflictDoUpdate({
            target: stravaActivities.stravaId,
            set: transformed,
          });

        // Upsert splits
        if (detailedActivity.splits_standard?.length) {
          // Delete existing splits for this activity
          await db
            .delete(stravaSplits)
            .where(eq(stravaSplits.activityStravaId, detailedActivity.id));

          const splitValues = transformSplits(
            detailedActivity.id,
            detailedActivity.splits_standard
          );
          if (splitValues.length > 0) {
            await db.insert(stravaSplits).values(splitValues);
          }
        }

        newActivities.push({
          id: transformed.stravaId,
          name: transformed.name,
          date: transformed.startDateLocal,
          distanceMiles: transformed.distanceMiles,
        });
        itemsSynced++;
      }

      page++;
      if (activities.length < 200) hasMore = false;
    }

    // Sync gear
    await syncGear(client, db);

    // Recompute stats incrementally for affected years (full if no new activities)
    await recomputeStats(db, changedYears.size > 0 ? changedYears : undefined);

    // Mark sync as completed
    await db
      .update(syncRuns)
      .set({
        status: 'completed',
        completedAt: new Date().toISOString(),
        itemsSynced,
      })
      .where(eq(syncRuns.id, syncRun.id));

    // Post-sync: feed, search, revalidation
    const feedItems: FeedItem[] = newActivities.map((a) => ({
      domain: 'running',
      eventType: 'activity',
      occurredAt: a.date,
      title: a.name,
      subtitle: `${a.distanceMiles.toFixed(1)} mi`,
      sourceId: `strava:${a.id}`,
    }));
    const searchItems: SearchItem[] = newActivities.map((a) => ({
      domain: 'running',
      entityType: 'activity',
      entityId: String(a.id),
      title: a.name,
      subtitle: `${a.distanceMiles.toFixed(1)} mi`,
    }));
    await afterSync(db, { domain: 'running', feedItems, searchItems });

    console.log(`[SYNC] Running sync completed: ${itemsSynced} activities`);
    return itemsSynced;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(`[ERROR] Running sync failed: ${errorMessage}`);

    await db
      .update(syncRuns)
      .set({
        status: 'failed',
        completedAt: new Date().toISOString(),
        itemsSynced,
        error: errorMessage,
      })
      .where(eq(syncRuns.id, syncRun.id));

    throw error;
  }
}

/**
 * Sync gear data for all gear IDs referenced in activities.
 */
async function syncGear(client: StravaClient, db: Database): Promise<void> {
  // Get distinct gear IDs from activities
  const gearIds = await db
    .selectDistinct({ gearId: stravaActivities.gearId })
    .from(stravaActivities)
    .where(
      and(
        eq(stravaActivities.isDeleted, 0),
        sql`${stravaActivities.gearId} IS NOT NULL`
      )
    );

  for (const { gearId } of gearIds) {
    if (!gearId) continue;

    try {
      const gear = await client.getGear(gearId);

      await db
        .insert(stravaGear)
        .values({
          stravaGearId: gear.id,
          name: gear.name,
          brand: gear.brand_name,
          model: gear.model_name,
          distanceMeters: gear.distance,
          distanceMiles: metersToMiles(gear.distance),
          isRetired: gear.retired ? 1 : 0,
          updatedAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: stravaGear.stravaGearId,
          set: {
            name: gear.name,
            brand: gear.brand_name,
            model: gear.model_name,
            distanceMeters: gear.distance,
            distanceMiles: metersToMiles(gear.distance),
            isRetired: gear.retired ? 1 : 0,
            updatedAt: new Date().toISOString(),
          },
        });
    } catch (e) {
      console.log(`[ERROR] Failed to sync gear ${gearId}: ${e}`);
    }
  }
}

/**
 * Recompute derived stats. When changedYears is provided, only recomputes
 * year summaries for those years and aggregates lifetime stats from the
 * year summaries table (avoiding a full activity scan). When omitted,
 * performs a full recomputation from all activities.
 */
export async function recomputeStats(
  db: Database,
  changedYears?: Set<number>
): Promise<void> {
  if (changedYears && changedYears.size > 0) {
    await recomputeIncremental(db, changedYears);
  } else {
    await recomputeFull(db);
  }
  console.log('[SYNC] Stats recomputation completed');
}

async function recomputeYearSummaries(
  db: Database,
  years: number[]
): Promise<void> {
  // Fetch activities only for the changed years
  const activities = await db
    .select()
    .from(stravaActivities)
    .where(
      and(
        eq(stravaActivities.isDeleted, 0),
        inArray(
          sql`cast(strftime('%Y', ${stravaActivities.startDateLocal}) as integer)`,
          years
        )
      )
    );

  const yearInputs = activities.map((a) => ({
    year: new Date(a.startDateLocal).getFullYear(),
    distanceMiles: a.distanceMiles,
    movingTimeSeconds: a.movingTimeSeconds,
    elevationFeet: a.totalElevationGainFeet,
    isRace: a.isRace === 1,
    longestRunMiles: a.distanceMiles,
  }));

  const yearSummaries = computeYearSummaries(yearInputs);

  // Upsert only the changed years
  for (const [year, summary] of yearSummaries.entries()) {
    await db
      .insert(stravaYearSummaries)
      .values({
        year,
        ...summary,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [stravaYearSummaries.userId, stravaYearSummaries.year],
        set: {
          ...summary,
          updatedAt: new Date().toISOString(),
        },
      });
  }

  // Handle years that had activities removed (now zero activities)
  for (const year of years) {
    if (!yearSummaries.has(year)) {
      await db
        .delete(stravaYearSummaries)
        .where(
          and(
            eq(stravaYearSummaries.userId, 1),
            eq(stravaYearSummaries.year, year)
          )
        );
    }
  }
}

async function recomputeLifetimeFromSummaries(db: Database): Promise<void> {
  // Aggregate from year summaries table instead of scanning all activities
  const summaries = await db
    .select()
    .from(stravaYearSummaries)
    .where(eq(stravaYearSummaries.userId, 1));

  if (summaries.length === 0) return;

  const totalRuns = summaries.reduce((sum, s) => sum + s.totalRuns, 0);
  const totalDistanceMiles = summaries.reduce(
    (sum, s) => sum + s.totalDistanceMiles,
    0
  );
  const totalElevationFeet = summaries.reduce(
    (sum, s) => sum + s.totalElevationFeet,
    0
  );
  const totalDurationSeconds = summaries.reduce(
    (sum, s) => sum + s.totalDurationSeconds,
    0
  );
  const avgPaceMinPerMile =
    totalDistanceMiles > 0 ? totalDurationSeconds / 60 / totalDistanceMiles : 0;
  const yearsActive = summaries.length;

  // First run and streaks still need activity data, but we can query efficiently
  const [firstActivity] = await db
    .select({ startDateLocal: stravaActivities.startDateLocal })
    .from(stravaActivities)
    .where(eq(stravaActivities.isDeleted, 0))
    .orderBy(stravaActivities.startDate)
    .limit(1);

  const firstRun = firstActivity?.startDateLocal ?? null;

  // Streaks: need all run dates (lightweight query, just one column)
  const runDateRows = await db
    .select({ startDateLocal: stravaActivities.startDateLocal })
    .from(stravaActivities)
    .where(eq(stravaActivities.isDeleted, 0))
    .orderBy(stravaActivities.startDate);

  const streaks = calculateStreaks(runDateRows.map((r) => r.startDateLocal));

  // Eddington: need daily distance totals
  const dailyMilesMap = new Map<string, number>();
  const distanceRows = await db
    .select({
      startDateLocal: stravaActivities.startDateLocal,
      distanceMiles: stravaActivities.distanceMiles,
    })
    .from(stravaActivities)
    .where(eq(stravaActivities.isDeleted, 0));

  for (const r of distanceRows) {
    const date = r.startDateLocal.substring(0, 10);
    dailyMilesMap.set(date, (dailyMilesMap.get(date) ?? 0) + r.distanceMiles);
  }
  const eddington = calculateEddington([...dailyMilesMap.values()]);

  await db
    .insert(stravaLifetimeStats)
    .values({
      userId: 1,
      totalRuns,
      totalDistanceMiles: Math.round(totalDistanceMiles * 100) / 100,
      totalElevationFeet: Math.round(totalElevationFeet * 100) / 100,
      totalDurationSeconds,
      avgPaceFormatted: formatPace(
        avgPaceMinPerMile > 0 ? avgPaceMinPerMile : null
      ),
      yearsActive,
      firstRun,
      eddingtonNumber: eddington.number,
      ...streaks,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: stravaLifetimeStats.userId,
      set: {
        totalRuns,
        totalDistanceMiles: Math.round(totalDistanceMiles * 100) / 100,
        totalElevationFeet: Math.round(totalElevationFeet * 100) / 100,
        totalDurationSeconds,
        avgPaceFormatted: formatPace(
          avgPaceMinPerMile > 0 ? avgPaceMinPerMile : null
        ),
        yearsActive,
        firstRun,
        eddingtonNumber: eddington.number,
        ...streaks,
        updatedAt: new Date().toISOString(),
      },
    });
}

async function recomputeIncremental(
  db: Database,
  changedYears: Set<number>
): Promise<void> {
  const years = [...changedYears];
  console.log(
    `[SYNC] Incremental stats recomputation for years: ${years.join(', ')}`
  );

  await recomputeYearSummaries(db, years);
  await recomputeLifetimeFromSummaries(db);
}

async function recomputeFull(db: Database): Promise<void> {
  console.log('[SYNC] Full stats recomputation');

  const activities = await db
    .select()
    .from(stravaActivities)
    .where(eq(stravaActivities.isDeleted, 0))
    .orderBy(stravaActivities.startDate);

  if (activities.length === 0) return;

  // Year summaries from all activities
  const yearInputs = activities.map((a) => ({
    year: new Date(a.startDateLocal).getFullYear(),
    distanceMiles: a.distanceMiles,
    movingTimeSeconds: a.movingTimeSeconds,
    elevationFeet: a.totalElevationGainFeet,
    isRace: a.isRace === 1,
    longestRunMiles: a.distanceMiles,
  }));

  const yearSummaries = computeYearSummaries(yearInputs);

  for (const [year, summary] of yearSummaries.entries()) {
    await db
      .insert(stravaYearSummaries)
      .values({
        year,
        ...summary,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [stravaYearSummaries.userId, stravaYearSummaries.year],
        set: {
          ...summary,
          updatedAt: new Date().toISOString(),
        },
      });
  }

  // Lifetime stats
  const totalRuns = activities.length;
  const totalDistanceMiles = activities.reduce(
    (sum, a) => sum + a.distanceMiles,
    0
  );
  const totalElevationFeet = activities.reduce(
    (sum, a) => sum + a.totalElevationGainFeet,
    0
  );
  const totalDurationSeconds = activities.reduce(
    (sum, a) => sum + a.movingTimeSeconds,
    0
  );
  const avgPaceMinPerMile =
    totalDistanceMiles > 0 ? totalDurationSeconds / 60 / totalDistanceMiles : 0;

  const years = new Set(
    activities.map((a) => new Date(a.startDateLocal).getFullYear())
  );
  const firstRun = activities[0]?.startDateLocal ?? null;

  const runDates = activities.map((a) => a.startDateLocal);
  const streaks = calculateStreaks(runDates);

  const dailyMilesMap = new Map<string, number>();
  for (const a of activities) {
    const date = a.startDateLocal.substring(0, 10);
    dailyMilesMap.set(date, (dailyMilesMap.get(date) ?? 0) + a.distanceMiles);
  }
  const eddington = calculateEddington([...dailyMilesMap.values()]);

  await db
    .insert(stravaLifetimeStats)
    .values({
      userId: 1,
      totalRuns,
      totalDistanceMiles: Math.round(totalDistanceMiles * 100) / 100,
      totalElevationFeet: Math.round(totalElevationFeet * 100) / 100,
      totalDurationSeconds,
      avgPaceFormatted: formatPace(
        avgPaceMinPerMile > 0 ? avgPaceMinPerMile : null
      ),
      yearsActive: years.size,
      firstRun,
      eddingtonNumber: eddington.number,
      ...streaks,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: stravaLifetimeStats.userId,
      set: {
        totalRuns,
        totalDistanceMiles: Math.round(totalDistanceMiles * 100) / 100,
        totalElevationFeet: Math.round(totalElevationFeet * 100) / 100,
        totalDurationSeconds,
        avgPaceFormatted: formatPace(
          avgPaceMinPerMile > 0 ? avgPaceMinPerMile : null
        ),
        yearsActive: years.size,
        firstRun,
        eddingtonNumber: eddington.number,
        ...streaks,
        updatedAt: new Date().toISOString(),
      },
    });
}

/**
 * Handle a single activity create/update from webhook.
 */
export async function syncSingleActivity(
  env: Env,
  db: Database,
  stravaId: number
): Promise<void> {
  const client = new StravaClient(env, db);
  const activity = await client.getActivity(stravaId);

  // Only sync runs
  if (
    activity.sport_type !== 'Run' &&
    activity.type !== 'Run' &&
    activity.sport_type !== 'TrailRun' &&
    activity.sport_type !== 'VirtualRun'
  ) {
    console.log(
      `[INFO] Skipping non-run activity ${stravaId} (${activity.sport_type})`
    );
    return;
  }

  const transformed = transformActivity(activity);

  await db.insert(stravaActivities).values(transformed).onConflictDoUpdate({
    target: stravaActivities.stravaId,
    set: transformed,
  });

  // Upsert splits
  if (activity.splits_standard?.length) {
    await db
      .delete(stravaSplits)
      .where(eq(stravaSplits.activityStravaId, stravaId));

    const splitValues = transformSplits(stravaId, activity.splits_standard);
    if (splitValues.length > 0) {
      await db.insert(stravaSplits).values(splitValues);
    }
  }

  // Extract and upsert PRs from best_efforts
  if (activity.best_efforts?.length) {
    const prs = extractPersonalRecords([
      {
        bestEfforts: activity.best_efforts,
        activityId: activity.id,
        activityName: activity.name,
      },
    ]);

    for (const pr of prs) {
      // Only update if this is actually a faster time
      const [existing] = await db
        .select()
        .from(stravaPersonalRecords)
        .where(
          and(
            eq(stravaPersonalRecords.userId, 1),
            eq(stravaPersonalRecords.distance, pr.distance)
          )
        )
        .limit(1);

      if (!existing || pr.timeSeconds < existing.timeSeconds) {
        await db
          .insert(stravaPersonalRecords)
          .values({ userId: 1, ...pr })
          .onConflictDoUpdate({
            target: [
              stravaPersonalRecords.userId,
              stravaPersonalRecords.distance,
            ],
            set: pr,
          });
      }
    }
  }

  // Recompute stats incrementally for the affected year
  const activityYear = new Date(transformed.startDateLocal).getFullYear();
  await recomputeStats(db, new Set([activityYear]));

  // Post-sync: feed, search, revalidation
  await afterSync(db, {
    domain: 'running',
    feedItems: [
      {
        domain: 'running',
        eventType: 'activity',
        occurredAt: transformed.startDateLocal,
        title: transformed.name,
        subtitle: `${transformed.distanceMiles.toFixed(1)} mi`,
        sourceId: `strava:${stravaId}`,
      },
    ],
    searchItems: [
      {
        domain: 'running',
        entityType: 'activity',
        entityId: String(stravaId),
        title: transformed.name,
        subtitle: `${transformed.distanceMiles.toFixed(1)} mi`,
      },
    ],
  });

  console.log(`[SYNC] Single activity ${stravaId} synced`);
}

/**
 * Soft delete an activity.
 */
export async function deleteActivity(
  db: Database,
  stravaId: number
): Promise<void> {
  // Get the year before soft-deleting so we can do incremental recompute
  const [activity] = await db
    .select({ startDateLocal: stravaActivities.startDateLocal })
    .from(stravaActivities)
    .where(eq(stravaActivities.stravaId, stravaId))
    .limit(1);

  await db
    .update(stravaActivities)
    .set({ isDeleted: 1, updatedAt: new Date().toISOString() })
    .where(eq(stravaActivities.stravaId, stravaId));

  // Recompute stats for the affected year
  if (activity) {
    const year = new Date(activity.startDateLocal).getFullYear();
    await recomputeStats(db, new Set([year]));
  } else {
    await recomputeStats(db);
  }

  console.log(`[SYNC] Activity ${stravaId} soft deleted`);
}
