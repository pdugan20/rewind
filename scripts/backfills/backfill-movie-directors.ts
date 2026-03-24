/**
 * Backfill missing directors and genres for movies with TMDB IDs.
 * Finds movies missing director data and fetches from TMDB API.
 *
 * Usage: npx tsx scripts/backfills/backfill-movie-directors.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CF_ACCOUNT_ID = '46bcea726724fbab7d60f236f151f3d3';
const CF_DATABASE_ID = '35a4edf8-0d4f-4cbe-9a6e-6f1525716774';
const D1_API_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_DATABASE_ID}/query`;

function loadEnv(): Record<string, string> {
  const envFile = resolve(import.meta.dirname ?? '.', '../../.dev.vars');
  const content = readFileSync(envFile, 'utf-8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^([^=]+)=(.+)$/);
    if (match) env[match[1].trim()] = match[2].trim();
  }
  return env;
}

function getCfApiToken(): string {
  const macPath = resolve(
    process.env.HOME || '~',
    'Library/Preferences/.wrangler/config/default.toml'
  );
  const linuxPath = resolve(
    process.env.XDG_CONFIG_HOME || resolve(process.env.HOME || '~', '.config'),
    'wrangler/config/default.toml'
  );
  const tokenFile = existsSync(macPath) ? macPath : linuxPath;
  if (existsSync(tokenFile)) {
    const content = readFileSync(tokenFile, 'utf-8');
    const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }
  throw new Error('No Cloudflare API token found.');
}

async function d1Query(
  sql: string,
  params: unknown[] = []
): Promise<unknown[]> {
  const token = getCfApiToken();
  const response = await fetch(D1_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`D1: ${response.status} ${text.slice(0, 200)}`);
  }
  const data = (await response.json()) as {
    result: { results: unknown[] }[];
  };
  return data.result?.[0]?.results ?? [];
}

const ENV = loadEnv();

async function fetchTmdbDetail(tmdbId: number) {
  const url = `https://api.themoviedb.org/3/movie/${tmdbId}?append_to_response=credits,release_dates`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${ENV.TMDB_API_KEY}` },
  });
  if (!response.ok) throw new Error(`TMDB ${response.status}`);
  return response.json() as Promise<{
    genres: { id: number; name: string }[];
    vote_average: number;
    release_dates?: {
      results: {
        iso_3166_1: string;
        release_dates: { certification: string }[];
      }[];
    };
    credits?: { crew: { job: string; name: string }[] };
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const movies = (await d1Query(`
    SELECT m.id, m.tmdb_id, m.title, m.content_rating, m.tmdb_rating
    FROM movies m
    WHERE m.tmdb_id IS NOT NULL
    AND (
      m.id NOT IN (SELECT DISTINCT movie_id FROM movie_directors)
      OR m.id NOT IN (SELECT DISTINCT movie_id FROM movie_genres)
      OR m.content_rating IS NULL
    )
    ORDER BY m.id
  `)) as {
    id: number;
    tmdb_id: number;
    title: string;
    content_rating: string | null;
    tmdb_rating: number | null;
  }[];

  console.log(`[INFO] ${movies.length} movies need backfill`);

  let fixed = 0;
  for (const movie of movies) {
    await sleep(300);
    try {
      const detail = await fetchTmdbDetail(movie.tmdb_id);

      // Directors
      const directors =
        detail.credits?.crew
          .filter((c) => c.job === 'Director')
          .map((c) => c.name) ?? [];

      for (const name of directors) {
        // Upsert director
        await d1Query(
          `INSERT INTO directors (name) VALUES (?) ON CONFLICT(name) DO NOTHING`,
          [name]
        );
        const [dir] = (await d1Query(
          `SELECT id FROM directors WHERE name = ?`,
          [name]
        )) as { id: number }[];
        if (dir) {
          await d1Query(
            `INSERT INTO movie_directors (movie_id, director_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
            [movie.id, dir.id]
          );
        }
      }

      // Genres (insert by name, look up auto-generated ID)
      const [genreCount] = (await d1Query(
        `SELECT COUNT(*) as c FROM movie_genres WHERE movie_id = ?`,
        [movie.id]
      )) as { c: number }[];
      if (genreCount.c === 0 && detail.genres.length > 0) {
        for (const genre of detail.genres) {
          await d1Query(
            `INSERT INTO genres (name) VALUES (?) ON CONFLICT DO NOTHING`,
            [genre.name]
          );
          const [genreRow] = (await d1Query(
            `SELECT id FROM genres WHERE name = ?`,
            [genre.name]
          )) as { id: number }[];
          if (genreRow) {
            await d1Query(
              `INSERT INTO movie_genres (movie_id, genre_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
              [movie.id, genreRow.id]
            );
          }
        }
      }

      // Content rating
      if (!movie.content_rating) {
        const usRelease = detail.release_dates?.results?.find(
          (r) => r.iso_3166_1 === 'US'
        );
        const cert = usRelease?.release_dates?.find(
          (rd) => rd.certification
        )?.certification;
        if (cert) {
          await d1Query(`UPDATE movies SET content_rating = ? WHERE id = ?`, [
            cert,
            movie.id,
          ]);
        }
      }

      // TMDB rating
      if (!movie.tmdb_rating && detail.vote_average) {
        await d1Query(`UPDATE movies SET tmdb_rating = ? WHERE id = ?`, [
          detail.vote_average,
          movie.id,
        ]);
      }

      fixed++;
      console.log(
        `[INFO] ${fixed}/${movies.length} Fixed: ${movie.title} (${directors.join(', ') || 'no directors on TMDB'})`
      );
    } catch (err) {
      console.log(
        `[ERROR] Failed: ${movie.title} - ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  console.log(`\n[INFO] Done: ${fixed}/${movies.length} movies backfilled`);
}

main().catch((err) => {
  console.error(`[ERROR] ${err.message}`);
  process.exit(1);
});
