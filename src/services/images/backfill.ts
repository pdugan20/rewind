/**
 * Image backfill capability for existing entities.
 * Used to populate images for Last.fm albums and artists that were
 * synced before the image pipeline was deployed.
 */

import type { Database } from '../../db/client.js';
import type { PipelineEnv } from './pipeline.js';
import { runPipeline } from './pipeline.js';
import { insertNoSourcePlaceholder } from './placeholder.js';
import type { SourceSearchParams } from './sources/types.js';

export interface BackfillItem {
  entityId: string;
  artistName?: string;
  albumName?: string;
  mbid?: string;
  tmdbId?: string;
}

export interface BackfillResult {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: Array<{ entityId: string; error: string }>;
}

/**
 * Backfill images for a list of entities.
 * Processes items sequentially to respect rate limits.
 */
export async function backfillImages(
  db: Database,
  env: PipelineEnv,
  domain: string,
  entityType: string,
  items: BackfillItem[],
  options: { batchSize?: number; delayMs?: number } = {}
): Promise<BackfillResult> {
  const { batchSize = 10, delayMs = 1000 } = options;

  const result: BackfillResult = {
    total: items.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  console.log(
    `[SYNC] Starting image backfill for ${domain}/${entityType}: ${items.length} items`
  );

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);

    for (const item of batch) {
      const params: SourceSearchParams = {
        domain,
        entityType,
        entityId: item.entityId,
        artistName: item.artistName,
        albumName: item.albumName,
        mbid: item.mbid,
        tmdbId: item.tmdbId,
      };

      try {
        const pipelineResult = await runPipeline(db, env, params);

        if (pipelineResult) {
          result.succeeded++;
        } else {
          result.skipped++;
          // Insert a placeholder so this entity isn't retried
          await insertNoSourcePlaceholder(db, domain, entityType, item.entityId);
        }
      } catch (error) {
        result.failed++;
        result.errors.push({
          entityId: item.entityId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      result.processed++;
    }

    // Delay between batches to respect rate limits
    if (i + batchSize < items.length && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    console.log(
      `[SYNC] Backfill progress: ${result.processed}/${result.total} (${result.succeeded} succeeded, ${result.failed} failed, ${result.skipped} skipped)`
    );
  }

  console.log(
    `[SYNC] Backfill complete for ${domain}/${entityType}: ${result.succeeded} succeeded, ${result.failed} failed, ${result.skipped} skipped`
  );

  return result;
}
