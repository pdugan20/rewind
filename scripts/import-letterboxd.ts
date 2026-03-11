/**
 * Letterboxd CSV Import Script
 *
 * One-time script to import full Letterboxd diary history from a CSV export
 * into the remote D1 database. Enriches each movie from TMDB.
 *
 * Prerequisites:
 *   1. Export your Letterboxd data at https://letterboxd.com/settings/data/
 *   2. Extract the zip -- you need the `diary.csv` file.
 *   3. Set TMDB_API_KEY env var.
 *   4. Ensure wrangler is authenticated (`npx wrangler login`).
 *
 * Usage:
 *   TMDB_API_KEY=xxx npx tsx scripts/import-letterboxd.ts path/to/diary.csv
 *
 * Resume from checkpoint:
 *   TMDB_API_KEY=xxx npx tsx scripts/import-letterboxd.ts path/to/diary.csv --resume
 *
 * Diary CSV columns: Date, Name, Year, Letterboxd URI, Rating, Rewatch, Tags, Watched Date
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DB_NAME = 'rewind-db';
const CHECKPOINT_FILE = resolve(
  import.meta.dirname ?? '.',
  '.letterboxd-checkpoint.json'
);
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_RATE_LIMIT_MS = 250; // ~4 req/sec to stay under TMDB's 40 req/10sec

// --- Types ---

interface DiaryEntry {
  date: string;
  name: string;
  year: number | null;
  letterboxdUri: string;
  rating: number | null;
  rewatch: boolean;
  watchedDate: string;
}

interface TmdbMovieDetail {
  id: number;
  title: string;
  year: number | null;
  imdb_id: string | null;
  tagline: string | null;
  overview: string | null;
  content_rating: string | null;
  runtime: number | null;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number | null;
  genres: Array<{ id: number; name: string }>;
  directors: Array<{ id: number; name: string }>;
}

interface Checkpoint {
  processedIndices: number[];
}

// --- Env ---

const tmdbApiKey = process.env.TMDB_API_KEY;
if (!tmdbApiKey) {
  console.error('[ERROR] TMDB_API_KEY env var is required');
  process.exit(1);
}

const csvPath = process.argv.find((a) => a.endsWith('.csv'));
if (!csvPath) {
  console.error('[ERROR] Provide path to diary.csv as argument');
  process.exit(1);
}

// --- CSV parsing ---

function parseDiaryCsv(filePath: string): DiaryEntry[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  // Skip header
  const entries: DiaryEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 8) continue;

    const [
      date,
      name,
      yearStr,
      letterboxdUri,
      ratingStr,
      rewatchStr,
      ,
      watchedDate,
    ] = fields;

    if (!name || !watchedDate) continue;

    entries.push({
      date: date.trim(),
      name: name.trim(),
      year: yearStr ? parseInt(yearStr, 10) : null,
      letterboxdUri: letterboxdUri.trim(),
      rating: ratingStr ? parseFloat(ratingStr) : null,
      rewatch: rewatchStr?.toLowerCase() === 'yes',
      watchedDate: watchedDate.trim(),
    });
  }

  return entries;
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

// --- TMDB API ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tmdbRequest<T>(
  path: string,
  params?: URLSearchParams
): Promise<T> {
  const url = new URL(`${TMDB_BASE_URL}${path}`);
  if (params) {
    params.forEach((value, key) => url.searchParams.set(key, value));
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${tmdbApiKey}`,
      Accept: 'application/json',
    },
  });

  if (response.status === 429) {
    console.log('[RATE] TMDB rate limited. Waiting 10 seconds...');
    await sleep(10_000);
    return tmdbRequest<T>(path, params);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`TMDB ${path} failed (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<T>;
}

async function searchMovie(
  title: string,
  year?: number
): Promise<Array<{ id: number; title: string; release_date: string }>> {
  const params = new URLSearchParams({ query: title });
  if (year) params.set('year', String(year));

  const data = await tmdbRequest<{
    results: Array<{ id: number; title: string; release_date: string }>;
  }>('/search/movie', params);

  await sleep(TMDB_RATE_LIMIT_MS);
  return data.results;
}

async function getMovieDetail(tmdbId: number): Promise<TmdbMovieDetail> {
  const params = new URLSearchParams({
    append_to_response: 'credits,release_dates',
  });
  const data = await tmdbRequest<{
    id: number;
    title: string;
    release_date: string;
    imdb_id: string | null;
    tagline: string | null;
    overview: string | null;
    runtime: number | null;
    poster_path: string | null;
    backdrop_path: string | null;
    vote_average: number | null;
    genres: Array<{ id: number; name: string }>;
    credits?: { crew?: Array<{ job: string; id: number; name: string }> };
    release_dates?: {
      results?: Array<{
        iso_3166_1: string;
        release_dates: Array<{ certification: string }>;
      }>;
    };
  }>(`/movie/${tmdbId}`, params);

  // Extract US content rating
  let contentRating: string | null = null;
  const usRelease = data.release_dates?.results?.find(
    (r) => r.iso_3166_1 === 'US'
  );
  if (usRelease?.release_dates?.length) {
    const cert = usRelease.release_dates.find(
      (rd) => rd.certification
    )?.certification;
    if (cert) contentRating = cert;
  }

  // Extract directors
  const directors = (data.credits?.crew ?? [])
    .filter((c) => c.job === 'Director')
    .map((c) => ({ id: c.id, name: c.name }));

  await sleep(TMDB_RATE_LIMIT_MS);

  return {
    id: data.id,
    title: data.title,
    year: data.release_date
      ? parseInt(data.release_date.substring(0, 4), 10)
      : null,
    imdb_id: data.imdb_id,
    tagline: data.tagline || null,
    overview: data.overview || null,
    content_rating: contentRating,
    runtime: data.runtime,
    poster_path: data.poster_path,
    backdrop_path: data.backdrop_path,
    vote_average: data.vote_average,
    genres: data.genres,
    directors,
  };
}

// --- D1 SQL execution ---

function escapeSQL(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

function executeRemoteSQL(sql: string): string {
  const tmpFile = resolve(import.meta.dirname ?? '.', '.tmp-sql.sql');
  writeFileSync(tmpFile, sql);
  try {
    const result = execSync(
      `npx wrangler d1 execute ${DB_NAME} --remote --file="${tmpFile}"`,
      { stdio: 'pipe', timeout: 30_000 }
    ).toString();
    return result;
  } finally {
    try {
      execSync(`rm "${tmpFile}"`, { stdio: 'pipe' });
    } catch {
      // ignore
    }
  }
}

function executeRemoteSQLJson(sql: string): string {
  const tmpFile = resolve(import.meta.dirname ?? '.', '.tmp-sql.sql');
  writeFileSync(tmpFile, sql);
  try {
    const result = execSync(
      `npx wrangler d1 execute ${DB_NAME} --remote --file="${tmpFile}" --json`,
      { stdio: 'pipe', timeout: 30_000 }
    ).toString();
    return result;
  } finally {
    try {
      execSync(`rm "${tmpFile}"`, { stdio: 'pipe' });
    } catch {
      // ignore
    }
  }
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

// --- Movie upsert ---

async function findOrCreateMovie(
  title: string,
  year: number | null
): Promise<number | null> {
  // First check if movie already exists by searching in D1
  const searchSQL = year
    ? `SELECT id, tmdb_id FROM movies WHERE title = ${escapeSQL(title)} AND year = ${year} LIMIT 1;`
    : `SELECT id, tmdb_id FROM movies WHERE title = ${escapeSQL(title)} LIMIT 1;`;

  try {
    const result = executeRemoteSQLJson(searchSQL);
    const parsed = JSON.parse(result) as Array<{
      results: Array<{ id: number; tmdb_id: number | null }>;
    }>;
    if (parsed[0]?.results?.length > 0) {
      return parsed[0].results[0].id;
    }
  } catch {
    // continue to TMDB search
  }

  // Search TMDB
  const results = await searchMovie(title, year ?? undefined);
  if (results.length === 0) {
    console.log(`[INFO] No TMDB match for "${title}" (${year})`);
    return null;
  }

  const tmdbId = results[0].id;

  // Check if movie exists by TMDB ID
  try {
    const tmdbCheckSQL = `SELECT id FROM movies WHERE tmdb_id = ${tmdbId} LIMIT 1;`;
    const result = executeRemoteSQLJson(tmdbCheckSQL);
    const parsed = JSON.parse(result) as Array<{
      results: Array<{ id: number }>;
    }>;
    if (parsed[0]?.results?.length > 0) {
      return parsed[0].results[0].id;
    }
  } catch {
    // continue
  }

  // Fetch full TMDB details
  const detail = await getMovieDetail(tmdbId);

  // Insert movie
  const now = new Date().toISOString();
  const insertSQL = `INSERT INTO movies (user_id, title, year, tmdb_id, imdb_id, tagline, summary, content_rating, runtime, poster_path, backdrop_path, tmdb_rating, created_at) VALUES (1, ${escapeSQL(detail.title)}, ${detail.year ?? 'NULL'}, ${detail.id}, ${escapeSQL(detail.imdb_id)}, ${escapeSQL(detail.tagline)}, ${escapeSQL(detail.overview)}, ${escapeSQL(detail.content_rating)}, ${detail.runtime ?? 'NULL'}, ${escapeSQL(detail.poster_path)}, ${escapeSQL(detail.backdrop_path)}, ${detail.vote_average ?? 'NULL'}, ${escapeSQL(now)});`;

  executeRemoteSQL(insertSQL);

  // Get the inserted movie ID
  const idResult = executeRemoteSQLJson(
    `SELECT id FROM movies WHERE tmdb_id = ${detail.id} LIMIT 1;`
  );
  const idParsed = JSON.parse(idResult) as Array<{
    results: Array<{ id: number }>;
  }>;
  const movieId = idParsed[0]?.results?.[0]?.id;

  if (!movieId) {
    console.log(
      `[ERROR] Failed to retrieve movie ID after insert for "${title}"`
    );
    return null;
  }

  // Insert genres
  for (const genre of detail.genres) {
    try {
      executeRemoteSQL(
        `INSERT OR IGNORE INTO genres (name) VALUES (${escapeSQL(genre.name)});`
      );
      executeRemoteSQL(
        `INSERT OR IGNORE INTO movie_genres (movie_id, genre_id) VALUES (${movieId}, (SELECT id FROM genres WHERE name = ${escapeSQL(genre.name)}));`
      );
    } catch {
      // ignore genre insert errors
    }
  }

  // Insert directors
  for (const director of detail.directors) {
    try {
      executeRemoteSQL(
        `INSERT OR IGNORE INTO directors (name) VALUES (${escapeSQL(director.name)});`
      );
      executeRemoteSQL(
        `INSERT OR IGNORE INTO movie_directors (movie_id, director_id) VALUES (${movieId}, (SELECT id FROM directors WHERE name = ${escapeSQL(director.name)}));`
      );
    } catch {
      // ignore director insert errors
    }
  }

  return movieId;
}

// --- Main ---

async function main() {
  const isResume = process.argv.includes('--resume');
  let checkpoint: Checkpoint | null = isResume ? loadCheckpoint() : null;

  console.log(`[INFO] Letterboxd CSV import starting: ${csvPath}`);

  const entries = parseDiaryCsv(csvPath!);
  console.log(`[INFO] Parsed ${entries.length} diary entries`);

  if (checkpoint) {
    console.log(
      `[INFO] Resuming: ${checkpoint.processedIndices.length} entries already processed`
    );
  }

  const processedSet = new Set(checkpoint?.processedIndices ?? []);
  let synced = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < entries.length; i++) {
    if (processedSet.has(i)) continue;

    const entry = entries[i];

    try {
      const movieId = await findOrCreateMovie(entry.name, entry.year);

      if (!movieId) {
        skipped++;
        processedSet.add(i);
        continue;
      }

      // Check for duplicate watch (same movie + same date)
      const watchedAt = `${entry.watchedDate}T12:00:00.000Z`;
      const dateStr = entry.watchedDate;

      try {
        const dupCheck = executeRemoteSQLJson(
          `SELECT id FROM watch_history WHERE movie_id = ${movieId} AND substr(watched_at, 1, 10) = ${escapeSQL(dateStr)} LIMIT 1;`
        );
        const dupParsed = JSON.parse(dupCheck) as Array<{
          results: Array<{ id: number }>;
        }>;
        if (dupParsed[0]?.results?.length > 0) {
          skipped++;
          processedSet.add(i);
          continue;
        }
      } catch {
        // continue with insert
      }

      // Insert watch history
      const now = new Date().toISOString();
      const watchSQL = `INSERT INTO watch_history (user_id, movie_id, watched_at, source, user_rating, rewatch, created_at) VALUES (1, ${movieId}, ${escapeSQL(watchedAt)}, 'letterboxd', ${entry.rating ?? 'NULL'}, ${entry.rewatch ? 1 : 0}, ${escapeSQL(now)});`;

      executeRemoteSQL(watchSQL);
      synced++;
      processedSet.add(i);
    } catch (error) {
      console.error(
        `[ERROR] Failed to process "${entry.name}" (${entry.year}): ${error}`
      );
      errors++;
      processedSet.add(i);
    }

    // Save checkpoint every 10 entries
    if ((synced + skipped + errors) % 10 === 0) {
      checkpoint = { processedIndices: [...processedSet] };
      saveCheckpoint(checkpoint);
      console.log(
        `[INFO] Progress: ${synced + skipped + errors}/${entries.length} (synced: ${synced}, skipped: ${skipped}, errors: ${errors})`
      );
    }
  }

  // Save final checkpoint
  checkpoint = { processedIndices: [...processedSet] };
  saveCheckpoint(checkpoint);

  console.log('[SUCCESS] Letterboxd CSV import completed');
  console.log(
    `[INFO] Synced: ${synced}, Skipped: ${skipped}, Errors: ${errors}`
  );
}

main().catch((error) => {
  console.error(`[FATAL] ${error}`);
  process.exit(1);
});
