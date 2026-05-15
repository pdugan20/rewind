/**
 * Output schemas for the running-domain tools (issue #105).
 *
 * These schemas are the source of truth for the running tools' return
 * shapes: `running.ts` derives its `Activity` / `ActivityDetail` types
 * from them via `z.infer`, so the declared schema and the TypeScript
 * type cannot drift.
 *
 * Every object schema uses `.passthrough()` so the JSON Schema advertised
 * to clients stays `additionalProperties`-open -- a field the Rewind API
 * adds later does not break client-side validation. See schemas/shared.ts.
 */
import { z } from 'zod';

// --- Element schemas ------------------------------------------------------

/** A single run, as listed by get_recent_runs. */
export const activitySchema = z
  .object({
    id: z.number(),
    strava_id: z.number().optional(),
    name: z.string(),
    date: z.string(),
    distance_mi: z.number(),
    duration: z.string(),
    pace: z.string(),
    elevation_ft: z.number(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    is_race: z.boolean(),
    strava_url: z.string().nullish(),
  })
  .passthrough();

/** A single personal record, as listed by get_personal_records. */
export const personalRecordSchema = z
  .object({
    distance_label: z.string(),
    time: z.string(),
    pace: z.string(),
    date: z.string(),
    activity_name: z.string(),
    activity_id: z.number(),
  })
  .passthrough();

/** A single per-mile split, as listed by get_activity_splits. */
export const activitySplitSchema = z
  .object({
    split: z.number(),
    distance_mi: z.number(),
    moving_time_s: z.number(),
    elapsed_time_s: z.number(),
    elevation_ft: z.number(),
    pace: z.string(),
    heartrate: z.number().nullable(),
  })
  .passthrough();

/** A single per-year summary, as listed by get_running_years. */
export const runningYearSchema = z
  .object({
    year: z.number(),
    total_runs: z.number(),
    total_distance_mi: z.number(),
    total_elevation_ft: z.number(),
    total_duration_s: z.number(),
    avg_pace: z.string().nullable(),
    longest_run_mi: z.number().nullable(),
    race_count: z.number(),
  })
  .passthrough();

// --- Tool output schemas --------------------------------------------------

/** outputSchema for get_running_stats (flat stats object from `data`). */
export const runningStatsOutputSchema = z
  .object({
    total_runs: z.number(),
    total_distance_mi: z.number(),
    total_elevation_ft: z.number(),
    total_duration: z.string(),
    avg_pace: z.string().nullable(),
    years_active: z.number(),
    first_run: z.string().nullable(),
    eddington_number: z.number(),
  })
  .passthrough();

/**
 * outputSchema for get_recent_runs. The empty-state branch returns
 * `{ items: [] }`, which satisfies the same schema -- no union needed.
 */
export const recentRunsOutputSchema = z
  .object({ items: z.array(activitySchema) })
  .passthrough();

/**
 * outputSchema for get_personal_records. The empty-state branch returns
 * `{ items: [] }`, which satisfies the same schema.
 */
export const personalRecordsOutputSchema = z
  .object({ items: z.array(personalRecordSchema) })
  .passthrough();

/** outputSchema for get_running_streaks (nested current/longest). */
export const runningStreaksOutputSchema = z
  .object({
    current: z
      .object({
        days: z.number(),
        start: z.string().nullable(),
        end: z.string().nullable(),
      })
      .passthrough(),
    longest: z
      .object({
        days: z.number(),
        start: z.string().nullable(),
        end: z.string().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

/** outputSchema for get_activity_details (a single run's detail object). */
export const activityDetailsOutputSchema = z
  .object({
    id: z.number().optional(),
    name: z.string(),
    date: z.string(),
    distance_mi: z.number(),
    duration: z.string(),
    pace: z.string(),
    elevation_ft: z.number(),
    heartrate_avg: z.number().nullable(),
    heartrate_max: z.number().nullable(),
    cadence: z.number().nullable(),
    calories: z.number().nullable(),
    suffer_score: z.number().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    is_race: z.boolean(),
    workout_type: z.string(),
    strava_url: z.string().nullable(),
  })
  .passthrough();

/**
 * outputSchema for get_activity_splits. The empty-state branch returns
 * `{ activity_id, items: [] }`, which satisfies the same schema.
 */
export const activitySplitsOutputSchema = z
  .object({
    activity_id: z.number(),
    items: z.array(activitySplitSchema),
  })
  .passthrough();

/**
 * outputSchema for get_running_years. The empty-state branch returns
 * `{ items: [] }`, which satisfies the same schema.
 */
export const runningYearsOutputSchema = z
  .object({ items: z.array(runningYearSchema) })
  .passthrough();
