/**
 * Sweep `players` and fill in bio + awards from MLB Stats /people.
 *
 * The boxscore-driven `enrich-boxscore` upsert leaves most bio fields
 * null (the boxscore endpoint omits them by default). Run this admin
 * sweep after a fresh ingest to populate height, weight, birth_state_
 * province, college_name, debut_date, bats/throws, and awards.
 *
 * Idempotent. Skips rows that already have a non-null `birth_country`
 * unless `force` is set — birth_country is the canary because it's
 * always returned by the upstream when bio is hydrated and never
 * changes. Also writes through cache, so re-runs are cheap.
 */

import { eq, isNull, and, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { players } from '../../db/schema/attending.js';
import type { Env } from '../../types/env.js';
import { fetchPlayerBios, type PlayerBio } from '../mlb-stats/people.js';

export interface EnrichPlayerBioOptions {
  playerIds?: number[];
  force?: boolean;
  limit?: number;
}

export interface EnrichPlayerBioResult {
  scanned: number;
  fetched: number;
  updated: number;
  failures: Array<{ mlb_stats_id: number; reason: string }>;
}

const BATCH_SIZE = 100;

export async function enrichPlayerBios(
  db: Database,
  env: Env,
  opts: EnrichPlayerBioOptions = {}
): Promise<EnrichPlayerBioResult> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);

  // Pick the rows we need to enrich. Default policy: MLB players with
  // a missing canary bio field. `force` ignores the canary so callers
  // can refresh existing rows on demand.
  const baseConditions = [
    eq(players.league, 'mlb'),
    sql`${players.mlbStatsId} IS NOT NULL`,
  ];
  const conditions = opts.force
    ? baseConditions
    : [...baseConditions, isNull(players.birthCountry)];

  let rows: Array<{ id: number; mlbStatsId: number | null }>;
  if (opts.playerIds && opts.playerIds.length > 0) {
    rows = await db
      .select({ id: players.id, mlbStatsId: players.mlbStatsId })
      .from(players)
      .where(and(...baseConditions, inArray(players.id, opts.playerIds)))
      .limit(limit);
  } else {
    rows = await db
      .select({ id: players.id, mlbStatsId: players.mlbStatsId })
      .from(players)
      .where(and(...conditions))
      .limit(limit);
  }

  const result: EnrichPlayerBioResult = {
    scanned: rows.length,
    fetched: 0,
    updated: 0,
    failures: [],
  };
  if (rows.length === 0) return result;

  // Map mlb_stats_id -> internal id so we can update the right row when
  // the upstream returns players we asked for.
  const idIndex = new Map<number, number>();
  for (const row of rows) {
    if (row.mlbStatsId != null) idIndex.set(row.mlbStatsId, row.id);
  }
  const mlbIds = Array.from(idIndex.keys());

  // Fetch in chunks to keep the upstream URL length sane.
  const bios: PlayerBio[] = [];
  for (let i = 0; i < mlbIds.length; i += BATCH_SIZE) {
    const chunk = mlbIds.slice(i, i + BATCH_SIZE);
    const got = await fetchPlayerBios(env, chunk);
    bios.push(...got);
  }
  result.fetched = bios.length;

  // Apply updates one at a time. Players are 30K rows max in MLB; this
  // runs admin-side, not on a hot path.
  const now = new Date().toISOString();
  for (const bio of bios) {
    const playerId = idIndex.get(bio.mlb_stats_id);
    if (!playerId) continue;
    try {
      await db
        .update(players)
        .set({
          firstName: bio.first_name ?? undefined,
          lastName: bio.last_name ?? undefined,
          primaryNumber: bio.primary_number ?? undefined,
          primaryPosition: bio.primary_position ?? undefined,
          birthDate: bio.birth_date ?? undefined,
          birthCity: bio.birth_city ?? undefined,
          birthStateProvince: bio.birth_state_province ?? undefined,
          birthCountry: bio.birth_country ?? undefined,
          height: bio.height ?? undefined,
          weight: bio.weight ?? undefined,
          bats: bio.bats ?? undefined,
          throws: bio.throws ?? undefined,
          debutDate: bio.debut_date ?? undefined,
          collegeName: bio.college_name ?? undefined,
          awards: JSON.stringify(bio.awards),
          updatedAt: now,
        })
        .where(eq(players.id, playerId));
      result.updated++;
    } catch (err) {
      result.failures.push({
        mlb_stats_id: bio.mlb_stats_id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
