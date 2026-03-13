/**
 * Backfill Strava Polylines from GPX Files
 *
 * Reads GPX files from a Strava data export and encodes the GPS tracks
 * as Google-encoded polylines, then updates the remote D1 database.
 *
 * Only processes activities that are missing polyline data in the DB.
 * GPX filenames must match Strava activity IDs (e.g., 10061641666.gpx).
 *
 * Usage:
 *   npx tsx scripts/backfill-polylines.ts <path-to-activities-dir>
 *
 * Example:
 *   npx tsx scripts/backfill-polylines.ts ~/Downloads/strava/activities
 */

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const DB_NAME = 'rewind-db';

// --- Google Encoded Polyline Algorithm ---
// https://developers.google.com/maps/documentation/utilities/polylinealgorithm

function encodePolyline(points: Array<[number, number]>): string {
  let encoded = '';
  let prevLat = 0;
  let prevLng = 0;

  for (const [lat, lng] of points) {
    const latRound = Math.round(lat * 1e5);
    const lngRound = Math.round(lng * 1e5);

    encoded += encodeSignedValue(latRound - prevLat);
    encoded += encodeSignedValue(lngRound - prevLng);

    prevLat = latRound;
    prevLng = lngRound;
  }

  return encoded;
}

function encodeSignedValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let encoded = '';

  while (v >= 0x20) {
    encoded += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  encoded += String.fromCharCode(v + 63);

  return encoded;
}

// --- GPX Parser ---

function parseGPXPoints(content: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  const trkptRegex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"/g;
  let match;

  while ((match = trkptRegex.exec(content)) !== null) {
    const lat = parseFloat(match[1]);
    const lng = parseFloat(match[2]);
    if (!isNaN(lat) && !isNaN(lng)) {
      points.push([lat, lng]);
    }
  }

  return points;
}

/**
 * Simplify points using the Douglas-Peucker algorithm.
 * Strava's summary_polyline is typically simplified to ~500-1000 points.
 */
function simplifyPoints(
  points: Array<[number, number]>,
  epsilon: number
): Array<[number, number]> {
  if (points.length <= 2) return points;

  // Find the point with the maximum distance from the line
  let maxDist = 0;
  let maxIdx = 0;
  const start = points[0];
  const end = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], start, end);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = simplifyPoints(points.slice(0, maxIdx + 1), epsilon);
    const right = simplifyPoints(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [start, end];
}

function perpendicularDistance(
  point: [number, number],
  lineStart: [number, number],
  lineEnd: [number, number]
): number {
  const [px, py] = point;
  const [x1, y1] = lineStart;
  const [x2, y2] = lineEnd;

  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  }

  const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
  const clampedT = Math.max(0, Math.min(1, t));

  const closestX = x1 + clampedT * dx;
  const closestY = y1 + clampedT * dy;

  return Math.sqrt((px - closestX) ** 2 + (py - closestY) ** 2);
}

// --- SQL helpers ---

function escapeSQL(value: string): string {
  return value.replace(/'/g, "''");
}

function executeRemoteSQL(sql: string): void {
  const tmpFile = resolve(
    import.meta.dirname ?? '.',
    '.tmp-polyline-backfill.sql'
  );
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

// --- Main ---

async function main() {
  const activitiesDir = process.argv[2];
  if (!activitiesDir) {
    console.error(
      '[ERROR] Usage: npx tsx scripts/backfill-polylines.ts <path-to-activities-dir>'
    );
    process.exit(1);
  }

  const resolvedDir = resolve(activitiesDir);
  console.log(`[INFO] Reading GPX files from ${resolvedDir}`);

  // Get activity IDs missing polylines
  console.log('[INFO] Fetching activities missing polylines from remote DB...');
  const missing = executeRemoteSQLJson(
    "SELECT strava_id FROM strava_activities WHERE map_polyline IS NULL OR map_polyline = ''"
  ) as Array<{ strava_id: number }>;
  const missingIds = new Set(missing.map((r) => r.strava_id));
  console.log(`[INFO] ${missingIds.size} activities missing polylines`);

  // Find matching GPX files
  const files = readdirSync(resolvedDir);
  const gpxFiles = files.filter((f) => {
    if (!f.endsWith('.gpx')) return false;
    const id = parseInt(f.split('.')[0], 10);
    return missingIds.has(id);
  });
  console.log(`[INFO] ${gpxFiles.length} matching GPX files found`);

  if (gpxFiles.length === 0) {
    console.log('[INFO] Nothing to backfill');
    return;
  }

  // Process in batches
  const BATCH_SIZE = 25;
  // Epsilon for Douglas-Peucker simplification (in degrees, ~0.00001 = ~1m)
  const EPSILON = 0.00005;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < gpxFiles.length; i += BATCH_SIZE) {
    const batch = gpxFiles.slice(i, i + BATCH_SIZE);
    const statements: string[] = [];

    for (const file of batch) {
      try {
        const stravaId = parseInt(file.split('.')[0], 10);
        const content = readFileSync(join(resolvedDir, file), 'utf-8');
        const rawPoints = parseGPXPoints(content);

        if (rawPoints.length < 2) {
          skipped++;
          continue;
        }

        // Simplify to reduce encoded size (match Strava's summary_polyline density)
        const simplified = simplifyPoints(rawPoints, EPSILON);
        const polyline = encodePolyline(simplified);

        statements.push(
          `UPDATE strava_activities SET map_polyline = '${escapeSQL(polyline)}', updated_at = '${new Date().toISOString()}' WHERE strava_id = ${stravaId};`
        );
      } catch (error) {
        errors++;
        console.error(`[ERROR] Failed to process ${file}: ${error}`);
      }
    }

    if (statements.length > 0) {
      try {
        executeRemoteSQL(statements.join('\n'));
        updated += statements.length;
        console.log(
          `[INFO] Progress: ${updated}/${gpxFiles.length} updated (batch ${Math.floor(i / BATCH_SIZE) + 1})`
        );
      } catch (error) {
        console.error(`[ERROR] Batch update failed: ${error}`);
        // Fallback to individual updates
        for (const stmt of statements) {
          try {
            executeRemoteSQL(stmt);
            updated++;
          } catch (innerError) {
            errors++;
            console.error(`[ERROR] Individual update failed: ${innerError}`);
          }
        }
      }
    }
  }

  console.log(
    `[SUCCESS] Backfill complete: ${updated} updated, ${skipped} skipped (no GPS data), ${errors} errors`
  );

  // Verify
  const remaining = executeRemoteSQLJson(
    "SELECT COUNT(*) as cnt FROM strava_activities WHERE map_polyline IS NULL OR map_polyline = ''"
  ) as Array<{ cnt: number }>;
  const withPolyline = executeRemoteSQLJson(
    'SELECT COUNT(*) as cnt FROM strava_activities WHERE map_polyline IS NOT NULL AND length(map_polyline) > 0'
  ) as Array<{ cnt: number }>;
  console.log(
    `[INFO] Final state: ${withPolyline[0]?.cnt} with polylines, ${remaining[0]?.cnt} without`
  );
}

main().catch((error) => {
  console.error(`[FATAL] ${error}`);
  process.exit(1);
});
