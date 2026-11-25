/**
 * Apple Health running ingest: receives batches from the Pulso iPhone app
 * (protocol: github.com/pdugan20/pulso docs/PROTOCOL.md) and stores running
 * workouts in the running tables alongside the Strava history.
 */
import { and, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { activityFeed, syncRuns } from '../../db/schema/system.js';
import {
  stravaActivities,
  stravaPersonalRecords,
  stravaSplits,
} from '../../db/schema/strava.js';
import { afterSync } from '../../lib/after-sync.js';
import type { FeedItem, SearchItem } from '../../lib/after-sync.js';
import { chunkForInsertValues, chunkForSelectIn } from '../../lib/d1-chunk.js';
import { applyPersonalRecords, recomputeStats } from '../strava/sync.js';
import {
  HEALTH_SOURCE,
  healthActivityId,
  isRunningWorkout,
  transformHealthRun,
  type PulsoSample,
} from './transforms.js';

/** Runs recorded twice (e.g. Nike to Strava and to Health) start within this. */
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

export interface IngestResult {
  received: number;
  new: number;
  updated: number;
  /** Runs Rewind already had from another source; heart rate filled in. */
  matched: number;
  deleted: number;
  /** Samples that aren't runs, or that couldn't be read. */
  ignored: number;
}

function isSample(element: unknown): element is PulsoSample {
  if (!element || typeof element !== 'object') return false;
  const e = element as Record<string, unknown>;
  return (
    typeof e.uuid === 'string' &&
    typeof e.type === 'string' &&
    typeof e.start === 'string' &&
    typeof e.end === 'string' &&
    !Number.isNaN(Date.parse(e.start)) &&
    !Number.isNaN(Date.parse(e.end))
  );
}

function tombstoneUuids(element: unknown): string[] | null {
  if (!element || typeof element !== 'object') return null;
  const deleted = (element as { deleted?: unknown }).deleted;
  if (!Array.isArray(deleted)) return null;
  return deleted.filter((u): u is string => typeof u === 'string');
}

function isoWithoutMillis(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Newest run end time Rewind holds, in Pulso's /latest shape, so a fresh
 * install only sends runs from just before that point onwards.
 */
export async function latestRunEnd(
  db: Database,
  userId = 1
): Promise<Record<string, string>> {
  const [latest] = await db
    .select({
      startDate: stravaActivities.startDate,
      elapsed: stravaActivities.elapsedTimeSeconds,
    })
    .from(stravaActivities)
    .where(
      and(
        eq(stravaActivities.userId, userId),
        eq(stravaActivities.isDeleted, 0)
      )
    )
    .orderBy(desc(stravaActivities.startDate))
    .limit(1);
  if (!latest) return {};
  const end = Date.parse(latest.startDate) + (latest.elapsed ?? 0) * 1000;
  return { workout: isoWithoutMillis(end) };
}

export async function ingestHealthBatch(
  db: Database,
  elements: unknown[],
  userId = 1
): Promise<IngestResult> {
  const result: IngestResult = {
    received: elements.length,
    new: 0,
    updated: 0,
    matched: 0,
    deleted: 0,
    ignored: 0,
  };

  const runs: PulsoSample[] = [];
  const deletedUuids: string[] = [];
  for (const element of elements) {
    const tombstone = tombstoneUuids(element);
    if (tombstone) {
      deletedUuids.push(...tombstone);
    } else if (isSample(element) && isRunningWorkout(element)) {
      runs.push(element);
    } else {
      result.ignored++;
    }
  }
  if (runs.length === 0 && deletedUuids.length === 0) return result;

  const startedAt = new Date().toISOString();
  const [syncRun] = await db
    .insert(syncRuns)
    .values({
      userId,
      domain: 'running',
      syncType: 'apple_health',
      status: 'running',
      startedAt,
    })
    .returning();

  try {
    const changedYears = new Set<number>();
    const feedItems: FeedItem[] = [];
    const searchItems: SearchItem[] = [];
    const bestEfforts: Parameters<typeof applyPersonalRecords>[1] = [];
    /** Apple Health runs re-sent in this batch, whose old efforts are stale. */
    const replacedActivityIds = new Set<number>();

    for (const sample of runs) {
      let run: ReturnType<typeof transformHealthRun>;
      try {
        run = transformHealthRun(sample);
      } catch (error) {
        console.log(
          '[ERROR] Apple Health run ' +
            sample.uuid +
            ' unreadable: ' +
            (error instanceof Error ? error.message : String(error))
        );
        result.ignored++;
        continue;
      }
      const { activity, splits } = run;

      const [existing] = await db
        .select({ id: stravaActivities.id })
        .from(stravaActivities)
        .where(
          and(
            eq(stravaActivities.userId, userId),
            eq(stravaActivities.stravaId, activity.stravaId)
          )
        )
        .limit(1);

      if (!existing) {
        // Same run already here from Strava (or another Health source)?
        const startMs = Date.parse(activity.startDate);
        const [duplicate] = await db
          .select({
            id: stravaActivities.id,
            averageHeartrate: stravaActivities.averageHeartrate,
            maxHeartrate: stravaActivities.maxHeartrate,
          })
          .from(stravaActivities)
          .where(
            and(
              eq(stravaActivities.userId, userId),
              eq(stravaActivities.isDeleted, 0),
              ne(stravaActivities.stravaId, activity.stravaId),
              gte(
                stravaActivities.startDate,
                isoWithoutMillis(startMs - DUPLICATE_WINDOW_MS)
              ),
              lte(
                stravaActivities.startDate,
                isoWithoutMillis(startMs + DUPLICATE_WINDOW_MS)
              )
            )
          )
          .limit(1);

        if (duplicate) {
          const fill: Partial<typeof stravaActivities.$inferInsert> = {};
          if (
            duplicate.averageHeartrate === null &&
            activity.averageHeartrate !== null
          ) {
            fill.averageHeartrate = activity.averageHeartrate;
          }
          if (
            duplicate.maxHeartrate === null &&
            activity.maxHeartrate !== null
          ) {
            fill.maxHeartrate = activity.maxHeartrate;
          }
          if (Object.keys(fill).length > 0) {
            await db
              .update(stravaActivities)
              .set({ ...fill, updatedAt: new Date().toISOString() })
              .where(eq(stravaActivities.id, duplicate.id));
          }
          result.matched++;
          continue;
        }
      }

      await db
        .insert(stravaActivities)
        .values({ userId, ...activity })
        .onConflictDoUpdate({
          // The migrated table's unique index is strava_id alone.
          target: stravaActivities.stravaId,
          set: activity,
        });
      if (existing) replacedActivityIds.add(activity.stravaId);

      await db
        .delete(stravaSplits)
        .where(
          and(
            eq(stravaSplits.userId, userId),
            eq(stravaSplits.activityStravaId, activity.stravaId)
          )
        );
      for (const batch of chunkForInsertValues(
        splits.map((s) => ({ userId, ...s })),
        15
      )) {
        await db.insert(stravaSplits).values(batch);
      }

      if (run.bestEfforts.length) {
        bestEfforts.push({
          bestEfforts: run.bestEfforts.map((e) => ({ ...e, pr_rank: null })),
          activityId: activity.stravaId,
          activityName: activity.name,
        });
      }

      changedYears.add(new Date(activity.startDateLocal).getUTCFullYear());
      if (existing) {
        result.updated++;
      } else {
        result.new++;
        const subtitle = activity.distanceMiles.toFixed(1) + ' mi';
        feedItems.push({
          domain: 'running',
          eventType: 'activity',
          occurredAt: activity.startDateLocal,
          title: activity.name,
          subtitle,
          sourceId: HEALTH_SOURCE + ':' + sample.uuid,
        });
        searchItems.push({
          domain: 'running',
          entityType: 'activity',
          entityId: String(activity.stravaId),
          title: activity.name,
          subtitle,
        });
      }
    }

    // Deletions only touch runs that came from Apple Health.
    const deletedIds: number[] = [];
    for (const uuid of deletedUuids) {
      try {
        deletedIds.push(healthActivityId(uuid));
      } catch {
        // Not a uuid; nothing of ours can match it.
      }
    }
    const deletedActivityIds = new Set<number>();
    const deletedFeedSourceIds = new Set<string>();
    for (const ids of chunkForSelectIn(deletedIds, 3)) {
      const rows = await db
        .select({
          id: stravaActivities.id,
          stravaId: stravaActivities.stravaId,
          sourceId: stravaActivities.sourceId,
          startDateLocal: stravaActivities.startDateLocal,
        })
        .from(stravaActivities)
        .where(
          and(
            eq(stravaActivities.userId, userId),
            eq(stravaActivities.source, HEALTH_SOURCE),
            eq(stravaActivities.isDeleted, 0),
            inArray(stravaActivities.stravaId, ids)
          )
        );
      if (!rows.length) continue;
      await db
        .update(stravaActivities)
        .set({ isDeleted: 1, updatedAt: new Date().toISOString() })
        .where(
          inArray(
            stravaActivities.id,
            rows.map((r) => r.id)
          )
        );
      for (const row of rows) {
        changedYears.add(new Date(row.startDateLocal).getUTCFullYear());
        deletedActivityIds.add(row.stravaId);
        const feedSourceId = HEALTH_SOURCE + ':' + row.sourceId;
        deletedFeedSourceIds.add(feedSourceId);
        await db.run(
          sql`DELETE FROM search_index WHERE domain = 'running' AND entity_type = 'activity' AND entity_id = ${String(row.stravaId)}`
        );
        await db
          .delete(activityFeed)
          .where(
            and(
              eq(activityFeed.domain, 'running'),
              eq(activityFeed.sourceId, feedSourceId)
            )
          );
      }
      result.deleted += rows.length;
    }

    // A deleted run can't hold a record, and a re-sent run's old records may
    // no longer match its corrected route, so both give up their records
    // before the batch's efforts are applied. Per-run best efforts aren't
    // stored, so the record a cleared run had replaced can't be restored and
    // the distance stays empty until another run sets it.
    const staleRecordHolders = [...replacedActivityIds, ...deletedActivityIds];
    for (const ids of chunkForSelectIn(staleRecordHolders, 1)) {
      await db
        .delete(stravaPersonalRecords)
        .where(
          and(
            eq(stravaPersonalRecords.userId, userId),
            inArray(stravaPersonalRecords.activityStravaId, ids)
          )
        );
    }
    const liveBestEfforts = bestEfforts.filter(
      (effort) => !deletedActivityIds.has(effort.activityId)
    );
    if (liveBestEfforts.length) {
      await applyPersonalRecords(db, liveBestEfforts);
    }
    if (changedYears.size > 0) {
      await recomputeStats(db, changedYears);
    }

    await db
      .update(syncRuns)
      .set({
        status: 'completed',
        completedAt: new Date().toISOString(),
        itemsSynced: result.new + result.updated + result.deleted,
      })
      .where(eq(syncRuns.id, syncRun.id));

    // Revalidation hooks need to hear about updated, matched and deleted runs
    // too, not only new ones.
    const changed =
      result.new + result.updated + result.matched + result.deleted;
    if (changed > 0) {
      // Runs deleted later in the same batch stay out of the feed and search.
      await afterSync(db, {
        domain: 'running',
        feedItems: feedItems.filter(
          (item) => !deletedFeedSourceIds.has(item.sourceId)
        ),
        searchItems: searchItems.filter(
          (item) => !deletedActivityIds.has(Number(item.entityId))
        ),
      });
    }

    console.log(
      '[SYNC] Apple Health runs: ' +
        result.new +
        ' new, ' +
        result.updated +
        ' updated, ' +
        result.matched +
        ' matched, ' +
        result.deleted +
        ' deleted'
    );
    return result;
  } catch (error) {
    await db
      .update(syncRuns)
      .set({
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })
      .where(eq(syncRuns.id, syncRun.id));
    throw error;
  }
}
