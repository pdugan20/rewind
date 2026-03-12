import { eq, and, sql } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import { syncRuns } from '../../db/schema/system.js';
import {
  traktCollection,
  traktCollectionStats,
} from '../../db/schema/trakt.js';
import { TraktClient } from './client.js';
import { getAccessToken } from './auth.js';
import { TmdbClient } from '../watching/tmdb.js';
import { resolveMovie } from '../watching/resolve-movie.js';
import type { Env } from '../../types/env.js';
import { afterSync } from '../../lib/after-sync.js';

/**
 * Look up a movie by TMDb ID, or create it with TMDb enrichment if new.
 * Returns the local movie ID.
 */
async function ensureMovie(
  db: Database,
  tmdbClient: TmdbClient,
  tmdbId: number,
  fallbackTitle: string,
  fallbackYear: number | null
): Promise<number> {
  const result = await resolveMovie(db, tmdbClient, {
    tmdbId,
    title: fallbackTitle,
    year: fallbackYear,
  });

  if (result) {
    return result.id;
  }

  // This shouldn't happen since we already have a tmdbId, but handle gracefully
  throw new Error(
    `Failed to resolve movie: ${fallbackTitle} (${fallbackYear}) [tmdb:${tmdbId}]`
  );
}

/**
 * Sync the Trakt collection into the local database.
 */
async function syncCollection(
  db: Database,
  client: TraktClient,
  tmdbClient: TmdbClient,
  userId: number
): Promise<number> {
  console.log('[SYNC] Fetching Trakt movie collection');
  const items = await client.getCollection();
  console.log(`[SYNC] Found ${items.length} items in Trakt collection`);

  // Track remote items for deletion detection
  const remoteKeys = new Set<string>();

  let synced = 0;

  for (const item of items) {
    const tmdbId = item.movie.ids.tmdb;
    if (!tmdbId) {
      console.log(
        `[INFO] Skipping ${item.movie.title} - no TMDb ID`
      );
      continue;
    }

    const traktId = item.movie.ids.trakt;
    const mediaType = normalizeMediaType(item.metadata?.media_type, item.metadata?.resolution);
    remoteKeys.add(`${traktId}:${mediaType}`);

    // Ensure movie exists in local DB
    const movieId = await ensureMovie(
      db,
      tmdbClient,
      tmdbId,
      item.movie.title,
      item.movie.year
    );

    // Upsert collection item
    await db
      .insert(traktCollection)
      .values({
        movieId,
        traktId,
        mediaType,
        resolution: (item.metadata?.resolution || null) as typeof traktCollection.$inferInsert.resolution,
        hdr: (item.metadata?.hdr || null) as typeof traktCollection.$inferInsert.hdr,
        audio: (item.metadata?.audio || null) as typeof traktCollection.$inferInsert.audio,
        audioChannels: (item.metadata?.audio_channels || null) as typeof traktCollection.$inferInsert.audioChannels,
        collectedAt: item.collected_at,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [
          traktCollection.userId,
          traktCollection.traktId,
          traktCollection.mediaType,
        ],
        set: {
          movieId: sql`excluded.movie_id`,
          resolution: sql`excluded.resolution`,
          hdr: sql`excluded.hdr`,
          audio: sql`excluded.audio`,
          audioChannels: sql`excluded.audio_channels`,
          collectedAt: sql`excluded.collected_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });

    synced++;
  }

  // Remove local items no longer in Trakt
  const localItems = await db
    .select({
      id: traktCollection.id,
      traktId: traktCollection.traktId,
      mediaType: traktCollection.mediaType,
    })
    .from(traktCollection)
    .where(eq(traktCollection.userId, userId));

  let removed = 0;
  for (const local of localItems) {
    const key = `${local.traktId}:${local.mediaType}`;
    if (!remoteKeys.has(key)) {
      await db
        .delete(traktCollection)
        .where(eq(traktCollection.id, local.id));
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[SYNC] Removed ${removed} items no longer in Trakt`);
  }

  console.log(`[SYNC] Trakt collection sync complete: ${synced} items`);
  return synced;
}

/**
 * Normalize Trakt media_type to our enum values.
 * Trakt uses "bluray" for standard Blu-ray. We distinguish UHD Blu-ray
 * by checking resolution === "uhd_4k" in combination with media_type "bluray".
 */
function normalizeMediaType(
  mediaType: string | undefined,
  resolution: string | undefined
): 'bluray' | 'uhd_bluray' | 'hddvd' | 'dvd' | 'digital' {
  if (!mediaType) return 'bluray';
  const lower = mediaType.toLowerCase();
  if (lower === 'hddvd') return 'hddvd';
  if (lower === 'dvd') return 'dvd';
  if (lower === 'digital') return 'digital';
  // Distinguish UHD Blu-ray from standard Blu-ray via resolution
  if (resolution?.toLowerCase() === 'uhd_4k') return 'uhd_bluray';
  return 'bluray';
}

/**
 * Compute and store Trakt collection statistics.
 */
async function computeStats(db: Database, userId: number): Promise<void> {
  console.log('[SYNC] Computing Trakt collection stats');

  // Total items
  const [{ count: totalItems }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(traktCollection)
    .where(eq(traktCollection.userId, userId));

  // Format breakdown
  const formatRows = await db
    .select({
      mediaType: traktCollection.mediaType,
      count: sql<number>`count(*)`,
    })
    .from(traktCollection)
    .where(eq(traktCollection.userId, userId))
    .groupBy(traktCollection.mediaType);

  const byFormat: Record<string, number> = {};
  for (const row of formatRows) {
    byFormat[row.mediaType] = row.count;
  }

  // Resolution breakdown
  const resRows = await db
    .select({
      resolution: traktCollection.resolution,
      count: sql<number>`count(*)`,
    })
    .from(traktCollection)
    .where(
      and(
        eq(traktCollection.userId, userId),
        sql`${traktCollection.resolution} IS NOT NULL`
      )
    )
    .groupBy(traktCollection.resolution);

  const byResolution: Record<string, number> = {};
  for (const row of resRows) {
    if (row.resolution) byResolution[row.resolution] = row.count;
  }

  // HDR breakdown
  const hdrRows = await db
    .select({
      hdr: traktCollection.hdr,
      count: sql<number>`count(*)`,
    })
    .from(traktCollection)
    .where(
      and(
        eq(traktCollection.userId, userId),
        sql`${traktCollection.hdr} IS NOT NULL`
      )
    )
    .groupBy(traktCollection.hdr);

  const byHdr: Record<string, number> = {};
  for (const row of hdrRows) {
    if (row.hdr) byHdr[row.hdr] = row.count;
  }

  // Genre breakdown (join with movies, then movie_genres, then genres)
  const genreRows = await db.all(sql`
    SELECT g.name, count(*) as count
    FROM trakt_collection tc
    JOIN movies m ON tc.movie_id = m.id
    JOIN movie_genres mg ON m.id = mg.movie_id
    JOIN genres g ON mg.genre_id = g.id
    WHERE tc.user_id = ${userId}
    GROUP BY g.name
    ORDER BY count DESC
  `);

  const byGenre: Record<string, number> = {};
  for (const row of genreRows as { name: string; count: number }[]) {
    byGenre[row.name] = row.count;
  }

  // Decade breakdown
  const decadeRows = await db.all(sql`
    SELECT (m.year / 10 * 10) || 's' as decade, count(*) as count
    FROM trakt_collection tc
    JOIN movies m ON tc.movie_id = m.id
    WHERE tc.user_id = ${userId} AND m.year IS NOT NULL
    GROUP BY decade
    ORDER BY decade
  `);

  const byDecade: Record<string, number> = {};
  for (const row of decadeRows as { decade: string; count: number }[]) {
    byDecade[row.decade] = row.count;
  }

  // Added this year
  const currentYear = new Date().getFullYear();
  const yearStart = `${currentYear}-01-01`;
  const [{ count: addedThisYear }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(traktCollection)
    .where(
      and(
        eq(traktCollection.userId, userId),
        sql`${traktCollection.collectedAt} >= ${yearStart}`
      )
    );

  // Upsert stats
  await db
    .insert(traktCollectionStats)
    .values({
      userId,
      totalItems,
      byFormat: JSON.stringify(byFormat),
      byResolution: JSON.stringify(byResolution),
      byHdr: JSON.stringify(byHdr),
      byGenre: JSON.stringify(byGenre),
      byDecade: JSON.stringify(byDecade),
      addedThisYear,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [traktCollectionStats.userId],
      set: {
        totalItems: sql`excluded.total_items`,
        byFormat: sql`excluded.by_format`,
        byResolution: sql`excluded.by_resolution`,
        byHdr: sql`excluded.by_hdr`,
        byGenre: sql`excluded.by_genre`,
        byDecade: sql`excluded.by_decade`,
        addedThisYear: sql`excluded.added_this_year`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  console.log('[SYNC] Trakt stats computation complete');
}

/**
 * Full Trakt collection sync: fetch from Trakt, upsert locally, compute stats.
 */
export async function syncTraktCollection(
  env: Env,
  userId: number = 1
): Promise<void> {
  const db = createDb(env.DB);
  const startedAt = new Date().toISOString();

  const [run] = await db
    .insert(syncRuns)
    .values({
      userId,
      domain: 'collecting',
      syncType: 'trakt',
      status: 'running',
      startedAt,
      itemsSynced: 0,
    })
    .returning({ id: syncRuns.id });

  try {
    const accessToken = await getAccessToken(env, db);
    const client = new TraktClient(accessToken, env.TRAKT_CLIENT_ID);
    const tmdbClient = new TmdbClient(env.TMDB_API_KEY);

    const itemCount = await syncCollection(db, client, tmdbClient, userId);
    await computeStats(db, userId);

    await db
      .update(syncRuns)
      .set({
        status: 'completed',
        completedAt: new Date().toISOString(),
        itemsSynced: itemCount,
      })
      .where(eq(syncRuns.id, run.id));

    // Post-sync: revalidation hooks (feed/search handled by Discogs sync for collecting domain)
    await afterSync(db, { domain: 'collecting' });

    console.log(`[SYNC] Trakt sync complete: ${itemCount} items`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] Trakt sync failed: ${errorMsg}`);
    await db
      .update(syncRuns)
      .set({
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: errorMsg,
      })
      .where(eq(syncRuns.id, run.id));
    throw err;
  }
}
