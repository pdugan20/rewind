/**
 * Recompute Strava Stats Script
 *
 * Fetches all activity data from remote D1, computes year summaries,
 * lifetime stats, streaks, and Eddington number, then writes results
 * back to the database. No Strava API calls needed.
 *
 * Usage:
 *   npx tsx scripts/recompute-strava-stats.ts
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DB_NAME = 'rewind-db';

// --- Unit helpers ---

function formatPace(minPerMile: number | null): string {
  if (minPerMile === null || minPerMile <= 0) return '0:00/mi';
  const minutes = Math.floor(minPerMile);
  const seconds = Math.round((minPerMile - minutes) * 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}/mi`;
}

// --- SQL helpers ---

function escapeSQL(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

function executeRemoteSQL(sql: string): void {
  const tmpFile = resolve(import.meta.dirname ?? '.', '.tmp-recompute.sql');
  writeFileSync(tmpFile, sql);
  try {
    execSync(
      `npx wrangler d1 execute ${DB_NAME} --remote --file="${tmpFile}"`,
      { stdio: 'pipe', timeout: 60_000 }
    );
  } finally {
    try {
      execSync(`rm "${tmpFile}"`, { stdio: 'pipe' });
    } catch {
      // ignore
    }
  }
}

function queryRemoteSQL<T>(sql: string): T[] {
  const result = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --command="${sql.replace(/"/g, '\\"')}" --json`,
    { stdio: 'pipe', timeout: 30_000 }
  ).toString();
  const parsed = JSON.parse(result) as Array<{ results: T[] }>;
  return parsed[0]?.results ?? [];
}

// --- Stats computation (mirrors transforms.ts) ---

interface Activity {
  start_date_local: string;
  distance_miles: number;
  moving_time_seconds: number;
  total_elevation_gain_feet: number;
  is_race: number;
}

function computeYearSummaries(activities: Activity[]) {
  const byYear = new Map<number, Activity[]>();
  for (const a of activities) {
    const year = new Date(a.start_date_local).getFullYear();
    const existing = byYear.get(year) ?? [];
    existing.push(a);
    byYear.set(year, existing);
  }

  const summaries: Array<{
    year: number;
    totalRuns: number;
    totalDistanceMiles: number;
    totalElevationFeet: number;
    totalDurationSeconds: number;
    avgPaceFormatted: string;
    longestRunMiles: number;
    raceCount: number;
  }> = [];

  for (const [year, yearActivities] of byYear.entries()) {
    const totalRuns = yearActivities.length;
    const totalDistanceMiles = yearActivities.reduce(
      (sum, a) => sum + a.distance_miles,
      0
    );
    const totalElevationFeet = yearActivities.reduce(
      (sum, a) => sum + a.total_elevation_gain_feet,
      0
    );
    const totalDurationSeconds = yearActivities.reduce(
      (sum, a) => sum + a.moving_time_seconds,
      0
    );
    const longestRunMiles = Math.max(
      ...yearActivities.map((a) => a.distance_miles)
    );
    const raceCount = yearActivities.filter((a) => a.is_race === 1).length;
    const avgPaceMinPerMile =
      totalDistanceMiles > 0
        ? totalDurationSeconds / 60 / totalDistanceMiles
        : 0;

    summaries.push({
      year,
      totalRuns,
      totalDistanceMiles: Math.round(totalDistanceMiles * 100) / 100,
      totalElevationFeet: Math.round(totalElevationFeet * 100) / 100,
      totalDurationSeconds,
      avgPaceFormatted: formatPace(
        avgPaceMinPerMile > 0 ? avgPaceMinPerMile : null
      ),
      longestRunMiles: Math.round(longestRunMiles * 100) / 100,
      raceCount,
    });
  }

  return summaries;
}

function calculateStreaks(runDatesISO: string[]) {
  if (runDatesISO.length === 0) {
    return {
      currentStreakDays: 0,
      currentStreakStart: null as string | null,
      currentStreakEnd: null as string | null,
      longestStreakDays: 0,
      longestStreakStart: null as string | null,
      longestStreakEnd: null as string | null,
    };
  }

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
    const diffDays =
      (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);

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

  const today = new Date().toISOString().substring(0, 10);
  const yesterday = new Date(Date.now() - 86400000)
    .toISOString()
    .substring(0, 10);
  const lastRunDate = uniqueDates[uniqueDates.length - 1];

  let currentResult = {
    days: currentStreak,
    start: currentStart,
    end: uniqueDates[uniqueDates.length - 1],
  };

  if (lastRunDate !== today && lastRunDate !== yesterday) {
    currentResult = { days: 0, start: '', end: '' };
  }

  return {
    currentStreakDays: currentResult.days,
    currentStreakStart: currentResult.start || null,
    currentStreakEnd: currentResult.end || null,
    longestStreakDays: longestStreak,
    longestStreakStart: longestStart,
    longestStreakEnd: longestEnd,
  };
}

function calculateEddington(dailyMiles: number[]) {
  const sorted = [...dailyMiles].sort((a, b) => b - a);

  let eddington = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] >= i + 1) {
      eddington = i + 1;
    } else {
      break;
    }
  }

  return eddington;
}

// --- Main ---

async function main() {
  console.log('[INFO] Fetching all activities from remote DB...');
  const activities = queryRemoteSQL<Activity>(
    'SELECT start_date_local, distance_miles, moving_time_seconds, total_elevation_gain_feet, is_race FROM strava_activities WHERE is_deleted = 0 ORDER BY start_date'
  );
  console.log(`[INFO] Found ${activities.length} activities`);

  if (activities.length === 0) {
    console.log('[INFO] No activities to process');
    return;
  }

  // Year summaries
  console.log('[INFO] Computing year summaries...');
  const yearSummaries = computeYearSummaries(activities);
  const now = new Date().toISOString();

  const yearStatements: string[] = [];
  for (const summary of yearSummaries) {
    yearStatements.push(
      `INSERT OR REPLACE INTO strava_year_summaries (user_id, year, total_runs, total_distance_miles, total_elevation_feet, total_duration_seconds, avg_pace_formatted, longest_run_miles, race_count, created_at, updated_at) VALUES (1, ${summary.year}, ${summary.totalRuns}, ${summary.totalDistanceMiles}, ${summary.totalElevationFeet}, ${summary.totalDurationSeconds}, ${escapeSQL(summary.avgPaceFormatted)}, ${summary.longestRunMiles}, ${summary.raceCount}, ${escapeSQL(now)}, ${escapeSQL(now)});`
    );
  }
  executeRemoteSQL(yearStatements.join('\n'));
  console.log(`[INFO] Updated ${yearSummaries.length} year summaries`);

  // Lifetime stats
  console.log('[INFO] Computing lifetime stats...');
  const totalRuns = activities.length;
  const totalDistanceMiles = activities.reduce(
    (sum, a) => sum + a.distance_miles,
    0
  );
  const totalElevationFeet = activities.reduce(
    (sum, a) => sum + a.total_elevation_gain_feet,
    0
  );
  const totalDurationSeconds = activities.reduce(
    (sum, a) => sum + a.moving_time_seconds,
    0
  );
  const avgPaceMinPerMile =
    totalDistanceMiles > 0 ? totalDurationSeconds / 60 / totalDistanceMiles : 0;

  const years = new Set(
    activities.map((a) => new Date(a.start_date_local).getFullYear())
  );
  const firstRun = activities[0]?.start_date_local ?? null;

  // Streaks
  const runDates = activities.map((a) => a.start_date_local);
  const streaks = calculateStreaks(runDates);

  // Eddington
  const dailyMilesMap = new Map<string, number>();
  for (const a of activities) {
    const date = a.start_date_local.substring(0, 10);
    dailyMilesMap.set(date, (dailyMilesMap.get(date) ?? 0) + a.distance_miles);
  }
  const eddington = calculateEddington([...dailyMilesMap.values()]);

  const lifetimeSQL = `INSERT OR REPLACE INTO strava_lifetime_stats (user_id, total_runs, total_distance_miles, total_elevation_feet, total_duration_seconds, avg_pace_formatted, years_active, first_run, eddington_number, current_streak_days, current_streak_start, current_streak_end, longest_streak_days, longest_streak_start, longest_streak_end, updated_at) VALUES (1, ${totalRuns}, ${Math.round(totalDistanceMiles * 100) / 100}, ${Math.round(totalElevationFeet * 100) / 100}, ${totalDurationSeconds}, ${escapeSQL(formatPace(avgPaceMinPerMile > 0 ? avgPaceMinPerMile : null))}, ${years.size}, ${escapeSQL(firstRun)}, ${eddington}, ${streaks.currentStreakDays}, ${escapeSQL(streaks.currentStreakStart)}, ${escapeSQL(streaks.currentStreakEnd)}, ${streaks.longestStreakDays}, ${escapeSQL(streaks.longestStreakStart)}, ${escapeSQL(streaks.longestStreakEnd)}, ${escapeSQL(now)});`;
  executeRemoteSQL(lifetimeSQL);

  console.log('[SUCCESS] Stats recomputed');
  console.log(`  Total runs: ${totalRuns}`);
  console.log(
    `  Total distance: ${Math.round(totalDistanceMiles * 100) / 100} miles`
  );
  console.log(`  Years active: ${years.size}`);
  console.log(`  Eddington number: ${eddington}`);
  console.log(`  Longest streak: ${streaks.longestStreakDays} days`);
  console.log(`  Current streak: ${streaks.currentStreakDays} days`);
}

main().catch((error) => {
  console.error(`[FATAL] ${error}`);
  process.exit(1);
});
