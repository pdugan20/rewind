/**
 * Add a movie to the Trakt physical media collection via CLI.
 *
 * Searches TMDb by title, pushes to Trakt with format metadata,
 * and stores locally via the admin API endpoint.
 *
 * Prerequisites:
 *   1. .dev.vars contains REWIND_ADMIN_KEY
 *   2. Worker is deployed (uses api.rewind.rest)
 *
 * Usage:
 *   npx tsx scripts/add-trakt-movie.ts "The Matrix" --format uhd_bluray
 *   npx tsx scripts/add-trakt-movie.ts "Jaws" --format bluray
 *   npx tsx scripts/add-trakt-movie.ts "King Kong" --format hddvd
 *   npx tsx scripts/add-trakt-movie.ts "Toy Story" --format dvd
 *
 * Options:
 *   --format    Media format: bluray, uhd_bluray, hddvd, dvd, digital (default: bluray)
 *   --year      Filter search results by year
 *   --dry-run   Search only, don't add
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as readline from 'node:readline';

const envPath = resolve(import.meta.dirname ?? '.', '../.dev.vars');
const envFile = readFileSync(envPath, 'utf-8');
const env: Record<string, string> = {};
for (const line of envFile.split('\n')) {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) env[key.trim()] = rest.join('=').trim();
}

const API_BASE = 'https://api.rewind.rest/v1';
const ADMIN_KEY = env.REWIND_ADMIN_KEY;

if (!ADMIN_KEY) {
  console.log('[ERROR] REWIND_ADMIN_KEY not found in .dev.vars');
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const formatIdx = args.indexOf('--format');
const yearIdx = args.indexOf('--year');

const format = formatIdx !== -1 ? args[formatIdx + 1] : 'bluray';
const yearFilter = yearIdx !== -1 ? parseInt(args[yearIdx + 1], 10) : undefined;

// Title is everything that's not a flag
const title = args
  .filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (i > 0 && args[i - 1] === '--format') return false;
    if (i > 0 && args[i - 1] === '--year') return false;
    return true;
  })
  .join(' ');

if (!title) {
  console.log(
    'Usage: npx tsx scripts/add-trakt-movie.ts "Movie Title" --format bluray'
  );
  console.log('Formats: bluray, uhd_bluray, hddvd, dvd, digital');
  process.exit(1);
}

const VALID_FORMATS = ['bluray', 'uhd_bluray', 'hddvd', 'dvd', 'digital'];
if (!VALID_FORMATS.includes(format)) {
  console.log(
    `[ERROR] Invalid format "${format}". Must be one of: ${VALID_FORMATS.join(', ')}`
  );
  process.exit(1);
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function searchTmdb(
  query: string
): Promise<
  Array<{ id: number; title: string; year: number; overview: string }>
> {
  const params = new URLSearchParams({ query });
  if (yearFilter) params.set('year', String(yearFilter));

  // Use the Trakt search endpoint via our admin API isn't available for TMDb search,
  // so we'll use the TMDb API key directly
  const tmdbKey = env.TMDB_API_KEY;
  if (!tmdbKey) {
    console.log('[ERROR] TMDB_API_KEY not found in .dev.vars');
    process.exit(1);
  }

  const resp = await fetch(
    `https://api.themoviedb.org/3/search/movie?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${tmdbKey}`,
        Accept: 'application/json',
      },
    }
  );

  if (!resp.ok) {
    throw new Error(`TMDb search failed: ${resp.status}`);
  }

  const data = (await resp.json()) as {
    results: Array<{
      id: number;
      title: string;
      release_date: string;
      overview: string;
    }>;
  };

  return data.results.slice(0, 5).map((r) => ({
    id: r.id,
    title: r.title,
    year: r.release_date ? parseInt(r.release_date.substring(0, 4), 10) : 0,
    overview: r.overview?.substring(0, 80) || '',
  }));
}

async function addMovie(tmdbId: number): Promise<void> {
  const resp = await fetch(`${API_BASE}/admin/collecting/media`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_KEY}`,
    },
    body: JSON.stringify({
      tmdb_id: tmdbId,
      media_type: format,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API error: ${resp.status} - ${text}`);
  }

  const result = await resp.json();
  console.log('[SUCCESS] Added:', JSON.stringify(result, null, 2));
}

async function main() {
  console.log(
    `[INFO] Searching for "${title}"${yearFilter ? ` (${yearFilter})` : ''}...`
  );

  const results = await searchTmdb(title);
  if (results.length === 0) {
    console.log('[INFO] No results found');
    process.exit(0);
  }

  console.log('\nResults:');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(`  ${i + 1}. ${r.title} (${r.year}) [tmdb:${r.id}]`);
    if (r.overview) console.log(`     ${r.overview}...`);
  }

  if (DRY_RUN) {
    console.log('\n[INFO] Dry run, not adding');
    process.exit(0);
  }

  const choice = await prompt(
    `\nSelect (1-${results.length}) or 'q' to quit: `
  );
  if (choice === 'q' || choice === '') {
    console.log('[INFO] Cancelled');
    process.exit(0);
  }

  const idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= results.length) {
    console.log('[ERROR] Invalid selection');
    process.exit(1);
  }

  const selected = results[idx];
  console.log(
    `\n[INFO] Adding "${selected.title}" (${selected.year}) as ${format}...`
  );
  await addMovie(selected.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
