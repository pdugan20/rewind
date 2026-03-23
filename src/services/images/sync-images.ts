/**
 * Sync-time image processing.
 * Queries for entities missing images after sync, processes them in background.
 * Designed to run inside waitUntil() to stay within Worker execution limits.
 */

import { and, eq, desc, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { lastfmAlbums, lastfmArtists } from '../../db/schema/lastfm.js';
import { movies, plexShows } from '../../db/schema/watching.js';
import {
  discogsReleases,
  discogsArtists,
  discogsReleaseArtists,
} from '../../db/schema/discogs.js';
import { readingItems } from '../../db/schema/reading.js';
import { images, syncRuns } from '../../db/schema/system.js';
import { insertNoSourcePlaceholder } from './placeholder.js';
import type { PipelineEnv } from './pipeline.js';
import { runPipeline } from './pipeline.js';
import type { SourceSearchParams } from './sources/types.js';

const DEFAULT_MAX_ITEMS = 50;
const BATCH_SIZE = 5;

export interface SyncImageResult {
  domain: string;
  entityType: string;
  queued: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export async function processItems(
  db: Database,
  env: PipelineEnv,
  domain: string,
  entityType: string,
  items: SourceSearchParams[]
): Promise<SyncImageResult> {
  const result: SyncImageResult = {
    domain,
    entityType,
    queued: items.length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  if (items.length === 0) return result;

  console.log(
    `[SYNC] Processing images for ${items.length} new ${domain}/${entityType} entities`
  );

  // Process in batches of BATCH_SIZE using Promise.allSettled for network-bound parallelism
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(items.length / BATCH_SIZE);
    const batchStart = Date.now();

    const settled = await Promise.allSettled(
      batch.map(async (params) => {
        const pipelineResult = await runPipeline(db, env, params);
        return { params, pipelineResult };
      })
    );

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        if (outcome.value.pipelineResult) {
          result.succeeded++;
        } else {
          result.skipped++;
          await insertNoSourcePlaceholder(
            db,
            domain,
            entityType,
            outcome.value.params.entityId
          );
        }
      } else {
        result.failed++;
        console.log(
          `[ERROR] Image processing failed for ${domain}/${entityType}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`
        );
      }
    }

    const batchMs = Date.now() - batchStart;
    console.log(
      `[SYNC] Batch ${batchNum}/${totalBatches} completed in ${batchMs}ms (${domain}/${entityType})`
    );
  }

  console.log(
    `[SYNC] Image processing complete for ${domain}/${entityType}: ${result.succeeded} succeeded, ${result.failed} failed, ${result.skipped} skipped`
  );

  return result;
}

/**
 * Process images for listening entities (albums + artists) missing images.
 */
export async function processListeningImages(
  db: Database,
  env: PipelineEnv,
  maxItems = DEFAULT_MAX_ITEMS
): Promise<SyncImageResult[]> {
  const results: SyncImageResult[] = [];

  // Albums without images
  const albumRows = await db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      mbid: lastfmAlbums.mbid,
      artistName: lastfmArtists.name,
    })
    .from(lastfmAlbums)
    .innerJoin(
      lastfmArtists,
      sql`${lastfmAlbums.artistId} = ${lastfmArtists.id}`
    )
    .where(
      and(
        eq(lastfmAlbums.isFiltered, 0),
        sql`${lastfmAlbums.id} NOT IN (
          SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
          WHERE ${images.domain} = 'listening' AND ${images.entityType} = 'albums'
        )`
      )
    )
    .limit(maxItems);

  const albumItems: SourceSearchParams[] = albumRows.map((a) => ({
    domain: 'listening',
    entityType: 'albums',
    entityId: String(a.id),
    albumName: a.name,
    artistName: a.artistName,
    mbid: a.mbid ?? undefined,
  }));

  results.push(await processItems(db, env, 'listening', 'albums', albumItems));

  // Artists without images
  const artistRows = await db
    .select({
      id: lastfmArtists.id,
      name: lastfmArtists.name,
      mbid: lastfmArtists.mbid,
    })
    .from(lastfmArtists)
    .where(
      and(
        eq(lastfmArtists.isFiltered, 0),
        sql`${lastfmArtists.id} NOT IN (
          SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
          WHERE ${images.domain} = 'listening' AND ${images.entityType} = 'artists'
        )`
      )
    )
    .limit(maxItems);

  const artistItems: SourceSearchParams[] = artistRows.map((a) => ({
    domain: 'listening',
    entityType: 'artists',
    entityId: String(a.id),
    artistName: a.name,
    mbid: a.mbid ?? undefined,
  }));

  results.push(
    await processItems(db, env, 'listening', 'artists', artistItems)
  );

  return results;
}

/**
 * Process images for watching entities (movies + shows) missing images.
 */
export async function processWatchingImages(
  db: Database,
  env: PipelineEnv,
  maxItems = DEFAULT_MAX_ITEMS
): Promise<SyncImageResult[]> {
  const results: SyncImageResult[] = [];

  // Movies without images
  const movieRows = await db
    .select({
      id: movies.id,
      tmdbId: movies.tmdbId,
    })
    .from(movies)
    .where(
      sql`${movies.tmdbId} IS NOT NULL AND ${movies.id} NOT IN (
        SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
        WHERE ${images.domain} = 'watching' AND ${images.entityType} = 'movies'
      )`
    )
    .limit(maxItems);

  const movieItems: SourceSearchParams[] = movieRows.map((m) => ({
    domain: 'watching',
    entityType: 'movies',
    entityId: String(m.id),
    tmdbId: m.tmdbId ? String(m.tmdbId) : undefined,
  }));

  results.push(await processItems(db, env, 'watching', 'movies', movieItems));

  // Shows without images
  const showRows = await db
    .select({
      id: plexShows.id,
      tmdbId: plexShows.tmdbId,
    })
    .from(plexShows)
    .where(
      sql`${plexShows.tmdbId} IS NOT NULL AND ${plexShows.id} NOT IN (
        SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
        WHERE ${images.domain} = 'watching' AND ${images.entityType} = 'shows'
      )`
    )
    .limit(maxItems);

  const showItems: SourceSearchParams[] = showRows.map((s) => ({
    domain: 'watching',
    entityType: 'shows',
    entityId: String(s.id),
    tmdbId: s.tmdbId ? String(s.tmdbId) : undefined,
  }));

  results.push(await processItems(db, env, 'watching', 'shows', showItems));

  return results;
}

/**
 * Process images for collecting entities (releases) missing images.
 */
export async function processCollectingImages(
  db: Database,
  env: PipelineEnv,
  maxItems = DEFAULT_MAX_ITEMS
): Promise<SyncImageResult[]> {
  // Releases without images, joined with primary artist name
  const releaseRows = await db
    .select({
      discogsId: discogsReleases.discogsId,
      title: discogsReleases.title,
      artistName: discogsArtists.name,
    })
    .from(discogsReleases)
    .leftJoin(
      discogsReleaseArtists,
      sql`${discogsReleaseArtists.releaseId} = ${discogsReleases.id}`
    )
    .leftJoin(
      discogsArtists,
      sql`${discogsReleaseArtists.artistId} = ${discogsArtists.id}`
    )
    .where(
      sql`${discogsReleases.discogsId} NOT IN (
        SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
        WHERE ${images.domain} = 'collecting' AND ${images.entityType} = 'releases'
      )`
    )
    .groupBy(discogsReleases.discogsId)
    .limit(maxItems);

  const releaseItems: SourceSearchParams[] = releaseRows.map((r) => ({
    domain: 'collecting',
    entityType: 'releases',
    entityId: String(r.discogsId),
    albumName: r.title,
    artistName: r.artistName ?? undefined,
  }));

  return [await processItems(db, env, 'collecting', 'releases', releaseItems)];
}

/**
 * Process images for reading entities (articles) missing images.
 * Extracts og:image from article URLs for thumbnails.
 */
export async function processReadingImages(
  db: Database,
  env: PipelineEnv,
  maxItems = DEFAULT_MAX_ITEMS
): Promise<SyncImageResult[]> {
  // Articles without images that have a URL to fetch og:image from
  const articleRows = await db
    .select({
      id: readingItems.id,
      url: readingItems.url,
    })
    .from(readingItems)
    .where(
      and(
        eq(readingItems.itemType, 'article'),
        sql`${readingItems.url} IS NOT NULL AND ${readingItems.id} NOT IN (
          SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
          WHERE ${images.domain} = 'reading' AND ${images.entityType} = 'articles'
        )`
      )
    )
    .limit(maxItems);

  const articleItems: SourceSearchParams[] = articleRows.map((a) => ({
    domain: 'reading',
    entityType: 'articles',
    entityId: String(a.id),
    articleUrl: a.url ?? undefined,
  }));

  return [await processItems(db, env, 'reading', 'articles', articleItems)];
}

const IMAGE_SYNC_DEDUP_HOURS = 6;

/**
 * Check if watching image processing was already run recently (within 6 hours)
 * by the Plex daily cron. If so, the Letterboxd cron can skip it.
 */
export async function shouldSkipWatchingImages(db: Database): Promise<boolean> {
  const cutoff = new Date(
    Date.now() - IMAGE_SYNC_DEDUP_HOURS * 60 * 60 * 1000
  ).toISOString();

  const [recent] = await db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.domain, 'watching'),
        eq(syncRuns.status, 'completed'),
        sql`${syncRuns.completedAt} >= ${cutoff}`
      )
    )
    .orderBy(desc(syncRuns.completedAt))
    .limit(1);

  return !!recent;
}
