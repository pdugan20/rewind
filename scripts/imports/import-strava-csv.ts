/**
 * Strava CSV Export Import Script
 *
 * Imports historical running activities from Strava's data export CSV
 * into the remote D1 database. Uses no API calls -- works entirely
 * from the exported activities.csv file.
 *
 * Designed to fill gaps left by the API-based import when the daily
 * rate limit was hit. Only imports activities not already in the DB.
 *
 * Usage:
 *   npx tsx scripts/import-strava-csv.ts <path-to-activities.csv>
 *
 * Example:
 *   npx tsx scripts/import-strava-csv.ts ~/Downloads/strava/activities.csv
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DB_NAME = 'rewind-db';

// --- CSV parser (handles quoted fields with commas) ---

function parseCSV(content: string): Record<string, string>[] {
  // Split into lines, preserving quotes (only split on unquoted newlines)
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '"') {
      current += char; // preserve the quote character
      inQuotes = !inQuotes;
    } else if (char === '\n' && !inQuotes) {
      if (current.trim()) lines.push(current);
      current = '';
    } else if (char === '\r' && !inQuotes) {
      // skip CR
    } else {
      current += char;
    }
  }
  if (current.trim()) lines.push(current);

  if (lines.length === 0) return [];

  const parseRow = (line: string): string[] => {
    const fields: string[] = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = !quoted;
        }
      } else if (ch === ',' && !quoted) {
        fields.push(field);
        field = '';
      } else {
        field += ch;
      }
    }
    fields.push(field);
    return fields;
  };

  const headers = parseRow(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseRow(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? '';
    }
    rows.push(row);
  }

  return rows;
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

// --- Date parsing ---

function parseStravaDate(dateStr: string): string {
  // Format: "Jan 20, 2017, 2:43:45 AM"
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    throw new Error(`Failed to parse date: ${dateStr}`);
  }
  return date.toISOString();
}

// --- SQL helpers ---

function escapeSQL(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

function executeRemoteSQL(sql: string): void {
  const tmpFile = resolve(import.meta.dirname ?? '.', '.tmp-csv-import.sql');
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

function executeRemoteSQLJson(sql: string): unknown[] {
  const result = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --command="${sql.replace(/"/g, '\\"')}" --json`,
    { stdio: 'pipe', timeout: 30_000 }
  ).toString();
  const parsed = JSON.parse(result) as Array<{ results: unknown[] }>;
  return parsed[0]?.results ?? [];
}

// --- Map Activity Type to sport_type ---

function mapSportType(activityType: string): string {
  switch (activityType) {
    case 'Trail Run':
      return 'TrailRun';
    case 'Virtual Run':
      return 'VirtualRun';
    default:
      return 'Run';
  }
}

// --- Main ---

interface CSVRow {
  'Activity ID': string;
  'Activity Date': string;
  'Activity Name': string;
  'Activity Type': string;
  'Activity Description': string;
  'Elapsed Time': string;
  Distance: string;
  'Max Heart Rate': string;
  'Relative Effort': string;
  'Activity Gear': string;
  'Moving Time': string;
  'Max Speed': string;
  'Average Speed': string;
  'Elevation Gain': string;
  'Average Cadence': string;
  'Average Heart Rate': string;
  Calories: string;
  Gear: string;
  Competition: string;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error(
      '[ERROR] Usage: npx tsx scripts/import-strava-csv.ts <path-to-activities.csv>'
    );
    process.exit(1);
  }

  console.log('[INFO] Loading CSV...');
  const csvContent = readFileSync(csvPath, 'utf-8');
  const rows = parseCSV(csvContent) as unknown as CSVRow[];

  // Filter to runs only
  const runTypes = new Set(['Run', 'Trail Run', 'Virtual Run']);
  const runs = rows.filter((r) => runTypes.has(r['Activity Type']));
  console.log(
    `[INFO] Found ${runs.length} runs in CSV (${rows.length} total activities)`
  );

  // Get existing activity IDs from remote DB
  console.log('[INFO] Fetching existing activity IDs from remote DB...');
  const existing = executeRemoteSQLJson(
    'SELECT strava_id FROM strava_activities ORDER BY strava_id'
  ) as Array<{ strava_id: number }>;
  const existingIds = new Set(existing.map((r) => r.strava_id));
  console.log(`[INFO] ${existingIds.size} activities already in DB`);

  // Filter to missing runs
  const missing = runs.filter(
    (r) => !existingIds.has(parseInt(r['Activity ID'], 10))
  );
  console.log(`[INFO] ${missing.length} runs to import`);

  if (missing.length === 0) {
    console.log('[INFO] Nothing to import -- all runs already in DB');
    return;
  }

  // Build batch SQL statements
  const BATCH_SIZE = 50;
  let imported = 0;
  let errors = 0;

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    const statements: string[] = [];

    for (const row of batch) {
      try {
        const stravaId = parseInt(row['Activity ID'], 10);
        const dateISO = parseStravaDate(row['Activity Date']);
        const distanceMeters = parseFloat(row['Distance']) || 0;
        const distanceMiles = metersToMiles(distanceMeters);
        const movingTime = Math.round(parseFloat(row['Moving Time']) || 0);
        const elapsedTime = Math.round(
          parseFloat(row['Elapsed Time']) || movingTime
        );
        const elevationGain = parseFloat(row['Elevation Gain']) || 0;
        const maxSpeed = parseFloat(row['Max Speed']) || 0;

        // Compute average speed from distance/time if not in CSV
        let avgSpeed = parseFloat(row['Average Speed']) || 0;
        if (!avgSpeed && distanceMeters > 0 && movingTime > 0) {
          avgSpeed = distanceMeters / movingTime;
        }

        const paceMinPerMile = msToMinPerMile(avgSpeed);
        const paceFormatted = formatPace(paceMinPerMile);

        const avgHR = parseFloat(row['Average Heart Rate']) || null;
        const maxHR = parseFloat(row['Max Heart Rate']) || null;
        const avgCadence = parseFloat(row['Average Cadence']) || null;
        const calories = parseFloat(row['Calories']) || null;
        const sportType = mapSportType(row['Activity Type']);
        const isCompetition = row['Competition']?.trim() === 'true' ? 1 : 0;
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
          'average_speed_ms',
          'max_speed_ms',
          'pace_min_per_mile',
          'pace_formatted',
          'average_heartrate',
          'max_heartrate',
          'average_cadence',
          'calories',
          'is_race',
          'is_deleted',
          'strava_url',
          'created_at',
          'updated_at',
        ];

        const values = [
          1,
          stravaId,
          escapeSQL(row['Activity Name']),
          escapeSQL(sportType),
          isCompetition ? 1 : 0,
          distanceMeters,
          distanceMiles,
          movingTime,
          elapsedTime,
          elevationGain,
          metersToFeet(elevationGain),
          escapeSQL(dateISO),
          escapeSQL(dateISO), // No timezone info, so local = UTC
          avgSpeed || 'NULL',
          maxSpeed || 'NULL',
          paceMinPerMile ?? 'NULL',
          escapeSQL(paceFormatted),
          avgHR ?? 'NULL',
          maxHR ?? 'NULL',
          avgCadence ?? 'NULL',
          calories ?? 'NULL',
          isCompetition,
          0,
          escapeSQL(`https://www.strava.com/activities/${stravaId}`),
          escapeSQL(now),
          escapeSQL(now),
        ];

        statements.push(
          `INSERT OR REPLACE INTO strava_activities (${columns.join(', ')}) VALUES (${values.join(', ')});`
        );
      } catch (error) {
        errors++;
        console.error(
          `[ERROR] Failed to build SQL for activity ${row['Activity ID']}: ${error}`
        );
      }
    }

    if (statements.length > 0) {
      try {
        executeRemoteSQL(statements.join('\n'));
        imported += statements.length;
        console.log(
          `[INFO] Progress: ${imported}/${missing.length} imported (batch ${Math.floor(i / BATCH_SIZE) + 1})`
        );
      } catch (error) {
        console.error(`[ERROR] Batch insert failed: ${error}`);
        // Try individual inserts as fallback
        for (const stmt of statements) {
          try {
            executeRemoteSQL(stmt);
            imported++;
          } catch (innerError) {
            errors++;
            console.error(`[ERROR] Individual insert failed: ${innerError}`);
          }
        }
      }
    }
  }

  console.log(
    `[SUCCESS] Import complete: ${imported} activities imported, ${errors} errors`
  );

  // Verify final count
  const finalCount = executeRemoteSQLJson(
    'SELECT COUNT(*) as cnt FROM strava_activities WHERE is_deleted = 0'
  ) as Array<{ cnt: number }>;
  console.log(`[INFO] Total activities in DB: ${finalCount[0]?.cnt}`);
}

main().catch((error) => {
  console.error(`[FATAL] ${error}`);
  process.exit(1);
});
