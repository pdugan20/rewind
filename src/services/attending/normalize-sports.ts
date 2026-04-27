// Sports data quality sweep.
//
// Three independent passes that share a service module so they can be
// imported together and the admin routes stay thin:
//   1. normalizeSportsTitles — regenerate title + subtitle for every
//      sports event with a canonical match (mlb_stats_api / espn).
//      Source-of-truth comes from event_data.{home_team,away_team,
//      home_score,away_score}, not the raw calendar/email title.
//   2. pruneJunkVenues — find venues whose name looks like email body
//      noise or a bare address, repoint affected events to the home
//      team's canonical venue when possible (T-Mobile Park for
//      Mariners home games, Husky Stadium for UW football, etc.),
//      then hard-delete the junk row.
//   3. mergeSportsDuplicates — collapse pairs of events that share a
//      date but split across (junk venue / no enrichment) and (real
//      venue / canonical match). Tickets, sources, and players migrate
//      to the enriched row; the junk row is deleted.
//
// All three support dry_run and report counts + actions for review.
// The forward fix in enrich.ts/load.ts means new ingest is already
// clean; these passes mop up history.

import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  attendedEventPerformers,
  attendedEventPlayers,
  attendedEventSources,
  attendedEventTickets,
  attendedEvents,
  venues,
} from '../../db/schema/attending.js';
import { formatSportsTitle, formatSportsSubtitle } from './enrich.js';
import { looksLikeJunkVenue } from './match.js';
import type { SportsGameMatch } from '../sports/types.js';

// ─── Title/subtitle backfill ────────────────────────────────────────

export interface NormalizeSportsTitlesOptions {
  dryRun?: boolean;
  limit?: number;
}

export interface NormalizeSportsTitlesResult {
  scanned: number;
  updated: number;
  skipped_no_event_data: number;
  samples: Array<{
    id: number;
    event_date: string;
    old_title: string | null;
    new_title: string;
    new_subtitle: string | null;
  }>;
}

export async function normalizeSportsTitles(
  db: Database,
  opts: NormalizeSportsTitlesOptions = {}
): Promise<NormalizeSportsTitlesResult> {
  const { dryRun = false, limit = 1000 } = opts;
  const result: NormalizeSportsTitlesResult = {
    scanned: 0,
    updated: 0,
    skipped_no_event_data: 0,
    samples: [],
  };

  const rows = await db
    .select({
      id: attendedEvents.id,
      event_date: attendedEvents.eventDate,
      title: attendedEvents.title,
      subtitle: attendedEvents.subtitle,
      event_data: attendedEvents.eventData,
    })
    .from(attendedEvents)
    .where(
      and(
        eq(attendedEvents.userId, 1),
        eq(attendedEvents.category, 'sports'),
        isNotNull(attendedEvents.externalSource)
      )
    )
    .limit(limit);

  for (const row of rows) {
    result.scanned++;
    if (!row.event_data) {
      result.skipped_no_event_data++;
      continue;
    }
    const ed = safeJson(row.event_data);
    const home = (ed as Record<string, unknown>)?.home_team as
      | { id?: number; name?: string }
      | undefined;
    const away = (ed as Record<string, unknown>)?.away_team as
      | { id?: number; name?: string }
      | undefined;
    if (!home?.name || !away?.name) {
      result.skipped_no_event_data++;
      continue;
    }
    const fakeMatch = {
      home_team: { id: home.id ?? 0, name: home.name },
      away_team: { id: away.id ?? 0, name: away.name },
      home_score: (ed as Record<string, unknown>)?.home_score as
        | number
        | null
        | undefined,
      away_score: (ed as Record<string, unknown>)?.away_score as
        | number
        | null
        | undefined,
    } as Pick<
      SportsGameMatch,
      'home_team' | 'away_team' | 'home_score' | 'away_score'
    > as SportsGameMatch;

    const newTitle = formatSportsTitle(fakeMatch);
    const newSubtitle = formatSportsSubtitle(fakeMatch);

    if (row.title === newTitle && row.subtitle === newSubtitle) {
      continue; // already canonical
    }

    if (result.samples.length < 20) {
      result.samples.push({
        id: row.id,
        event_date: row.event_date,
        old_title: row.title,
        new_title: newTitle,
        new_subtitle: newSubtitle,
      });
    }

    if (!dryRun) {
      await db
        .update(attendedEvents)
        .set({
          title: newTitle,
          subtitle: newSubtitle,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(attendedEvents.id, row.id));
    }
    result.updated++;
  }

  return result;
}

// ─── Venue pruning ──────────────────────────────────────────────────

/**
 * Map "home team name" → seeded venue id for known sports venues.
 * Used when we know who played but the existing venue_id points at a
 * junk row; we'd rather fall back to the canonical home venue than
 * leave the bad venue in place.
 */
const HOME_TEAM_TO_VENUE_NAME: Record<string, string> = {
  'Seattle Mariners': 'T-Mobile Park',
  'Seattle Seahawks': 'Lumen Field',
  'Seattle Sounders FC': 'Lumen Field',
  'Seattle Storm': 'Climate Pledge Arena',
  'Washington Huskies': 'Husky Stadium',
};

export interface PruneJunkVenuesOptions {
  dryRun?: boolean;
}

export interface PruneJunkVenuesResult {
  junk_venues: Array<{ id: number; name: string; events_repointed: number }>;
  events_repointed: number;
  events_orphaned: number;
  venues_deleted: number;
}

export async function pruneJunkVenues(
  db: Database,
  opts: PruneJunkVenuesOptions = {}
): Promise<PruneJunkVenuesResult> {
  const { dryRun = false } = opts;
  const result: PruneJunkVenuesResult = {
    junk_venues: [],
    events_repointed: 0,
    events_orphaned: 0,
    venues_deleted: 0,
  };

  const allVenues = await db.select().from(venues);
  const realVenues = new Map<string, number>();
  for (const v of allVenues) {
    if (!looksLikeJunkVenue(v.name)) {
      realVenues.set(v.name, v.id);
    }
  }

  const junk = allVenues.filter((v) => looksLikeJunkVenue(v.name));
  for (const v of junk) {
    // Find events pointing at this junk venue.
    const events = await db
      .select({
        id: attendedEvents.id,
        event_data: attendedEvents.eventData,
        category: attendedEvents.category,
      })
      .from(attendedEvents)
      .where(eq(attendedEvents.venueId, v.id));

    let repointed = 0;
    for (const ev of events) {
      if (ev.category === 'sports' && ev.event_data) {
        const ed = safeJson(ev.event_data) as Record<string, unknown> | null;
        const home = ed?.home_team as { name?: string } | undefined;
        const homeName = home?.name;
        if (homeName && HOME_TEAM_TO_VENUE_NAME[homeName]) {
          const targetVenueName = HOME_TEAM_TO_VENUE_NAME[homeName];
          const targetVenueId = realVenues.get(targetVenueName);
          if (targetVenueId) {
            if (!dryRun) {
              await db
                .update(attendedEvents)
                .set({
                  venueId: targetVenueId,
                  updatedAt: new Date().toISOString(),
                })
                .where(eq(attendedEvents.id, ev.id));
            }
            repointed++;
            result.events_repointed++;
            continue;
          }
        }
      }
      // No sports match or unknown home team — orphan the event
      // (NULL venue_id) rather than leave the junk pointer.
      if (!dryRun) {
        await db
          .update(attendedEvents)
          .set({ venueId: null, updatedAt: new Date().toISOString() })
          .where(eq(attendedEvents.id, ev.id));
      }
      result.events_orphaned++;
    }

    // Every event has either been repointed or had its venue_id set
    // to NULL above, so the junk venue row is now safe to delete.
    if (!dryRun) {
      await db.delete(venues).where(eq(venues.id, v.id));
      result.venues_deleted++;
    }

    result.junk_venues.push({
      id: v.id,
      name: v.name,
      events_repointed: repointed,
    });
  }

  return result;
}

// ─── Duplicate merging ──────────────────────────────────────────────

export interface MergeDuplicatesOptions {
  dryRun?: boolean;
}

export interface MergeDuplicatesResult {
  pairs_found: number;
  pairs_merged: number;
  events_deleted: number;
  pairs: Array<{
    enriched_id: number;
    junk_id: number;
    event_date: string;
    junk_title: string | null;
  }>;
}

/**
 * Find pairs of attended_events with matching (user_id, event_date,
 * event_type) where one row has external_source set (canonical match)
 * and another doesn't. The unmatched row is the junk duplicate —
 * usually a calendar entry or email that didn't pipe through the
 * sports enricher. Migrate any unique sources/tickets to the enriched
 * row, then hard-delete the junk one.
 */
export async function mergeSportsDuplicates(
  db: Database,
  opts: MergeDuplicatesOptions = {}
): Promise<MergeDuplicatesResult> {
  const { dryRun = false } = opts;
  const result: MergeDuplicatesResult = {
    pairs_found: 0,
    pairs_merged: 0,
    events_deleted: 0,
    pairs: [],
  };

  const sports = await db
    .select({
      id: attendedEvents.id,
      event_date: attendedEvents.eventDate,
      event_type: attendedEvents.eventType,
      external_source: attendedEvents.externalSource,
      title: attendedEvents.title,
    })
    .from(attendedEvents)
    .where(
      and(eq(attendedEvents.userId, 1), eq(attendedEvents.category, 'sports'))
    );

  // Group by (event_date, event_type). Pairs of interest are groups
  // with exactly one enriched row and 1+ unenriched rows.
  const byKey = new Map<string, typeof sports>();
  for (const row of sports) {
    const key = `${row.event_date}|${row.event_type}`;
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }

  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    const enriched = group.filter((r) => r.external_source != null);
    const unenriched = group.filter((r) => r.external_source == null);
    if (enriched.length !== 1 || unenriched.length === 0) continue;
    const keep = enriched[0];

    for (const dup of unenriched) {
      result.pairs_found++;
      result.pairs.push({
        enriched_id: keep.id,
        junk_id: dup.id,
        event_date: dup.event_date,
        junk_title: dup.title,
      });
      if (dryRun) continue;

      // Migrate child rows: tickets, performers (rare for sports), sources, players.
      await db
        .update(attendedEventTickets)
        .set({ eventId: keep.id })
        .where(eq(attendedEventTickets.eventId, dup.id));
      await db
        .update(attendedEventPerformers)
        .set({ eventId: keep.id })
        .where(eq(attendedEventPerformers.eventId, dup.id));
      await db
        .update(attendedEventSources)
        .set({ eventId: keep.id })
        .where(eq(attendedEventSources.eventId, dup.id));
      await db
        .update(attendedEventPlayers)
        .set({ eventId: keep.id })
        .where(eq(attendedEventPlayers.eventId, dup.id));

      await db.delete(attendedEvents).where(eq(attendedEvents.id, dup.id));
      result.events_deleted++;
      result.pairs_merged++;
    }
  }

  return result;
}

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

// Drizzle helpers we don't use here but want surfaced for callers
// that import from this module:
void inArray;
void isNull;
void sql;
