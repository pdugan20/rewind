/**
 * Sync MLB team metadata from MLB Stats API into the local `mlb_teams`
 * table. Pulls all 30 active clubs in one call. Logos are fetched
 * separately and run through the standard image pipeline so they get
 * thumbhash + dominant/accent colors.
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { mlbTeams } from '../../db/schema/attending.js';

const STATS_API = 'https://statsapi.mlb.com/api/v1';

interface MlbTeamRecord {
  id: number;
  name: string;
  teamCode?: string;
  fileCode?: string;
  abbreviation: string;
  active?: boolean;
  // The /teams endpoint doesn't ship colors directly; we have to derive
  // them from /teams/:id/colors or a known table. For v1 we leave them
  // null and rely on the image pipeline's dominant_color/accent_color
  // for accent.
}

interface MlbTeamsResponse {
  teams?: MlbTeamRecord[];
}

/**
 * Fetch all active MLB clubs and upsert into mlb_teams. Logos are NOT
 * fetched here — call `syncMlbTeamLogos` separately so a team-list refresh
 * doesn't always pay the image-pipeline cost.
 */
export async function syncMlbTeamsList(
  db: Database
): Promise<{ inserted: number; updated: number }> {
  const url = `${STATS_API}/teams?sportId=1`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `[ERROR] MLB /teams returned ${resp.status} ${resp.statusText}`
    );
  }
  const body = (await resp.json()) as MlbTeamsResponse;
  const teams = body.teams ?? [];

  let inserted = 0;
  let updated = 0;
  const now = new Date().toISOString();

  for (const t of teams) {
    if (!t.id || !t.name || !t.abbreviation) continue;
    const existing = await db
      .select({ id: mlbTeams.id })
      .from(mlbTeams)
      .where(eq(mlbTeams.id, t.id))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(mlbTeams).values({
        id: t.id,
        name: t.name,
        abbreviation: t.abbreviation,
        teamCode: t.teamCode ?? t.fileCode ?? null,
        league: 'mlb',
        active: t.active === false ? 0 : 1,
        syncedAt: now,
      });
      inserted++;
    } else {
      await db
        .update(mlbTeams)
        .set({
          name: t.name,
          abbreviation: t.abbreviation,
          teamCode: t.teamCode ?? t.fileCode ?? null,
          active: t.active === false ? 0 : 1,
          syncedAt: now,
        })
        .where(eq(mlbTeams.id, t.id));
      updated++;
    }
  }

  return { inserted, updated };
}

/**
 * Helper used by routes: returns the team object for the given mlb id,
 * folded with image attachment metadata. Returns null when the team
 * isn't in the local table (e.g. unsynced, deactivated, non-MLB league).
 */
export async function getMlbTeamForCard(
  db: Database,
  teamId: number,
  imageMap: Map<string, unknown>
): Promise<{
  id: number;
  name: string;
  abbreviation: string;
  league: 'mlb';
  primary_color: string | null;
  logo: unknown | null;
} | null> {
  const [team] = await db
    .select()
    .from(mlbTeams)
    .where(eq(mlbTeams.id, teamId))
    .limit(1);
  if (!team) return null;
  return {
    id: team.id,
    name: team.name,
    abbreviation: team.abbreviation,
    league: 'mlb',
    primary_color: team.primaryColor ?? null,
    logo: imageMap.get(String(team.id)) ?? null,
  };
}
