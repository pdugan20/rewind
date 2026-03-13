import type { StravaActivity, StravaBestEffort } from './client.js';

// --- Unit conversions ---

export function metersToMiles(meters: number): number {
  return Math.round(meters * 0.000621371 * 100) / 100;
}

export function metersToFeet(meters: number): number {
  return Math.round(meters * 3.28084 * 100) / 100;
}

/**
 * Convert m/s to minutes per mile.
 * Returns null if speed is 0 or invalid.
 */
export function msToMinPerMile(speedMs: number): number | null {
  if (!speedMs || speedMs <= 0) return null;
  return 26.8224 / speedMs;
}

// --- Formatting ---

/**
 * Format pace as MM:SS/mi.
 */
export function formatPace(minPerMile: number | null): string {
  if (minPerMile === null || minPerMile <= 0) return '0:00/mi';
  const minutes = Math.floor(minPerMile);
  const seconds = Math.round((minPerMile - minutes) * 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}/mi`;
}

/**
 * Format duration in seconds to a human-readable string.
 * For short durations: "MM:SS"
 * For long durations: "H:MM:SS"
 */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Format a total duration for lifetime stats (e.g., "1423:45:30").
 */
export function formatTotalDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// --- Activity transforms ---

/**
 * Map workout_type integer to human-readable string.
 */
export function getWorkoutTypeLabel(workoutType: number | null): string {
  switch (workoutType) {
    case 1:
      return 'race';
    case 2:
      return 'long_run';
    case 3:
      return 'workout';
    default:
      return 'default';
  }
}

/**
 * Transform a Strava API activity into database-ready values.
 */
export function transformActivity(activity: StravaActivity) {
  const distanceMiles = metersToMiles(activity.distance);
  const elevationFeet = metersToFeet(activity.total_elevation_gain);
  const paceMinPerMile = msToMinPerMile(activity.average_speed);
  const paceFormattedStr = formatPace(paceMinPerMile);

  return {
    stravaId: activity.id,
    name: activity.name,
    sportType: activity.sport_type || activity.type || 'Run',
    workoutType: activity.workout_type ?? 0,
    distanceMeters: activity.distance,
    distanceMiles,
    movingTimeSeconds: activity.moving_time,
    elapsedTimeSeconds: activity.elapsed_time,
    totalElevationGainMeters: activity.total_elevation_gain,
    totalElevationGainFeet: elevationFeet,
    startDate: activity.start_date,
    startDateLocal: activity.start_date_local,
    timezone: activity.timezone,
    startLat: activity.start_latlng?.[0] ?? null,
    startLng: activity.start_latlng?.[1] ?? null,
    city: activity.location_city ?? null,
    state: activity.location_state ?? null,
    country: activity.location_country ?? null,
    averageSpeedMs: activity.average_speed,
    maxSpeedMs: activity.max_speed,
    paceMinPerMile,
    paceFormatted: paceFormattedStr,
    averageHeartrate: activity.average_heartrate ?? null,
    maxHeartrate: activity.max_heartrate ?? null,
    averageCadence: activity.average_cadence ?? null,
    calories: activity.calories ?? null,
    sufferScore: activity.suffer_score ?? null,
    mapPolyline:
      activity.map?.summary_polyline || activity.map?.polyline || null,
    gearId: activity.gear_id ?? null,
    achievementCount: activity.achievement_count ?? 0,
    prCount: activity.pr_count ?? 0,
    isRace: activity.workout_type === 1 ? 1 : 0,
    isDeleted: 0,
    stravaUrl: `https://www.strava.com/activities/${activity.id}`,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Transform Strava splits into database-ready values.
 */
export function transformSplits(
  activityStravaId: number,
  splits: StravaActivity['splits_standard']
) {
  if (!splits) return [];

  return splits.map((split) => {
    const distanceMiles = metersToMiles(split.distance);
    const paceMinPerMile = msToMinPerMile(split.average_speed);
    const paceFormattedStr = formatPace(paceMinPerMile);

    return {
      activityStravaId,
      splitNumber: split.split,
      distanceMeters: split.distance,
      distanceMiles,
      movingTimeSeconds: split.moving_time,
      elapsedTimeSeconds: split.elapsed_time,
      elevationDifferenceMeters: split.elevation_difference,
      elevationDifferenceFeet: metersToFeet(split.elevation_difference),
      averageSpeedMs: split.average_speed,
      paceMinPerMile,
      paceFormatted: paceFormattedStr,
      averageHeartrate: split.average_heartrate ?? null,
      averageCadence: null,
    };
  });
}

// --- PR extraction ---

/**
 * Standard PR distances we track.
 */
const PR_DISTANCES: Record<string, { label: string; meters: number }> = {
  '400m': { label: '400m', meters: 400 },
  '1/2 mile': { label: '1/2 Mile', meters: 804.672 },
  '1k': { label: '1K', meters: 1000 },
  mile: { label: 'Mile', meters: 1609.34 },
  '2 mile': { label: '2 Mile', meters: 3218.69 },
  '5k': { label: '5K', meters: 5000 },
  '10k': { label: '10K', meters: 10000 },
  '15k': { label: '15K', meters: 15000 },
  '10 mile': { label: '10 Mile', meters: 16093.4 },
  half_marathon: { label: 'Half Marathon', meters: 21097.5 },
  '20k': { label: '20K', meters: 20000 },
  marathon: { label: 'Marathon', meters: 42195 },
  '50k': { label: '50K', meters: 50000 },
};

/**
 * Normalize best effort name to match our PR distance keys.
 */
function normalizeBestEffortName(name: string): string {
  return name.toLowerCase().replace(/-/g, '_').trim();
}

/**
 * Extract personal records from best_efforts across all activities.
 * Returns only the fastest time per distance.
 */
export function extractPersonalRecords(
  activities: Array<{
    bestEfforts: StravaBestEffort[];
    activityId: number;
    activityName: string;
  }>
): Array<{
  distance: string;
  distanceLabel: string;
  timeSeconds: number;
  timeFormatted: string;
  paceFormatted: string;
  date: string;
  activityStravaId: number;
  activityName: string;
}> {
  const bestByDistance = new Map<
    string,
    {
      timeSeconds: number;
      date: string;
      activityId: number;
      activityName: string;
    }
  >();

  for (const activity of activities) {
    for (const effort of activity.bestEfforts) {
      const normalizedName = normalizeBestEffortName(effort.name);
      const prDistance = PR_DISTANCES[normalizedName];
      if (!prDistance) continue;

      const existing = bestByDistance.get(normalizedName);
      if (!existing || effort.elapsed_time < existing.timeSeconds) {
        bestByDistance.set(normalizedName, {
          timeSeconds: effort.elapsed_time,
          date: effort.start_date,
          activityId: activity.activityId,
          activityName: activity.activityName,
        });
      }
    }
  }

  const records: Array<{
    distance: string;
    distanceLabel: string;
    timeSeconds: number;
    timeFormatted: string;
    paceFormatted: string;
    date: string;
    activityStravaId: number;
    activityName: string;
  }> = [];

  for (const [distKey, best] of bestByDistance.entries()) {
    const prDist = PR_DISTANCES[distKey];
    const distanceMiles = metersToMiles(prDist.meters);
    const paceMinPerMile = best.timeSeconds / 60 / distanceMiles;

    records.push({
      distance: distKey,
      distanceLabel: prDist.label,
      timeSeconds: best.timeSeconds,
      timeFormatted: formatDuration(best.timeSeconds),
      paceFormatted: formatPace(paceMinPerMile),
      date: best.date,
      activityStravaId: best.activityId,
      activityName: best.activityName,
    });
  }

  return records;
}

// --- Year summaries ---

export interface YearSummaryInput {
  year: number;
  distanceMiles: number;
  movingTimeSeconds: number;
  elevationFeet: number;
  isRace: boolean;
  longestRunMiles: number;
}

/**
 * Compute year summaries from activity data grouped by year.
 */
export function computeYearSummaries(activities: YearSummaryInput[]): Map<
  number,
  {
    totalRuns: number;
    totalDistanceMiles: number;
    totalElevationFeet: number;
    totalDurationSeconds: number;
    avgPaceFormatted: string;
    longestRunMiles: number;
    raceCount: number;
  }
> {
  const byYear = new Map<number, YearSummaryInput[]>();

  for (const a of activities) {
    const existing = byYear.get(a.year) ?? [];
    existing.push(a);
    byYear.set(a.year, existing);
  }

  const summaries = new Map<
    number,
    {
      totalRuns: number;
      totalDistanceMiles: number;
      totalElevationFeet: number;
      totalDurationSeconds: number;
      avgPaceFormatted: string;
      longestRunMiles: number;
      raceCount: number;
    }
  >();

  for (const [year, yearActivities] of byYear.entries()) {
    const totalRuns = yearActivities.length;
    const totalDistanceMiles = yearActivities.reduce(
      (sum, a) => sum + a.distanceMiles,
      0
    );
    const totalElevationFeet = yearActivities.reduce(
      (sum, a) => sum + a.elevationFeet,
      0
    );
    const totalDurationSeconds = yearActivities.reduce(
      (sum, a) => sum + a.movingTimeSeconds,
      0
    );
    const longestRunMiles = Math.max(
      ...yearActivities.map((a) => a.longestRunMiles)
    );
    const raceCount = yearActivities.filter((a) => a.isRace).length;

    const avgPaceMinPerMile =
      totalDistanceMiles > 0
        ? totalDurationSeconds / 60 / totalDistanceMiles
        : 0;
    const avgPaceFormatted = formatPace(
      avgPaceMinPerMile > 0 ? avgPaceMinPerMile : null
    );

    summaries.set(year, {
      totalRuns,
      totalDistanceMiles: Math.round(totalDistanceMiles * 100) / 100,
      totalElevationFeet: Math.round(totalElevationFeet * 100) / 100,
      totalDurationSeconds,
      avgPaceFormatted,
      longestRunMiles: Math.round(longestRunMiles * 100) / 100,
      raceCount,
    });
  }

  return summaries;
}

// --- Streaks ---

/**
 * Calculate current and longest running streaks.
 * A streak is consecutive days with at least one run.
 */
export function calculateStreaks(runDatesISO: string[]): {
  currentStreakDays: number;
  currentStreakStart: string | null;
  currentStreakEnd: string | null;
  longestStreakDays: number;
  longestStreakStart: string | null;
  longestStreakEnd: string | null;
} {
  if (runDatesISO.length === 0) {
    return {
      currentStreakDays: 0,
      currentStreakStart: null,
      currentStreakEnd: null,
      longestStreakDays: 0,
      longestStreakStart: null,
      longestStreakEnd: null,
    };
  }

  // Get unique dates sorted ascending
  const uniqueDates = [
    ...new Set(runDatesISO.map((d) => d.substring(0, 10))),
  ].sort();

  let longestStreak = 1;
  let longestStart = uniqueDates[0];
  let longestEnd = uniqueDates[0];
  let currentStreak = 1;
  let currentStart = uniqueDates[0];

  for (let i = 1; i < uniqueDates.length; i++) {
    const prev = new Date(uniqueDates[i - 1]);
    const curr = new Date(uniqueDates[i]);
    const diffDays = (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);

    if (diffDays === 1) {
      currentStreak++;
    } else {
      if (currentStreak > longestStreak) {
        longestStreak = currentStreak;
        longestStart = currentStart;
        longestEnd = uniqueDates[i - 1];
      }
      currentStreak = 1;
      currentStart = uniqueDates[i];
    }
  }

  if (currentStreak > longestStreak) {
    longestStreak = currentStreak;
    longestStart = currentStart;
    longestEnd = uniqueDates[uniqueDates.length - 1];
  }

  // Current streak: only valid if it includes today or yesterday
  const today = new Date().toISOString().substring(0, 10);
  const yesterday = new Date(Date.now() - 86400000)
    .toISOString()
    .substring(0, 10);
  const lastRunDate = uniqueDates[uniqueDates.length - 1];

  let currentStreakResult = {
    days: currentStreak,
    start: currentStart,
    end: uniqueDates[uniqueDates.length - 1],
  };

  if (lastRunDate !== today && lastRunDate !== yesterday) {
    currentStreakResult = { days: 0, start: '', end: '' };
  }

  return {
    currentStreakDays: currentStreakResult.days,
    currentStreakStart: currentStreakResult.start || null,
    currentStreakEnd: currentStreakResult.end || null,
    longestStreakDays: longestStreak,
    longestStreakStart: longestStart,
    longestStreakEnd: longestEnd,
  };
}

// --- Eddington number ---

/**
 * Calculate the Eddington number for running.
 * The Eddington number E is the largest number such that you have run
 * at least E miles on at least E days.
 */
export function calculateEddington(dailyMiles: number[]): {
  number: number;
  nextTarget: number;
  daysAtNextTarget: number;
  runsNeeded: number;
} {
  const sorted = [...dailyMiles].sort((a, b) => b - a);

  let eddington = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] >= i + 1) {
      eddington = i + 1;
    } else {
      break;
    }
  }

  const nextTarget = eddington + 1;
  const daysAtNextTarget = sorted.filter((d) => d >= nextTarget).length;
  const runsNeeded = nextTarget - daysAtNextTarget;

  return {
    number: eddington,
    nextTarget,
    daysAtNextTarget,
    runsNeeded: Math.max(0, runsNeeded),
  };
}
