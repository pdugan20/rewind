// Player photo backfill: for every row in `players`, fetch the MLB
// silo cutout PNG (head/shoulders, transparent) and the ESPN full-body
// PNG (when an ESPN id is known) through the existing image pipeline.
// Stores both in R2 with thumbhash + dominant_color, keyed on
//   (domain='attending', entity_type='player_silo'|'player_full',
//    entity_id=String(players.id))
// Idempotent — pipeline records already in `images` are skipped.

import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { players } from '../../db/schema/attending.js';
import { images } from '../../db/schema/system.js';
import type { PipelineEnv } from '../images/pipeline.js';
import { runPipeline } from '../images/pipeline.js';

export interface PlayerPhotoOptions {
  // Limit to a specific subset of player IDs (db PK, not mlb_stats_id).
  playerIds?: number[];
  // Default: skip players who already have a silo image in `images`.
  skipExisting?: boolean;
  // Hard cap on players processed in one run.
  limit?: number;
  // When true, skip the ESPN/full variant even when espn_id is present.
  siloOnly?: boolean;
}

export interface PlayerPhotoResult {
  scanned: number;
  silo_inserted: number;
  silo_skipped: number;
  silo_failed: number;
  full_inserted: number;
  full_skipped: number;
  full_failed: number;
  failures: Array<{ player_id: number; reason: string }>;
}

const SILO_URL_TEMPLATE =
  'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/r_max/w_360,q_auto:best/v1/people/{ID}/headshot/silo/current';

const ESPN_FULL_URL_TEMPLATE =
  'https://a.espncdn.com/combiner/i?img=/i/headshots/mlb/players/full/{ID}.png&h=400&w=400&scale=crop';

export async function enrichPlayerPhotos(
  db: Database,
  env: PipelineEnv,
  opts: PlayerPhotoOptions = {}
): Promise<PlayerPhotoResult> {
  const {
    playerIds,
    skipExisting = true,
    limit = 1000,
    siloOnly = false,
  } = opts;

  const result: PlayerPhotoResult = {
    scanned: 0,
    silo_inserted: 0,
    silo_skipped: 0,
    silo_failed: 0,
    full_inserted: 0,
    full_skipped: 0,
    full_failed: 0,
    failures: [],
  };

  const rows = await db.select().from(players).limit(limit);
  const filtered = playerIds
    ? rows.filter((r) => playerIds.includes(r.id))
    : rows;

  for (const p of filtered) {
    if (!p.mlbStatsId) continue;
    result.scanned++;
    const entityId = String(p.id);

    // Silo: every player with an mlb_stats_id gets one.
    const siloOutcome = await fetchAndStore(
      db,
      env,
      'player_silo',
      entityId,
      SILO_URL_TEMPLATE.replace('{ID}', String(p.mlbStatsId)),
      skipExisting
    );
    if (siloOutcome === 'inserted') result.silo_inserted++;
    else if (siloOutcome === 'skipped') result.silo_skipped++;
    else {
      result.silo_failed++;
      result.failures.push({
        player_id: p.id,
        reason: `silo: ${siloOutcome}`,
      });
    }

    // Full: only when we have an ESPN id (resolved by the cross-reference
    // sync). No id → leave the slot empty; consumer falls back to silo.
    if (!siloOnly && p.espnId) {
      const fullOutcome = await fetchAndStore(
        db,
        env,
        'player_full',
        entityId,
        ESPN_FULL_URL_TEMPLATE.replace('{ID}', p.espnId),
        skipExisting
      );
      if (fullOutcome === 'inserted') result.full_inserted++;
      else if (fullOutcome === 'skipped') result.full_skipped++;
      else {
        result.full_failed++;
        result.failures.push({
          player_id: p.id,
          reason: `full: ${fullOutcome}`,
        });
      }
    }
  }

  return result;
}

type StoreOutcome = 'inserted' | 'skipped' | string;

async function fetchAndStore(
  db: Database,
  env: PipelineEnv,
  entityType: 'player_silo' | 'player_full',
  entityId: string,
  url: string,
  skipExisting: boolean
): Promise<StoreOutcome> {
  if (skipExisting) {
    const existing = await db
      .select({ id: images.id })
      .from(images)
      .where(
        and(
          eq(images.domain, 'attending'),
          eq(images.entityType, entityType),
          eq(images.entityId, entityId)
        )
      )
      .limit(1);
    if (existing.length > 0) return 'skipped';
  }

  try {
    const result = await runPipeline(
      db,
      env,
      {
        domain: 'attending',
        entityType,
        entityId,
      },
      {
        prefetchedCandidates: [
          { source: entityType, url, width: null, height: null },
        ],
      }
    );
    return result ? 'inserted' : 'pipeline returned null';
  } catch (err) {
    return `pipeline error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
