import { eq, and, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  movies,
  genres,
  movieGenres,
  directors,
  movieDirectors,
  watchHistory,
  plexShows,
  plexEpisodesWatched,
} from '../../db/schema/watching.js';
import { webhookEvents } from '../../db/schema/system.js';
import {
  TmdbClient,
  extractTmdbIdFromGuids,
  extractImdbIdFromGuids,
  resolveTmdbId,
} from '../watching/tmdb.js';

export interface PlexWebhookPayload {
  event: string;
  user: boolean;
  owner: boolean;
  Account: {
    id: number;
    title: string;
  };
  Server: {
    title: string;
    uuid: string;
  };
  Player: {
    local: boolean;
    publicAddress: string;
    title: string;
    uuid: string;
  };
  Metadata: {
    librarySectionType: string;
    ratingKey: string;
    type: string;
    title: string;
    year?: number;
    summary?: string;
    rating?: number;
    audienceRating?: number;
    contentRating?: string;
    duration?: number;
    studio?: string;
    thumb?: string;
    art?: string;
    grandparentTitle?: string;
    grandparentRatingKey?: string;
    parentIndex?: number;
    index?: number;
    Guid?: { id: string }[];
    Genre?: { tag: string }[];
    Director?: { tag: string }[];
  };
}

/**
 * Parse a Plex webhook multipart/form-data body.
 * Plex sends the payload as a "payload" field in multipart form data.
 */
export async function parsePlexWebhook(
  request: Request
): Promise<PlexWebhookPayload | null> {
  try {
    const formData = await request.formData();
    const payloadField = formData.get('payload');

    if (!payloadField || typeof payloadField !== 'string') {
      console.log('[ERROR] Plex webhook: no payload field found');
      return null;
    }

    return JSON.parse(payloadField) as PlexWebhookPayload;
  } catch (error) {
    console.log(
      `[ERROR] Plex webhook parse error: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Verify webhook source using shared secret.
 */
export function verifyPlexWebhook(
  payload: PlexWebhookPayload,
  secret: string
): boolean {
  // Verify using the server UUID as a simple shared-secret check
  if (!secret) return true;
  return payload.Server?.uuid === secret;
}

/**
 * Check if a webhook event has already been processed (idempotency).
 */
async function isEventProcessed(
  db: Database,
  eventId: string
): Promise<boolean> {
  const existing = await db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.eventSource, 'plex'),
        eq(webhookEvents.eventId, eventId)
      )
    )
    .limit(1);

  return existing.length > 0;
}

/**
 * Record a webhook event as processed.
 */
async function recordWebhookEvent(
  db: Database,
  eventId: string,
  eventType: string
): Promise<void> {
  await db.insert(webhookEvents).values({
    eventSource: 'plex',
    eventId,
    eventType,
  });
}

/**
 * Upsert a movie with TMDB enrichment, returning the movie ID.
 */
export async function upsertMovieFromPlex(
  db: Database,
  metadata: PlexWebhookPayload['Metadata'],
  tmdbClient: TmdbClient
): Promise<number> {
  // Check if movie already exists by plex_rating_key
  const existing = await db
    .select({ id: movies.id })
    .from(movies)
    .where(eq(movies.plexRatingKey, metadata.ratingKey))
    .limit(1);

  if (existing.length > 0) {
    return existing[0].id;
  }

  // Try to resolve TMDB ID
  let tmdbId: number | null = null;
  if (metadata.Guid) {
    tmdbId = await resolveTmdbId(metadata.Guid, tmdbClient);
  }

  // Check if movie exists by TMDB ID
  if (tmdbId) {
    const existingByTmdb = await db
      .select({ id: movies.id })
      .from(movies)
      .where(eq(movies.tmdbId, tmdbId))
      .limit(1);

    if (existingByTmdb.length > 0) {
      // Update plex_rating_key on existing movie
      await db
        .update(movies)
        .set({ plexRatingKey: metadata.ratingKey })
        .where(eq(movies.id, existingByTmdb[0].id));
      return existingByTmdb[0].id;
    }
  }

  // Enrich from TMDB if we have an ID
  let imdbId: string | null = null;
  let tagline: string | null = null;
  let summary: string | null = metadata.summary || null;
  let runtime: number | null = metadata.duration
    ? Math.round(metadata.duration / 60000)
    : null;
  let tmdbRating: number | null = null;
  let posterPath: string | null = null;
  let backdropPath: string | null = null;
  let contentRating: string | null = metadata.contentRating || null;
  let tmdbGenres: { id: number; name: string }[] = [];
  let tmdbDirectors: string[] = [];

  if (tmdbId) {
    try {
      const detail = await tmdbClient.getMovieDetail(tmdbId);
      imdbId = detail.imdb_id;
      tagline = detail.tagline;
      summary = detail.overview || summary;
      runtime = detail.runtime || runtime;
      tmdbRating = detail.vote_average;
      posterPath = detail.poster_path;
      backdropPath = detail.backdrop_path;
      contentRating = detail.content_rating || contentRating;
      tmdbGenres = detail.genres;
      tmdbDirectors = detail.directors;
    } catch (error) {
      console.log(
        `[ERROR] TMDB enrichment failed for ${tmdbId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    // Extract IMDB ID from guids even without full TMDB enrichment
    if (metadata.Guid) {
      imdbId = extractImdbIdFromGuids(metadata.Guid);
    }
  }

  // Use Plex genre/director data as fallback
  if (tmdbGenres.length === 0 && metadata.Genre) {
    tmdbGenres = metadata.Genre.map((g, i) => ({ id: -(i + 1), name: g.tag }));
  }
  if (tmdbDirectors.length === 0 && metadata.Director) {
    tmdbDirectors = metadata.Director.map((d) => d.tag);
  }

  // Insert movie
  const [inserted] = await db
    .insert(movies)
    .values({
      plexRatingKey: metadata.ratingKey,
      title: metadata.title,
      year: metadata.year || null,
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

  // Upsert genres and join table
  await upsertGenres(db, movieId, tmdbGenres);

  // Upsert directors and join table
  await upsertDirectors(db, movieId, tmdbDirectors);

  return movieId;
}

/**
 * Upsert genres for a movie.
 */
export async function upsertGenres(
  db: Database,
  movieId: number,
  genreList: { id: number; name: string }[]
): Promise<void> {
  for (const genre of genreList) {
    // Upsert genre
    await db.insert(genres).values({ name: genre.name }).onConflictDoNothing();

    const [genreRow] = await db
      .select({ id: genres.id })
      .from(genres)
      .where(eq(genres.name, genre.name))
      .limit(1);

    if (genreRow) {
      await db
        .insert(movieGenres)
        .values({ movieId, genreId: genreRow.id })
        .onConflictDoNothing();
    }
  }
}

/**
 * Upsert directors for a movie.
 */
export async function upsertDirectors(
  db: Database,
  movieId: number,
  directorNames: string[]
): Promise<void> {
  for (const name of directorNames) {
    // Upsert director
    await db.insert(directors).values({ name }).onConflictDoNothing();

    const [directorRow] = await db
      .select({ id: directors.id })
      .from(directors)
      .where(eq(directors.name, name))
      .limit(1);

    if (directorRow) {
      await db
        .insert(movieDirectors)
        .values({ movieId, directorId: directorRow.id })
        .onConflictDoNothing();
    }
  }
}

/**
 * Check for duplicate watch event (same movie + same calendar date).
 */
async function isDuplicateWatch(
  db: Database,
  movieId: number,
  watchedAt: string
): Promise<boolean> {
  const watchDate = watchedAt.substring(0, 10); // YYYY-MM-DD
  const existing = await db
    .select({ id: watchHistory.id })
    .from(watchHistory)
    .where(
      and(
        eq(watchHistory.movieId, movieId),
        sql`substr(${watchHistory.watchedAt}, 1, 10) = ${watchDate}`
      )
    )
    .limit(1);

  return existing.length > 0;
}

/**
 * Handle a media.scrobble event for a movie.
 */
async function handleMovieScrobble(
  db: Database,
  payload: PlexWebhookPayload,
  tmdbClient: TmdbClient
): Promise<{ success: boolean; movieId?: number }> {
  const movieId = await upsertMovieFromPlex(db, payload.Metadata, tmdbClient);

  const watchedAt = new Date().toISOString();

  // Check for duplicate
  const isDuplicate = await isDuplicateWatch(db, movieId, watchedAt);
  if (isDuplicate) {
    console.log(
      `[INFO] Plex webhook: duplicate watch for movie ${movieId} on ${watchedAt.substring(0, 10)}, skipping`
    );
    return { success: true, movieId };
  }

  // Insert watch event
  await db.insert(watchHistory).values({
    movieId,
    watchedAt,
    source: 'plex',
    percentComplete: 100,
    rewatch: 0,
  });

  console.log(
    `[INFO] Plex webhook: recorded movie watch - "${payload.Metadata.title}" (movie_id=${movieId})`
  );
  return { success: true, movieId };
}

/**
 * Handle a media.scrobble event for a TV episode.
 */
async function handleEpisodeScrobble(
  db: Database,
  payload: PlexWebhookPayload,
  tmdbClient: TmdbClient
): Promise<{ success: boolean; showId?: number }> {
  const metadata = payload.Metadata;

  if (!metadata.grandparentRatingKey) {
    console.log('[ERROR] Plex webhook: episode missing grandparentRatingKey');
    return { success: false };
  }

  // Upsert the show
  const showId = await upsertShowFromPlex(db, metadata, tmdbClient);

  const watchedAt = new Date().toISOString();

  // Insert episode watch
  await db
    .insert(plexEpisodesWatched)
    .values({
      showId,
      seasonNumber: metadata.parentIndex || 0,
      episodeNumber: metadata.index || 0,
      title: metadata.title,
      watchedAt,
    })
    .onConflictDoNothing();

  console.log(
    `[INFO] Plex webhook: recorded episode watch - "${metadata.grandparentTitle}" S${metadata.parentIndex}E${metadata.index}`
  );
  return { success: true, showId };
}

/**
 * Upsert a TV show from Plex metadata.
 */
async function upsertShowFromPlex(
  db: Database,
  metadata: PlexWebhookPayload['Metadata'],
  tmdbClient: TmdbClient
): Promise<number> {
  const showRatingKey = metadata.grandparentRatingKey!;

  // Check if show exists
  const existing = await db
    .select({ id: plexShows.id })
    .from(plexShows)
    .where(eq(plexShows.plexRatingKey, showRatingKey))
    .limit(1);

  if (existing.length > 0) {
    return existing[0].id;
  }

  // Try to resolve TMDB ID for the show
  let tmdbId: number | null = null;
  let showTitle = metadata.grandparentTitle || metadata.title;
  let summary: string | null = null;
  let posterPath: string | null = null;
  let backdropPath: string | null = null;
  let contentRating: string | null = metadata.contentRating || null;
  let tmdbRating: number | null = null;
  let year: number | null = null;
  let totalSeasons: number | null = null;
  let totalEpisodes: number | null = null;

  if (metadata.Guid) {
    tmdbId = extractTmdbIdFromGuids(metadata.Guid);
  }

  if (tmdbId) {
    try {
      const tvDetail = await tmdbClient.getTvShowDetail(tmdbId);
      showTitle = tvDetail.title;
      summary = tvDetail.summary;
      posterPath = tvDetail.posterPath;
      backdropPath = tvDetail.backdropPath;
      contentRating = tvDetail.contentRating || contentRating;
      tmdbRating = tvDetail.tmdbRating;
      year = tvDetail.year;
      totalSeasons = tvDetail.totalSeasons;
      totalEpisodes = tvDetail.totalEpisodes;
    } catch (error) {
      console.log(
        `[ERROR] TMDB TV enrichment failed for ${tmdbId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const [inserted] = await db
    .insert(plexShows)
    .values({
      plexRatingKey: showRatingKey,
      title: showTitle,
      year,
      tmdbId,
      summary,
      posterPath,
      backdropPath,
      contentRating,
      tmdbRating,
      totalSeasons,
      totalEpisodes,
    })
    .returning({ id: plexShows.id });

  return inserted.id;
}

/**
 * Main webhook event handler.
 */
export async function handlePlexWebhook(
  db: Database,
  payload: PlexWebhookPayload,
  tmdbClient: TmdbClient
): Promise<{ success: boolean; message: string }> {
  // Only handle media.scrobble events
  if (payload.event !== 'media.scrobble') {
    return { success: true, message: `Ignored event: ${payload.event}` };
  }

  // Generate a unique event ID for idempotency
  const eventId = `${payload.Metadata.ratingKey}-${Date.now()}`;

  // Check idempotency
  const alreadyProcessed = await isEventProcessed(db, eventId);
  if (alreadyProcessed) {
    return { success: true, message: 'Event already processed' };
  }

  const mediaType = payload.Metadata.type;

  let result: { success: boolean; movieId?: number; showId?: number };

  if (mediaType === 'movie') {
    result = await handleMovieScrobble(db, payload, tmdbClient);
  } else if (mediaType === 'episode') {
    result = await handleEpisodeScrobble(db, payload, tmdbClient);
  } else {
    return {
      success: true,
      message: `Ignored media type: ${mediaType}`,
    };
  }

  if (result.success) {
    // Record the event as processed
    await recordWebhookEvent(db, eventId, `media.scrobble.${mediaType}`);
  }

  return {
    success: result.success,
    message: result.success
      ? `Processed ${mediaType} scrobble`
      : `Failed to process ${mediaType} scrobble`,
  };
}
