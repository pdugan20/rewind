/**
 * Sync-time image processing.
 * Queries for entities missing images after sync, processes them in background.
 * Designed to run inside waitUntil() to stay within Worker execution limits.
 */

import { and, eq, desc, isNotNull, sql } from 'drizzle-orm';
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
import type { ImageResult, SourceSearchParams } from './sources/types.js';

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
          const entityId = outcome.value.params.entityId;
          await insertNoSourcePlaceholder(db, domain, entityType, entityId);
          // Refresh createdAt so PLACEHOLDER_RETRY_DAYS gates the next
          // retry. Without this, a dead URL that fails once would
          // retry on every pipeline run forever (since insertNoSourcePlaceholder
          // is onConflictDoNothing, the original timestamp never updates).
          await db
            .update(images)
            .set({ createdAt: new Date().toISOString() })
            .where(
              and(
                eq(images.domain, domain),
                eq(images.entityType, entityType),
                eq(images.entityId, entityId),
                eq(images.source, 'none')
              )
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

  // Listening album/artist queries pick up two populations:
  //   1. Entities with no images row at all (first-time pipeline run).
  //   2. Entities with a source='none' placeholder older than
  //      PLACEHOLDER_RETRY_DAYS. Without this, an album that fails once
  //      (e.g. an upstream search returned bad results before a recall
  //      improvement landed) would be locked out forever.
  const retryCutoff = new Date(
    Date.now() - PLACEHOLDER_RETRY_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  // Albums without images, OR with stale placeholder rows
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
        sql`(
          ${lastfmAlbums.id} NOT IN (
            SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
            WHERE ${images.domain} = 'listening' AND ${images.entityType} = 'albums'
          )
          OR ${lastfmAlbums.id} IN (
            SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
            WHERE ${images.domain} = 'listening'
              AND ${images.entityType} = 'albums'
              AND ${images.source} = 'none'
              AND ${images.createdAt} < ${retryCutoff}
          )
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

  // Artists without images, OR with stale placeholder rows
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
        sql`(
          ${lastfmArtists.id} NOT IN (
            SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
            WHERE ${images.domain} = 'listening' AND ${images.entityType} = 'artists'
          )
          OR ${lastfmArtists.id} IN (
            SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
            WHERE ${images.domain} = 'listening'
              AND ${images.entityType} = 'artists'
              AND ${images.source} = 'none'
              AND ${images.createdAt} < ${retryCutoff}
          )
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
 *
 * Targets two populations (mirrors listening's pattern):
 *   1. Articles with a URL or og_image_url but no `images` row yet.
 *   2. Articles with a null-source placeholder row older than
 *      PLACEHOLDER_RETRY_DAYS. Keeps flaky or temporarily-blocked
 *      sources from being locked out forever without requiring the
 *      manual /admin/clear-reading-image-placeholders endpoint.
 */
export async function processReadingImages(
  db: Database,
  env: PipelineEnv,
  maxItems = DEFAULT_MAX_ITEMS
): Promise<SyncImageResult[]> {
  const retryCutoff = new Date(
    Date.now() - PLACEHOLDER_RETRY_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const articleRows = await db
    .select({
      id: readingItems.id,
      url: readingItems.url,
      ogImageUrl: readingItems.ogImageUrl,
    })
    .from(readingItems)
    .where(
      and(
        eq(readingItems.itemType, 'article'),
        sql`(${readingItems.ogImageUrl} IS NOT NULL OR ${readingItems.url} IS NOT NULL) AND (
          ${readingItems.id} NOT IN (
            SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
            WHERE ${images.domain} = 'reading' AND ${images.entityType} = 'articles'
          )
          OR ${readingItems.id} IN (
            SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
            WHERE ${images.domain} = 'reading'
              AND ${images.entityType} = 'articles'
              AND ${images.source} = 'none'
              AND ${images.createdAt} < ${retryCutoff}
          )
        )`
      )
    )
    // Newest first: each cron tick processes 50 items and the historical
    // backfill is ~7k articles deep. Without an explicit order the engine
    // returns them in id-asc, so recent saves never get images until the
    // backfill (~35 days at 200/day) clears. id-desc means new articles
    // get pictures within hours of being saved while the backfill grinds
    // in the background.
    .orderBy(desc(readingItems.id))
    .limit(maxItems);

  const articleItems: SourceSearchParams[] = articleRows.map((a) => ({
    domain: 'reading',
    entityType: 'articles',
    entityId: String(a.id),
    directImageUrl: a.ogImageUrl ?? undefined,
    articleUrl: a.url ?? undefined,
  }));

  return [await processItems(db, env, 'reading', 'articles', articleItems)];
}

const APPLE_MUSIC_ARTIST_URL =
  'https://api.music.apple.com/v1/catalog/us/artists';

// Null-placeholder rows older than this are candidates for a retry. Short
// window because the typical reason for a placeholder is "image pipeline
// couldn't find this artist by name", and with an Apple Music id in hand we
// can do a deterministic lookup that is likely to succeed now.
const PLACEHOLDER_RETRY_DAYS = 7;

interface AppleMusicArtistResponse {
  data?: Array<{
    id?: string;
    attributes?: {
      artwork?: {
        url?: string;
        width?: number;
        height?: number;
      };
    };
  }>;
}

/**
 * Fetch a single artist's artwork directly from the Apple Music catalog
 * using the stored `apple_music_id`. Bypasses the name-search step that
 * produces false negatives for artists whose names don't survive the
 * existing `artistMatches()` filter (e.g. obscure / non-English artists).
 *
 * Returns at most one candidate — the catalog endpoint is deterministic.
 */
async function fetchAppleMusicArtistArtwork(
  token: string,
  appleMusicId: number
): Promise<ImageResult | null> {
  const response = await fetch(`${APPLE_MUSIC_ARTIST_URL}/${appleMusicId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    // 404 is expected for stale / invalid ids — log softly and move on.
    if (response.status !== 404) {
      console.log(
        `[ERROR] Apple Music artist fetch failed for id ${appleMusicId}: ${response.status}`
      );
    }
    return null;
  }

  const data = (await response.json()) as AppleMusicArtistResponse;
  const artwork = data.data?.[0]?.attributes?.artwork;
  if (!artwork?.url) return null;

  return {
    source: 'apple-music',
    url: artwork.url.replace('{w}', '1000').replace('{h}', '1000'),
    width: 1000,
    height: 1000,
  };
}

/**
 * Refresh artist images using the stored Apple Music artist id.
 *
 * Targets two populations:
 *   1. Artists with `apple_music_id` but no `images` row at all
 *      (image sync hasn't run against them yet).
 *   2. Artists with a null-source placeholder row (`source = 'none'`) that
 *      is older than PLACEHOLDER_RETRY_DAYS. These are artists where the
 *      name-search waterfall failed; a direct-by-id fetch often succeeds.
 *
 * Requires `APPLE_MUSIC_DEVELOPER_TOKEN`. If unset, returns zero-work.
 */
export async function refreshArtistImageFromAppleMusicId(
  db: Database,
  env: PipelineEnv,
  limit = DEFAULT_MAX_ITEMS
): Promise<SyncImageResult> {
  const result: SyncImageResult = {
    domain: 'listening',
    entityType: 'artists',
    queued: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  const token = env.APPLE_MUSIC_DEVELOPER_TOKEN;
  if (!token) {
    console.log(
      '[INFO] refreshArtistImageFromAppleMusicId: APPLE_MUSIC_DEVELOPER_TOKEN unset, skipping'
    );
    return result;
  }

  const retryCutoff = new Date(
    Date.now() - PLACEHOLDER_RETRY_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const rows = await db
    .select({
      id: lastfmArtists.id,
      name: lastfmArtists.name,
      appleMusicId: lastfmArtists.appleMusicId,
    })
    .from(lastfmArtists)
    .where(
      and(
        eq(lastfmArtists.isFiltered, 0),
        isNotNull(lastfmArtists.appleMusicId),
        sql`(
          ${lastfmArtists.id} NOT IN (
            SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
            WHERE ${images.domain} = 'listening' AND ${images.entityType} = 'artists'
          )
          OR ${lastfmArtists.id} IN (
            SELECT CAST(${images.entityId} AS INTEGER) FROM ${images}
            WHERE ${images.domain} = 'listening'
              AND ${images.entityType} = 'artists'
              AND ${images.source} = 'none'
              AND ${images.createdAt} < ${retryCutoff}
          )
        )`
      )
    )
    .orderBy(desc(lastfmArtists.playcount))
    .limit(limit);

  result.queued = rows.length;
  if (rows.length === 0) return result;

  console.log(
    `[SYNC] Refreshing images for ${rows.length} artists via Apple Music id`
  );

  for (const row of rows) {
    if (row.appleMusicId == null) continue;
    try {
      const candidate = await fetchAppleMusicArtistArtwork(
        token,
        row.appleMusicId
      );

      if (!candidate) {
        // No artwork in the catalog — refresh the placeholder timestamp so
        // we don't retry again for PLACEHOLDER_RETRY_DAYS. Insert-or-ignore
        // handles the "no row yet" case.
        await insertNoSourcePlaceholder(
          db,
          'listening',
          'artists',
          String(row.id)
        );
        await db
          .update(images)
          .set({ createdAt: new Date().toISOString() })
          .where(
            and(
              eq(images.domain, 'listening'),
              eq(images.entityType, 'artists'),
              eq(images.entityId, String(row.id)),
              eq(images.source, 'none')
            )
          );
        result.skipped++;
        continue;
      }

      const pipelineResult = await runPipeline(
        db,
        env,
        {
          domain: 'listening',
          entityType: 'artists',
          entityId: String(row.id),
          artistName: row.name,
        },
        { prefetchedCandidates: [candidate] }
      );

      if (pipelineResult) {
        result.succeeded++;
      } else {
        result.failed++;
      }
    } catch (error) {
      result.failed++;
      console.log(
        `[ERROR] refreshArtistImageFromAppleMusicId failed for artist ${row.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  console.log(
    `[SYNC] Image refresh complete: ${result.succeeded} succeeded, ${result.failed} failed, ${result.skipped} skipped`
  );
  return result;
}

const IMAGE_SYNC_DEDUP_HOURS = 6;

/**
 * Check if watching image processing was already run recently (within 6 hours)
 * by the Plex daily cron. If so, the Letterboxd cron can skip it.
 *
 * Must filter to syncType 'plex_library' — the Letterboxd sync writes its own
 * domain='watching' completed run (syncType 'letterboxd_rss') immediately
 * before this check runs, so a domain-only match would always see that run and
 * skip image processing on every Letterboxd cron. That would leave
 * Letterboxd-only movies (theatrical films never on Plex) without posters until
 * the next daily Plex cron. processWatchingImages is only ever chained off the
 * Plex cron, so 'plex_library' is the run we actually want to dedup against.
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
        eq(syncRuns.syncType, 'plex_library'),
        eq(syncRuns.status, 'completed'),
        sql`${syncRuns.completedAt} >= ${cutoff}`
      )
    )
    .orderBy(desc(syncRuns.completedAt))
    .limit(1);

  return !!recent;
}
