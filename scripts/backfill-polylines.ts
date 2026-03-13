/**
 * Backfill Strava Polylines from Export Files
 *
 * Reads GPX, FIT.gz, and TCX.gz files from a Strava data export and
 * encodes the GPS tracks as Google-encoded polylines, then updates
 * the remote D1 database.
 *
 * Uses activities.csv to map Strava activity IDs to filenames (they
 * don't always match).
 *
 * Usage:
 *   npx tsx scripts/backfill-polylines.ts <path-to-strava-export>
 *
 * Example:
 *   npx tsx scripts/backfill-polylines.ts ~/Downloads/strava
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import FitParser from 'fit-file-parser';

const DB_NAME = 'rewind-db';

// --- Google Encoded Polyline Algorithm ---

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

// --- File Parsers ---

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

function parseTCXPoints(content: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  const latRegex =
    /<LatitudeDegrees>([^<]+)<\/LatitudeDegrees>\s*<LongitudeDegrees>([^<]+)<\/LongitudeDegrees>/g;
  let match;

  while ((match = latRegex.exec(content)) !== null) {
    const lat = parseFloat(match[1]);
    const lng = parseFloat(match[2]);
    if (!isNaN(lat) && !isNaN(lng)) {
      points.push([lat, lng]);
    }
  }

  return points;
}

function parseFITPoints(buffer: Buffer): Promise<Array<[number, number]>> {
  return new Promise((resolve, reject) => {
    const parser = new FitParser({
      force: true,
      speedUnit: 'km/h',
      lengthUnit: 'km',
    });
    parser.parse(
      buffer,
      (
        err: unknown,
        data: {
          records: Array<{
            position_lat?: number;
            position_long?: number;
          }>;
        }
      ) => {
        if (err) {
          reject(err);
          return;
        }
        const points: Array<[number, number]> = [];
        for (const r of data.records || []) {
          if (r.position_lat !== undefined && r.position_long !== undefined) {
            points.push([r.position_lat, r.position_long]);
          }
        }
        resolve(points);
      }
    );
  });
}

// --- Douglas-Peucker Simplification ---

function simplifyPoints(
  points: Array<[number, number]>,
  epsilon: number
): Array<[number, number]> {
  if (points.length <= 2) return points;

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

// --- CSV Parser ---

function parseCSVMapping(csvPath: string): Map<number, string> {
  const content = readFileSync(csvPath, 'utf-8');
  const map = new Map<number, string>();

  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '"') {
      current += char;
      inQuotes = !inQuotes;
    } else if (char === '\n' && !inQuotes) {
      if (current.trim()) lines.push(current);
      current = '';
    } else if (char === '\r' && !inQuotes) {
      // skip
    } else {
      current += char;
    }
  }
  if (current.trim()) lines.push(current);

  if (lines.length === 0) return map;

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
  const idIdx = headers.indexOf('Activity ID');
  const fileIdx = headers.indexOf('Filename');

  if (idIdx === -1 || fileIdx === -1) {
    throw new Error('CSV missing Activity ID or Filename columns');
  }

  for (let i = 1; i < lines.length; i++) {
    const values = parseRow(lines[i]);
    const id = parseInt(values[idIdx], 10);
    const filename = values[fileIdx]?.trim();
    if (id && filename) {
      map.set(id, filename);
    }
  }

  return map;
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

// --- Extract points from any supported file ---

async function extractPoints(
  filePath: string
): Promise<Array<[number, number]>> {
  if (filePath.endsWith('.gpx')) {
    const content = readFileSync(filePath, 'utf-8');
    return parseGPXPoints(content);
  }

  if (filePath.endsWith('.gpx.gz')) {
    const content = gunzipSync(readFileSync(filePath)).toString('utf-8');
    return parseGPXPoints(content);
  }

  if (filePath.endsWith('.tcx.gz')) {
    const content = gunzipSync(readFileSync(filePath)).toString('utf-8');
    return parseTCXPoints(content);
  }

  if (filePath.endsWith('.fit.gz')) {
    const buffer = gunzipSync(readFileSync(filePath));
    return parseFITPoints(buffer);
  }

  return [];
}

// --- Main ---

async function main() {
  const exportDir = process.argv[2];
  if (!exportDir) {
    console.error(
      '[ERROR] Usage: npx tsx scripts/backfill-polylines.ts <path-to-strava-export>'
    );
    process.exit(1);
  }

  const resolvedDir = resolve(exportDir);
  const csvPath = join(resolvedDir, 'activities.csv');
  const activitiesDir = join(resolvedDir, 'activities');

  if (!existsSync(csvPath)) {
    console.error(`[ERROR] activities.csv not found at ${csvPath}`);
    process.exit(1);
  }

  // Build CSV mapping: strava_id -> filename
  console.log('[INFO] Parsing activities.csv for file mapping...');
  const csvMap = parseCSVMapping(csvPath);
  console.log(`[INFO] ${csvMap.size} activities mapped in CSV`);

  // Get activity IDs missing polylines
  console.log('[INFO] Fetching activities missing polylines from remote DB...');
  const missing = executeRemoteSQLJson(
    "SELECT strava_id FROM strava_activities WHERE map_polyline IS NULL OR map_polyline = ''"
  ) as Array<{ strava_id: number }>;
  const missingIds = missing.map((r) => r.strava_id);
  console.log(`[INFO] ${missingIds.length} activities missing polylines`);

  // Match to files
  const toProcess: Array<{ stravaId: number; filePath: string }> = [];
  for (const id of missingIds) {
    const filename = csvMap.get(id);
    if (filename) {
      const filePath = join(resolvedDir, filename);
      if (existsSync(filePath)) {
        toProcess.push({ stravaId: id, filePath });
      }
    }
  }
  console.log(`[INFO] ${toProcess.length} activities have matching files`);

  if (toProcess.length === 0) {
    console.log('[INFO] Nothing to backfill');
    return;
  }

  // Process in batches
  const BATCH_SIZE = 25;
  const EPSILON = 0.00005;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE);
    const statements: string[] = [];

    for (const { stravaId, filePath } of batch) {
      try {
        const rawPoints = await extractPoints(filePath);

        if (rawPoints.length < 2) {
          skipped++;
          continue;
        }

        const simplified = simplifyPoints(rawPoints, EPSILON);
        const polyline = encodePolyline(simplified);

        statements.push(
          `UPDATE strava_activities SET map_polyline = '${escapeSQL(polyline)}', updated_at = '${new Date().toISOString()}' WHERE strava_id = ${stravaId};`
        );
      } catch (error) {
        errors++;
        console.error(`[ERROR] Failed to process ${filePath}: ${error}`);
      }
    }

    if (statements.length > 0) {
      try {
        executeRemoteSQL(statements.join('\n'));
        updated += statements.length;
        console.log(
          `[INFO] Progress: ${updated}/${toProcess.length} updated (batch ${Math.floor(i / BATCH_SIZE) + 1})`
        );
      } catch (error) {
        console.error(`[ERROR] Batch update failed: ${error}`);
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
