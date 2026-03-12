import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { movies } from '../../db/schema/watching.js';
import { TmdbClient } from './tmdb.js';
import { upsertGenres, upsertDirectors } from '../plex/webhook.js';

export interface ResolveMovieParams {
  /** TMDB ID -- most reliable identifier, always preferred */
  tmdbId?: number;
  /** Plex rating key -- Plex-specific, used for lookup only */
  plexRatingKey?: string;
  /** Movie title -- used for TMDB search fallback */
  title: string;
  /** Release year -- improves TMDB search accuracy */
  year?: number | null;
}

interface ResolvedMovie {
  id: number;
  created: boolean;
}

/**
 * Single entry point for finding or creating a movie.
 *
 * Resolution order:
 * 1. If tmdbId provided, look up by tmdb_id
 * 2. If plexRatingKey provided, look up by plex_rating_key
 * 3. Search TMDB by title+year, then look up by resolved tmdb_id
 * 4. Insert new movie with full TMDB enrichment
 *
 * Cross-populates missing fields (e.g., back-fills tmdbId on a Plex-only row,
 * or plexRatingKey on a Letterboxd-only row).
 */
export async function resolveMovie(
  db: Database,
  tmdbClient: TmdbClient,
  params: ResolveMovieParams
): Promise<ResolvedMovie | null> {
  // Step 1: Look up by tmdbId if provided
  if (params.tmdbId) {
    const existing = await findByTmdbId(db, params.tmdbId);
    if (existing) {
      // Back-fill plexRatingKey if we have one and the row doesn't
      if (params.plexRatingKey) {
        await backfillPlexRatingKey(db, existing.id, params.plexRatingKey);
      }
      return { id: existing.id, created: false };
    }
  }

  // Step 2: Look up by plexRatingKey if provided
  if (params.plexRatingKey) {
    const existing = await findByPlexRatingKey(db, params.plexRatingKey);
    if (existing) {
      // Back-fill tmdbId if the row doesn't have one
      if (!existing.tmdbId) {
        const resolvedTmdbId =
          params.tmdbId ?? (await searchTmdbId(tmdbClient, params));
        if (resolvedTmdbId) {
          await backfillTmdbId(db, existing.id, resolvedTmdbId);
        }
      }
      return { id: existing.id, created: false };
    }
  }

  // Step 3: Resolve tmdbId via search if we don't already have one
  let tmdbId = params.tmdbId ?? null;
  if (!tmdbId) {
    tmdbId = await searchTmdbId(tmdbClient, params);
  }

  // If we resolved a tmdbId via search, check DB again (another source may
  // have already inserted this movie with a different lookup path)
  if (tmdbId && !params.tmdbId) {
    const existing = await findByTmdbId(db, tmdbId);
    if (existing) {
      if (params.plexRatingKey) {
        await backfillPlexRatingKey(db, existing.id, params.plexRatingKey);
      }
      return { id: existing.id, created: false };
    }
  }

  // Step 4: Create new movie with TMDB enrichment
  if (!tmdbId) {
    console.log(
      `[INFO] Could not resolve TMDB ID for "${params.title}" (${params.year})`
    );
    return null;
  }

  const movieId = await createMovieFromTmdb(db, tmdbClient, tmdbId, params);

  return { id: movieId, created: true };
}

// ─── Internal helpers ─────────────────────────────────────────────────

async function findByTmdbId(
  db: Database,
  tmdbId: number
): Promise<{
  id: number;
  tmdbId: number | null;
  plexRatingKey: string | null;
} | null> {
  const [row] = await db
    .select({
      id: movies.id,
      tmdbId: movies.tmdbId,
      plexRatingKey: movies.plexRatingKey,
    })
    .from(movies)
    .where(eq(movies.tmdbId, tmdbId))
    .limit(1);
  return row ?? null;
}

async function findByPlexRatingKey(
  db: Database,
  plexRatingKey: string
): Promise<{
  id: number;
  tmdbId: number | null;
  plexRatingKey: string | null;
} | null> {
  const [row] = await db
    .select({
      id: movies.id,
      tmdbId: movies.tmdbId,
      plexRatingKey: movies.plexRatingKey,
    })
    .from(movies)
    .where(eq(movies.plexRatingKey, plexRatingKey))
    .limit(1);
  return row ?? null;
}

async function searchTmdbId(
  tmdbClient: TmdbClient,
  params: ResolveMovieParams
): Promise<number | null> {
  try {
    const results = await tmdbClient.searchMovie(
      params.title,
      params.year ?? undefined
    );
    return results.length > 0 ? results[0].id : null;
  } catch (error) {
    console.log(
      `[ERROR] TMDB search failed for "${params.title}" (${params.year}): ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

async function backfillPlexRatingKey(
  db: Database,
  movieId: number,
  plexRatingKey: string
): Promise<void> {
  // Only update if the row doesn't already have a plexRatingKey
  const [row] = await db
    .select({ plexRatingKey: movies.plexRatingKey })
    .from(movies)
    .where(eq(movies.id, movieId))
    .limit(1);

  if (row && !row.plexRatingKey) {
    await db
      .update(movies)
      .set({ plexRatingKey })
      .where(eq(movies.id, movieId));
  }
}

async function backfillTmdbId(
  db: Database,
  movieId: number,
  tmdbId: number
): Promise<void> {
  await db.update(movies).set({ tmdbId }).where(eq(movies.id, movieId));
}

async function createMovieFromTmdb(
  db: Database,
  tmdbClient: TmdbClient,
  tmdbId: number,
  params: ResolveMovieParams
): Promise<number> {
  let title = params.title;
  let year = params.year ?? null;
  let imdbId: string | null = null;
  let tagline: string | null = null;
  let summary: string | null = null;
  let runtime: number | null = null;
  let tmdbRating: number | null = null;
  let posterPath: string | null = null;
  let backdropPath: string | null = null;
  let contentRating: string | null = null;
  let tmdbGenres: { id: number; name: string }[] = [];
  let tmdbDirectors: string[] = [];

  try {
    const detail = await tmdbClient.getMovieDetail(tmdbId);
    title = detail.title;
    year = detail.year;
    imdbId = detail.imdb_id;
    tagline = detail.tagline;
    summary = detail.overview;
    runtime = detail.runtime;
    tmdbRating = detail.vote_average;
    posterPath = detail.poster_path;
    backdropPath = detail.backdrop_path;
    contentRating = detail.content_rating;
    tmdbGenres = detail.genres;
    tmdbDirectors = detail.directors;
  } catch (error) {
    console.log(
      `[ERROR] TMDB enrichment failed for ${tmdbId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const [inserted] = await db
    .insert(movies)
    .values({
      plexRatingKey: params.plexRatingKey ?? null,
      title,
      year,
      tmdbId,
      imdbId,
      tagline,
      summary,
      contentRating,
      runtime,
      posterPath,
      backdropPath,
      tmdbRating,
    })
    .returning({ id: movies.id });

  const movieId = inserted.id;

  if (tmdbGenres.length > 0) {
    await upsertGenres(db, movieId, tmdbGenres);
  }
  if (tmdbDirectors.length > 0) {
    await upsertDirectors(db, movieId, tmdbDirectors);
  }

  console.log(`[INFO] Created movie: ${title} (${year}) [tmdb:${tmdbId}]`);
  return movieId;
}
