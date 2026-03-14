/**
 * Strava Bulk Import Script
 *
 * One-time script to import all historical Strava running activities into
 * the remote D1 database. Handles rate limits, checkpoint/resume, and
 * fetches detail + splits for each activity.
 *
 * Reads STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET from .dev.vars,
 * fetches the refresh token from the strava_tokens table in remote D1,
 * and handles token refresh automatically.
 *
 * Prerequisites:
 *   1. .dev.vars contains STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET
 *   2. strava_tokens table has a row with a valid refresh_token
 *   3. Ensure wrangler is authenticated (`npx wrangler login`).
 *
 * Usage:
 *   npx tsx scripts/import-strava.ts
 *
 * Resume from checkpoint:
 *   npx tsx scripts/import-strava.ts --resume
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const STRAVA_BASE_URL = 'https://www.strava.com/api/v3';
const DB_NAME = 'rewind-db';
const CHECKPOINT_FILE = resolve(
  import.meta.dirname ?? '.',
  '.strava-checkpoint.json'
);
const RATE_LIMIT_PAUSE_MS = 15 * 60 * 1000 + 10_000; // 15 min + 10s buffer

// --- Types ---

interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  workout_type: number | null;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  start_date: string;
  start_date_local: string;
  timezone: string;
  start_latlng: [number, number] | null;
  end_latlng: [number, number] | null;
  location_city: string | null;
  location_state: string | null;
  location_country: string | null;
  average_speed: number;
  max_speed: number;
  average_heartrate: number | null;
  max_heartrate: number | null;
  average_cadence: number | null;
  calories: number | null;
  suffer_score: number | null;
  map: { summary_polyline: string | null } | null;
  gear_id: string | null;
  achievement_count: number;
  pr_count: number;
  best_efforts?: StravaBestEffort[];
  splits_standard?: StravaSplit[];
}

interface StravaBestEffort {
  name: string;
  distance: number;
  elapsed_time: number;
  moving_time: number;
  start_date: string;
  pr_rank: number | null;
}

interface StravaSplit {
  distance: number;
  elapsed_time: number;
  moving_time: number;
  elevation_difference: number;
  average_speed: number;
  average_heartrate: number | null;
  average_grade_adjusted_speed: number | null;
  split: number;
}

interface Checkpoint {
  processedIds: number[];
  lastPage: number;
  allActivityIds: number[];
}

interface RateLimitState {
  fifteenMinUsage: number;
  fifteenMinLimit: number;
  dailyUsage: number;
  dailyLimit: number;
}

// --- Unit conversions (mirror transforms.ts) ---

function metersToMiles(meters: number): number {
  return Math.round(meters * 0.000621371 * 100) / 100;
}

function metersToFeet(meters: number): number {
  return Math.round(meters * 3.28084 * 100) / 100;
}

function msToMinPerMile(speedMs: number): number | null {
  if (!speedMs || speedMs <= 0) return null;
  return 26.8224 / speedMs;
}

function formatPace(minPerMile: number | null): string {
  if (minPerMile === null || minPerMile <= 0) return '0:00/mi';
  const minutes = Math.floor(minPerMile);
  const seconds = Math.round((minPerMile - minutes) * 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}/mi`;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

// --- Credentials from .dev.vars ---

function loadDevVars(): Record<string, string> {
  const devVarsPath = resolve(import.meta.dirname ?? '.', '..', '.dev.vars');
  if (!existsSync(devVarsPath)) {
    console.error('[ERROR] .dev.vars file not found');
    process.exit(1);
  }
  const content = readFileSync(devVarsPath, 'utf-8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

const devVars = loadDevVars();
const STRAVA_CLIENT_ID = devVars.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = devVars.STRAVA_CLIENT_SECRET;

if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
  console.error(
    '[ERROR] STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET must be set in .dev.vars'
  );
  process.exit(1);
}

// --- Token management ---

let currentAccessToken: string | null = null;
let tokenExpiresAt = 0;
const TOKEN_EXPIRY_BUFFER = 300; // 5 minutes

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid
  if (
    currentAccessToken &&
    Date.now() / 1000 < tokenExpiresAt - TOKEN_EXPIRY_BUFFER
  ) {
    return currentAccessToken;
  }

  // Fetch refresh token from remote D1
  console.log('[INFO] Refreshing Strava access token...');
  const tokenResult = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --command="SELECT access_token, refresh_token, expires_at FROM strava_tokens WHERE user_id = 1 LIMIT 1;" --json`,
    { stdio: 'pipe', timeout: 30_000 }
  ).toString();

  const parsed = JSON.parse(tokenResult) as Array<{
    results: Array<{
      access_token: string;
      refresh_token: string;
      expires_at: number;
    }>;
  }>;

  const stored = parsed[0]?.results?.[0];
  if (!stored) {
    console.error(
      '[ERROR] No token found in strava_tokens table. Seed it first.'
    );
    process.exit(1);
  }

  // Check if stored token is still valid
  if (Date.now() / 1000 < stored.expires_at - TOKEN_EXPIRY_BUFFER) {
    currentAccessToken = stored.access_token;
    tokenExpiresAt = stored.expires_at;
    console.log('[INFO] Using existing valid token');
    return currentAccessToken;
  }

  // Refresh the token
  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: stored.refresh_token,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      `[ERROR] Token refresh failed (${response.status}): ${errorText}`
    );
    process.exit(1);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };

  // Persist new tokens back to D1
  const now = new Date().toISOString();
  const updateSQL = `UPDATE strava_tokens SET access_token = ${escapeSQL(data.access_token)}, refresh_token = ${escapeSQL(data.refresh_token)}, expires_at = ${data.expires_at}, updated_at = ${escapeSQL(now)} WHERE user_id = 1;`;
  executeRemoteSQL(updateSQL);

  currentAccessToken = data.access_token;
  tokenExpiresAt = data.expires_at;
  console.log('[INFO] Token refreshed successfully');
  return currentAccessToken;
}

// --- Strava API ---

const rateLimitState: RateLimitState = {
  fifteenMinUsage: 0,
  fifteenMinLimit: 200,
  dailyUsage: 0,
  dailyLimit: 2000,
};

function parseRateLimitHeaders(headers: Headers): void {
  const limitHeader = headers.get('X-RateLimit-Limit');
  const usageHeader = headers.get('X-RateLimit-Usage');
  if (limitHeader) {
    const [fifteenMin, daily] = limitHeader.split(',').map(Number);
    rateLimitState.fifteenMinLimit = fifteenMin;
    rateLimitState.dailyLimit = daily;
  }
  if (usageHeader) {
    const [fifteenMin, daily] = usageHeader.split(',').map(Number);
    rateLimitState.fifteenMinUsage = fifteenMin;
    rateLimitState.dailyUsage = daily;
  }
}

function logRateLimit(): void {
  console.log(
    `[RATE] ${rateLimitState.fifteenMinUsage}/${rateLimitState.fifteenMinLimit} (15min), ` +
      `${rateLimitState.dailyUsage}/${rateLimitState.dailyLimit} (daily)`
  );
}

async function stravaRequest<T>(
  path: string,
  params?: URLSearchParams
): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`${STRAVA_BASE_URL}${path}`);
  if (params) {
    params.forEach((value, key) => url.searchParams.set(key, value));
  }

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  parseRateLimitHeaders(response.headers);

  if (response.status === 429) {
    console.log('[RATE] Rate limited by Strava. Waiting 15 minutes...');
    logRateLimit();
    await sleep(RATE_LIMIT_PAUSE_MS);
    return stravaRequest<T>(path, params);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Strava API ${path} failed (${response.status}): ${errorText}`
    );
  }

  return response.json() as Promise<T>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Checkpoint ---

function loadCheckpoint(): Checkpoint | null {
  if (!existsSync(CHECKPOINT_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8')) as Checkpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(checkpoint: Checkpoint): void {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

// --- D1 insert via wrangler ---

function escapeSQL(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

function executeRemoteSQL(sql: string): void {
  try {
    execSync(
      `npx wrangler d1 execute ${DB_NAME} --remote --command="${sql.replace(/"/g, '\\"')}"`,
      {
        stdio: 'pipe',
        timeout: 30_000,
      }
    );
  } catch {
    // For long SQL, use file approach
    const tmpFile = resolve(import.meta.dirname ?? '.', '.tmp-sql.sql');
    writeFileSync(tmpFile, sql);
    try {
      execSync(
        `npx wrangler d1 execute ${DB_NAME} --remote --file="${tmpFile}"`,
        {
          stdio: 'pipe',
          timeout: 30_000,
        }
      );
    } finally {
      try {
        execSync(`rm "${tmpFile}"`, { stdio: 'pipe' });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

// --- Transform + Insert ---

function buildActivityInsertSQL(activity: StravaActivity): string {
  const distanceMiles = metersToMiles(activity.distance);
  const elevationFeet = metersToFeet(activity.total_elevation_gain);
  const paceMinPerMile = msToMinPerMile(activity.average_speed);
  const paceFormatted = formatPace(paceMinPerMile);
  const now = new Date().toISOString();

  const columns = [
    'user_id',
    'strava_id',
    'name',
    'sport_type',
    'workout_type',
    'distance_meters',
    'distance_miles',
    'moving_time_seconds',
    'elapsed_time_seconds',
    'total_elevation_gain_meters',
    'total_elevation_gain_feet',
    'start_date',
    'start_date_local',
    'timezone',
    'start_lat',
    'start_lng',
    'city',
    'state',
    'country',
    'average_speed_ms',
    'max_speed_ms',
    'pace_min_per_mile',
    'pace_formatted',
    'average_heartrate',
    'max_heartrate',
    'average_cadence',
    'calories',
    'suffer_score',
    'map_polyline',
    'gear_id',
    'achievement_count',
    'pr_count',
    'is_race',
    'is_deleted',
    'strava_url',
    'created_at',
    'updated_at',
  ];

  const values = [
    1,
    activity.id,
    escapeSQL(activity.name),
    escapeSQL(activity.sport_type || activity.type || 'Run'),
    activity.workout_type ?? 0,
    activity.distance,
    distanceMiles,
    activity.moving_time,
    activity.elapsed_time,
    activity.total_elevation_gain,
    elevationFeet,
    escapeSQL(activity.start_date),
    escapeSQL(activity.start_date_local),
    escapeSQL(activity.timezone),
    activity.start_latlng?.[0] ?? 'NULL',
    activity.start_latlng?.[1] ?? 'NULL',
    escapeSQL(activity.location_city),
    escapeSQL(activity.location_state),
    escapeSQL(activity.location_country),
    activity.average_speed,
    activity.max_speed,
    paceMinPerMile ?? 'NULL',
    escapeSQL(paceFormatted),
    activity.average_heartrate ?? 'NULL',
    activity.max_heartrate ?? 'NULL',
    activity.average_cadence ?? 'NULL',
    activity.calories ?? 'NULL',
    activity.suffer_score ?? 'NULL',
    escapeSQL(activity.map?.summary_polyline ?? null),
    escapeSQL(activity.gear_id),
    activity.achievement_count ?? 0,
    activity.pr_count ?? 0,
    activity.workout_type === 1 ? 1 : 0,
    0,
    escapeSQL(`https://www.strava.com/activities/${activity.id}`),
    escapeSQL(now),
    escapeSQL(now),
  ];

  return `INSERT OR REPLACE INTO strava_activities (${columns.join(', ')}) VALUES (${values.join(', ')});`;
}

function buildSplitsInsertSQL(
  activityStravaId: number,
  splits: StravaSplit[]
): string {
  const statements: string[] = [
    `DELETE FROM strava_splits WHERE activity_strava_id = ${activityStravaId};`,
  ];

  for (const split of splits) {
    const distanceMiles = metersToMiles(split.distance);
    const paceMinPerMile = msToMinPerMile(split.average_speed);
    const paceFormatted = formatPace(paceMinPerMile);

    const columns = [
      'activity_strava_id',
      'split_number',
      'distance_meters',
      'distance_miles',
      'moving_time_seconds',
      'elapsed_time_seconds',
      'elevation_difference_meters',
      'elevation_difference_feet',
      'average_speed_ms',
      'pace_min_per_mile',
      'pace_formatted',
      'average_heartrate',
      'average_cadence',
    ];

    const values = [
      activityStravaId,
      split.split,
      split.distance,
      distanceMiles,
      split.moving_time,
      split.elapsed_time,
      split.elevation_difference,
      metersToFeet(split.elevation_difference),
      split.average_speed,
      paceMinPerMile ?? 'NULL',
      escapeSQL(paceFormatted),
      split.average_heartrate ?? 'NULL',
      'NULL',
    ];

    statements.push(
      `INSERT INTO strava_splits (${columns.join(', ')}) VALUES (${values.join(', ')});`
    );
  }

  return statements.join('\n');
}

function buildPRInsertSQL(
  prs: Array<{
    distance: string;
    distanceLabel: string;
    timeSeconds: number;
    timeFormatted: string;
    paceFormatted: string;
    date: string;
    activityStravaId: number;
    activityName: string;
  }>
): string {
  const statements: string[] = [];

  for (const pr of prs) {
    const columns = [
      'user_id',
      'distance',
      'distance_label',
      'time_seconds',
      'time_formatted',
      'pace_formatted',
      'date',
      'activity_strava_id',
      'activity_name',
    ];
    const values = [
      1,
      escapeSQL(pr.distance),
      escapeSQL(pr.distanceLabel),
      pr.timeSeconds,
      escapeSQL(pr.timeFormatted),
      escapeSQL(pr.paceFormatted),
      escapeSQL(pr.date),
      pr.activityStravaId,
      escapeSQL(pr.activityName),
    ];

    statements.push(
      `INSERT OR REPLACE INTO strava_personal_records (${columns.join(', ')}) VALUES (${values.join(', ')});`
    );
  }

  return statements.join('\n');
}

// --- PR extraction (mirror transforms.ts) ---

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

function extractPRs(
  activities: Array<{
    bestEfforts: StravaBestEffort[];
    activityId: number;
    activityName: string;
  }>
) {
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
      const normalizedName = effort.name
        .toLowerCase()
        .replace(/-/g, '_')
        .trim();
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

// --- Main ---

async function main() {
  const isResume = process.argv.includes('--resume');
  let checkpoint: Checkpoint | null = isResume ? loadCheckpoint() : null;

  console.log('[INFO] Strava bulk import starting');
  if (checkpoint) {
    console.log(
      `[INFO] Resuming from checkpoint: ${checkpoint.processedIds.length} activities already processed`
    );
  }

  // Phase 1: Fetch all activity IDs (list endpoint is cheap -- no detail)
  const allRunIds: number[] = checkpoint?.allActivityIds ?? [];

  if (allRunIds.length === 0) {
    console.log('[INFO] Phase 1: Fetching activity list...');
    let page = 1;
    const hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        page: String(page),
        per_page: '200',
      });

      const activities = await stravaRequest<StravaActivity[]>(
        '/athlete/activities',
        params
      );

      if (activities.length === 0) {
        break;
      }

      // Filter to runs only
      const runs = activities.filter(
        (a) =>
          a.sport_type === 'Run' ||
          a.type === 'Run' ||
          a.sport_type === 'TrailRun' ||
          a.sport_type === 'VirtualRun'
      );

      allRunIds.push(...runs.map((a) => a.id));
      console.log(
        `[INFO] Page ${page}: ${activities.length} activities, ${runs.length} runs (${allRunIds.length} total runs)`
      );

      page++;
      if (activities.length < 200) break;

      // Check rate limits -- pause early to leave room for detail fetches
      if (
        rateLimitState.fifteenMinUsage >=
        rateLimitState.fifteenMinLimit - 5
      ) {
        console.log(
          '[RATE] Approaching 15-min limit during list fetch. Pausing...'
        );
        logRateLimit();
        await sleep(RATE_LIMIT_PAUSE_MS);
      }
    }

    console.log(`[INFO] Found ${allRunIds.length} total runs`);

    // Save checkpoint with all IDs
    checkpoint = {
      processedIds: [],
      lastPage: page,
      allActivityIds: allRunIds,
    };
    saveCheckpoint(checkpoint);
  }

  // Phase 2: Fetch detail for each run and insert into D1
  const processedSet = new Set(checkpoint?.processedIds ?? []);
  const remaining = allRunIds.filter((id) => !processedSet.has(id));
  console.log(
    `[INFO] Phase 2: Fetching detail for ${remaining.length} runs...`
  );

  // Collect all best efforts for PR extraction at the end
  const allBestEfforts: Array<{
    bestEfforts: StravaBestEffort[];
    activityId: number;
    activityName: string;
  }> = [];

  for (let i = 0; i < remaining.length; i++) {
    const activityId = remaining[i];

    // Check rate limits before each request
    if (rateLimitState.fifteenMinUsage >= rateLimitState.fifteenMinLimit - 2) {
      console.log('[RATE] Approaching 15-min rate limit. Pausing...');
      logRateLimit();
      await sleep(RATE_LIMIT_PAUSE_MS);
    }

    if (rateLimitState.dailyUsage >= rateLimitState.dailyLimit - 10) {
      console.log(
        '[RATE] Approaching daily rate limit. Stopping. Re-run tomorrow with --resume.'
      );
      logRateLimit();
      saveCheckpoint(checkpoint!);
      process.exit(0);
    }

    try {
      // Fetch activity detail (includes best_efforts and splits_standard)
      const params = new URLSearchParams({ include_all_efforts: 'true' });
      const detail = await stravaRequest<StravaActivity>(
        `/activities/${activityId}`,
        params
      );

      // Build and execute SQL
      const activitySQL = buildActivityInsertSQL(detail);
      executeRemoteSQL(activitySQL);

      // Insert splits
      if (detail.splits_standard?.length) {
        const splitsSQL = buildSplitsInsertSQL(
          detail.id,
          detail.splits_standard
        );
        executeRemoteSQL(splitsSQL);
      }

      // Collect best efforts for PR extraction
      if (detail.best_efforts?.length) {
        allBestEfforts.push({
          bestEfforts: detail.best_efforts,
          activityId: detail.id,
          activityName: detail.name,
        });
      }

      processedSet.add(activityId);
      checkpoint!.processedIds = [...processedSet];

      // Save checkpoint every 10 activities
      if ((i + 1) % 10 === 0) {
        saveCheckpoint(checkpoint!);
        console.log(
          `[INFO] Progress: ${i + 1}/${remaining.length} (${detail.name} - ${detail.start_date_local.substring(0, 10)})`
        );
        logRateLimit();
      }
    } catch (error) {
      console.error(
        `[ERROR] Failed to process activity ${activityId}: ${error}`
      );
      saveCheckpoint(checkpoint!);
      // Continue to next activity
    }
  }

  // Save final checkpoint
  saveCheckpoint(checkpoint!);

  // Phase 3: Extract and insert PRs
  if (allBestEfforts.length > 0) {
    console.log(
      `[INFO] Phase 3: Extracting PRs from ${allBestEfforts.length} activities...`
    );
    const prs = extractPRs(allBestEfforts);
    if (prs.length > 0) {
      const prSQL = buildPRInsertSQL(prs);
      executeRemoteSQL(prSQL);
      console.log(`[INFO] Inserted ${prs.length} personal records`);
    }
  }

  // Phase 4: Sync gear
  console.log('[INFO] Phase 4: Syncing gear...');
  try {
    // Get unique gear IDs from D1
    const gearResult = execSync(
      `npx wrangler d1 execute ${DB_NAME} --remote --command="SELECT DISTINCT gear_id FROM strava_activities WHERE gear_id IS NOT NULL AND is_deleted = 0;" --json`,
      { stdio: 'pipe', timeout: 30_000 }
    ).toString();

    const parsed = JSON.parse(gearResult) as Array<{
      results: Array<{ gear_id: string }>;
    }>;
    const gearIds = parsed[0]?.results?.map((r) => r.gear_id) ?? [];

    for (const gearId of gearIds) {
      try {
        const gear = await stravaRequest<{
          id: string;
          name: string;
          brand_name: string | null;
          model_name: string | null;
          distance: number;
          retired: boolean;
        }>(`/gear/${gearId}`);

        const now = new Date().toISOString();
        const sql = `INSERT OR REPLACE INTO strava_gear (strava_gear_id, user_id, name, brand, model, distance_meters, distance_miles, is_retired, updated_at) VALUES (${escapeSQL(gear.id)}, 1, ${escapeSQL(gear.name)}, ${escapeSQL(gear.brand_name)}, ${escapeSQL(gear.model_name)}, ${gear.distance}, ${metersToMiles(gear.distance)}, ${gear.retired ? 1 : 0}, ${escapeSQL(now)});`;
        executeRemoteSQL(sql);
        console.log(`[INFO] Synced gear: ${gear.name}`);
      } catch (error) {
        console.error(`[ERROR] Failed to sync gear ${gearId}: ${error}`);
      }
    }
  } catch (error) {
    console.error(`[ERROR] Gear sync failed: ${error}`);
  }

  console.log('[SUCCESS] Strava bulk import completed');
  console.log(`[INFO] Total activities imported: ${processedSet.size}`);
}

main().catch((error) => {
  console.error(`[FATAL] ${error}`);
  process.exit(1);
});
