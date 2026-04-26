// Per-game enrichment: pull MLB Stats box score + live feed for each
// attended MLB game, upsert players, write per-player appearance rows,
// and merge game-level extras (attendance, weather, linescore,
// decisions) into attendedEvents.eventData. Idempotent — safe to
// re-run; existing rows update via ON CONFLICT.

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  attendedEventPlayers,
  attendedEvents,
  players,
} from '../../db/schema/attending.js';
import {
  fetchMlbBoxScore,
  type MlbAppearance,
  type MlbBoxScoreData,
  type MlbPlayerBio,
} from '../sports/mlb-boxscore.js';

export interface BoxScoreEnrichOptions {
  // External_id range filter — only enrich events with these gamePks.
  gamePks?: number[];
  // Skip events whose event_data already has the boxscore fields.
  // Useful for incremental runs.
  skipEnriched?: boolean;
  limit?: number;
  dryRun?: boolean;
}

export interface BoxScoreEnrichResult {
  scanned: number;
  enriched: number;
  players_inserted: number;
  players_updated: number;
  appearances_inserted: number;
  appearances_updated: number;
  failures: Array<{ event_id: number; reason: string }>;
}

export async function enrichAttendedBoxScores(
  db: Database,
  opts: BoxScoreEnrichOptions = {}
): Promise<BoxScoreEnrichResult> {
  const { gamePks, skipEnriched = true, limit = 100, dryRun = false } = opts;
  const result: BoxScoreEnrichResult = {
    scanned: 0,
    enriched: 0,
    players_inserted: 0,
    players_updated: 0,
    appearances_inserted: 0,
    appearances_updated: 0,
    failures: [],
  };

  // Pull every attended MLB game with an MLB Stats external_id.
  const events = await db
    .select()
    .from(attendedEvents)
    .where(
      and(
        eq(attendedEvents.eventType, 'mlb_game'),
        eq(attendedEvents.externalSource, 'mlb_stats_api')
      )
    )
    .limit(limit);

  for (const ev of events) {
    if (!ev.externalId) continue;
    const gamePk = parseInt(ev.externalId, 10);
    if (Number.isNaN(gamePk)) continue;
    if (gamePks && !gamePks.includes(gamePk)) continue;

    const existingData: Record<string, unknown> = ev.eventData
      ? (JSON.parse(ev.eventData) as Record<string, unknown>)
      : {};
    if (skipEnriched && existingData.attendance != null) {
      // Already enriched — skip unless caller forces re-enrich.
      continue;
    }

    result.scanned++;
    let box: MlbBoxScoreData | null;
    try {
      box = await fetchMlbBoxScore(gamePk);
    } catch (err) {
      result.failures.push({
        event_id: ev.id,
        reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (!box) {
      result.failures.push({
        event_id: ev.id,
        reason: 'boxscore not found',
      });
      continue;
    }

    if (dryRun) {
      result.enriched++;
      continue;
    }

    try {
      const counts = await persistBoxScore(db, ev.id, box, existingData);
      result.enriched++;
      result.players_inserted += counts.players_inserted;
      result.players_updated += counts.players_updated;
      result.appearances_inserted += counts.appearances_inserted;
      result.appearances_updated += counts.appearances_updated;
    } catch (err) {
      result.failures.push({
        event_id: ev.id,
        reason: `persist failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return result;
}

interface PersistCounts {
  players_inserted: number;
  players_updated: number;
  appearances_inserted: number;
  appearances_updated: number;
}

async function persistBoxScore(
  db: Database,
  eventId: number,
  box: MlbBoxScoreData,
  existingEventData: Record<string, unknown>
): Promise<PersistCounts> {
  const counts: PersistCounts = {
    players_inserted: 0,
    players_updated: 0,
    appearances_inserted: 0,
    appearances_updated: 0,
  };

  // Upsert each player and capture the players.id for the join row.
  const playerIdByMlb = new Map<number, number>();
  for (const a of box.appearances) {
    const playerId = await upsertPlayer(db, a.player, a.team_id, counts);
    playerIdByMlb.set(a.player.mlb_stats_id, playerId);
  }

  // Insert/update each appearance.
  for (const a of box.appearances) {
    const pid = playerIdByMlb.get(a.player.mlb_stats_id);
    if (!pid) continue;
    await upsertAppearance(db, eventId, pid, a, counts);
  }

  // Merge game-level extras into event_data and bump updated_at.
  const merged: Record<string, unknown> = {
    ...existingEventData,
    attendance: box.attendance,
    weather: box.weather,
    duration_minutes: box.duration_minutes,
    first_pitch: box.first_pitch,
    linescore: box.linescore,
    starting_pitchers: {
      home_id: box.starting_pitcher_home_id,
      away_id: box.starting_pitcher_away_id,
    },
    decisions: {
      winner_id: box.winning_pitcher_id,
      loser_id: box.losing_pitcher_id,
      save_id: box.save_pitcher_id,
    },
    boxscore_enriched_at: new Date().toISOString(),
  };
  await db
    .update(attendedEvents)
    .set({
      eventData: JSON.stringify(merged),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(attendedEvents.id, eventId));

  return counts;
}

async function upsertPlayer(
  db: Database,
  bio: MlbPlayerBio,
  teamId: number,
  counts: PersistCounts
): Promise<number> {
  const now = new Date().toISOString();

  // Try to fetch existing row first to know whether this is insert or update.
  const existing = await db
    .select()
    .from(players)
    .where(
      and(eq(players.league, 'mlb'), eq(players.mlbStatsId, bio.mlb_stats_id))
    )
    .limit(1);

  if (existing.length > 0) {
    const ex = existing[0];
    await db
      .update(players)
      .set({
        fullName: bio.full_name,
        firstName: bio.first_name ?? ex.firstName,
        lastName: bio.last_name ?? ex.lastName,
        primaryPosition: bio.primary_position ?? ex.primaryPosition,
        primaryNumber: bio.primary_number ?? ex.primaryNumber,
        birthDate: bio.birth_date ?? ex.birthDate,
        birthCity: bio.birth_city ?? ex.birthCity,
        birthCountry: bio.birth_country ?? ex.birthCountry,
        bats: bio.bats ?? ex.bats,
        throws: bio.throws ?? ex.throws,
        debutDate: bio.debut_date ?? ex.debutDate,
        primaryTeamId: teamId,
        updatedAt: now,
      })
      .where(eq(players.id, ex.id));
    counts.players_updated++;
    return ex.id;
  }

  const [inserted] = await db
    .insert(players)
    .values({
      userId: 1,
      league: 'mlb',
      mlbStatsId: bio.mlb_stats_id,
      fullName: bio.full_name,
      firstName: bio.first_name,
      lastName: bio.last_name,
      primaryPosition: bio.primary_position,
      primaryNumber: bio.primary_number,
      birthDate: bio.birth_date,
      birthCity: bio.birth_city,
      birthCountry: bio.birth_country,
      bats: bio.bats,
      throws: bio.throws,
      primaryTeamId: teamId,
      debutDate: bio.debut_date,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: players.id });
  counts.players_inserted++;
  return inserted.id;
}

async function upsertAppearance(
  db: Database,
  eventId: number,
  playerId: number,
  a: MlbAppearance,
  counts: PersistCounts
): Promise<void> {
  const now = new Date().toISOString();
  const battingJson = a.batting_line ? JSON.stringify(a.batting_line) : null;
  const pitchingJson = a.pitching_line ? JSON.stringify(a.pitching_line) : null;

  const existing = await db
    .select()
    .from(attendedEventPlayers)
    .where(
      and(
        eq(attendedEventPlayers.eventId, eventId),
        eq(attendedEventPlayers.playerId, playerId)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(attendedEventPlayers)
      .set({
        teamId: a.team_id,
        isHome: a.is_home ? 1 : 0,
        battingLine: battingJson,
        pitchingLine: pitchingJson,
        decision: a.decision,
        notable: a.notable ? 1 : 0,
      })
      .where(eq(attendedEventPlayers.id, existing[0].id));
    counts.appearances_updated++;
    return;
  }

  await db.insert(attendedEventPlayers).values({
    userId: 1,
    eventId,
    playerId,
    teamId: a.team_id,
    isHome: a.is_home ? 1 : 0,
    battingLine: battingJson,
    pitchingLine: pitchingJson,
    decision: a.decision,
    notable: a.notable ? 1 : 0,
    createdAt: now,
  });
  counts.appearances_inserted++;
}

// Convenience: count attended MLB games that have NOT been enriched yet.
export async function countUnenrichedMlbGames(db: Database): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(attendedEvents)
    .where(
      and(
        eq(attendedEvents.eventType, 'mlb_game'),
        eq(attendedEvents.externalSource, 'mlb_stats_api'),
        sql`(${attendedEvents.eventData} IS NULL OR json_extract(${attendedEvents.eventData}, '$.boxscore_enriched_at') IS NULL)`
      )
    );
  return rows[0]?.count ?? 0;
}
