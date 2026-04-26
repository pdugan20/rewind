// Loader: takes an enriched CanonicalEvent and writes it to
// attended_events (insert or update by dedupe key). Handles tickets,
// performers, and source-row linkage in the same call.
//
// Dedupe key, in priority order:
//   1. (external_source, external_id) — sports games with a confirmed
//      MLB Stats / ESPN match.
//   2. (user_id, event_date, venue_id) — fallback for events without
//      external IDs (concerts, calendar-only candidates).
//
// On match, the existing row is UPDATEd with merged fields (candidate
// non-null values fill existing null slots; existing values stay
// otherwise). This makes the loader idempotent — re-running over the
// same candidate produces the same row, and a second pass with new
// data (e.g., calendar entry first run, ticket email second run)
// enriches the existing row instead of duplicating.

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  attendedEvents,
  attendedEventSources,
  attendedEventTickets,
  attendedEventPerformers,
  venues,
} from '../../db/schema/attending.js';
import { insertFeedItem } from '../../routes/feed.js';
import type { CanonicalEvent } from './enrich.js';
import { feedItemFromCanonical } from './feed-items.js';
import type { ParsedReservation } from './parse-jsonld.js';

export interface LoadResult {
  event_id: number;
  action: 'inserted' | 'updated' | 'noop';
  ticket_inserts: number;
  performer_inserts: number;
}

/**
 * Find existing attended_events row matching this canonical event. The
 * dedupe key uses external_source+external_id when available, falling
 * back to user_id+event_date+venue_id.
 */
export async function findExistingEvent(
  canonical: CanonicalEvent,
  db: Database
): Promise<{ id: number } | null> {
  // Path 1: confirmed sports/concert match by external id
  if (canonical.external_source && canonical.external_id) {
    const [row] = await db
      .select({ id: attendedEvents.id })
      .from(attendedEvents)
      .where(
        and(
          eq(attendedEvents.userId, 1),
          eq(attendedEvents.externalSource, canonical.external_source),
          eq(attendedEvents.externalId, canonical.external_id)
        )
      )
      .limit(1);
    if (row) return row;
  }

  // Path 2: dedupe key (user_id, event_date, venue_id)
  if (canonical.venue_id != null) {
    const [row] = await db
      .select({ id: attendedEvents.id })
      .from(attendedEvents)
      .where(
        and(
          eq(attendedEvents.userId, 1),
          eq(attendedEvents.eventDate, canonical.event_date),
          eq(attendedEvents.venueId, canonical.venue_id)
        )
      )
      .limit(1);
    if (row) return row;
  }

  return null;
}

/**
 * Load a canonical event. INSERT or UPDATE based on dedupe match.
 * Inserts ticket and performer rows. Returns the event_id and counts.
 */
export async function loadCanonicalEvent(
  canonical: CanonicalEvent,
  tickets: ParsedReservation[],
  sourceRefs: Array<{
    source_type: 'gcal' | 'gmail' | 'manual';
    source_ref: string;
  }>,
  db: Database
): Promise<LoadResult> {
  const now = new Date().toISOString();
  const existing = await findExistingEvent(canonical, db);

  let eventId: number;
  let action: 'inserted' | 'updated';

  if (existing) {
    // Merge: only fill nulls / overwrite when candidate has
    // strictly-better info. Drizzle UPDATE with sql expressions for
    // COALESCE-style updates.
    await db
      .update(attendedEvents)
      .set({
        // Take candidate values when they're non-null; otherwise
        // keep existing.
        eventDatetime: sql`coalesce(${canonical.event_datetime}, ${attendedEvents.eventDatetime})`,
        venueId: sql`coalesce(${canonical.venue_id}, ${attendedEvents.venueId})`,
        externalId: sql`coalesce(${canonical.external_id}, ${attendedEvents.externalId})`,
        externalSource: sql`coalesce(${canonical.external_source}, ${attendedEvents.externalSource})`,
        // event_data: prefer non-empty candidate over existing
        eventData:
          Object.keys(canonical.event_data).length > 0
            ? JSON.stringify(canonical.event_data)
            : sql`${attendedEvents.eventData}`,
        // Don't overwrite title/subtitle/notes — user may have
        // hand-edited those.
        updatedAt: now,
      })
      .where(eq(attendedEvents.id, existing.id));
    eventId = existing.id;
    action = 'updated';
  } else {
    const [created] = await db
      .insert(attendedEvents)
      .values({
        userId: 1,
        category:
          canonical.category === 'unknown' ? 'arts' : canonical.category,
        eventType: canonical.event_type,
        eventDate: canonical.event_date,
        eventDatetime: canonical.event_datetime,
        venueId: canonical.venue_id,
        title: canonical.title,
        subtitle: canonical.subtitle,
        externalId: canonical.external_id,
        externalSource: canonical.external_source,
        eventData:
          Object.keys(canonical.event_data).length > 0
            ? JSON.stringify(canonical.event_data)
            : null,
        attended: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: attendedEvents.id });
    eventId = created.id;
    action = 'inserted';
  }

  // Performers (concerts only — sports doesn't use this table)
  let performerInserts = 0;
  for (const p of canonical.performers) {
    const result = await db
      .insert(attendedEventPerformers)
      .values({
        eventId,
        performerId: p.performer_id,
        role: p.role as 'headliner' | 'opener' | 'support' | 'guest' | 'mc',
      })
      .onConflictDoNothing({
        target: [
          attendedEventPerformers.eventId,
          attendedEventPerformers.performerId,
        ],
      })
      .returning({ eventId: attendedEventPerformers.eventId });
    if (result.length > 0) performerInserts++;
  }

  // Tickets — one row per parsed reservation. Idempotent via the
  // (vendor, order_id) unique index when both present; otherwise
  // duplicates can sneak in (acceptable, manual cleanup).
  let ticketInserts = 0;
  for (const t of tickets) {
    if (!t.vendor || t.vendor === 'unknown') continue;
    const result = await db
      .insert(attendedEventTickets)
      .values({
        userId: 1,
        eventId,
        vendor: t.vendor as
          | 'ticketmaster'
          | 'seatgeek'
          | 'ticketclub'
          | 'axs'
          | 'stubhub'
          | 'vivid_seats'
          | 'box_office'
          | 'comp'
          | 'paper'
          | 'manual',
        orderId: t.reservation_number,
        section: t.section,
        row: t.row,
        seat: t.seat,
        totalPriceCents: t.total_price_cents,
        currency: t.currency,
        sourceType: 'gmail',
        createdAt: now,
      })
      .onConflictDoNothing({
        target: [attendedEventTickets.vendor, attendedEventTickets.orderId],
      })
      .returning({ id: attendedEventTickets.id });
    if (result.length > 0) ticketInserts++;
  }

  // Link source rows back to the canonical event. UPDATE existing
  // attended_event_sources rows (inserted by extract phase) to set
  // their event_id pointer.
  for (const s of sourceRefs) {
    await db
      .update(attendedEventSources)
      .set({ eventId })
      .where(
        and(
          eq(attendedEventSources.sourceType, s.source_type),
          eq(attendedEventSources.sourceRef, s.source_ref)
        )
      );
  }

  // Cross-domain feed integration. Insert a row in activity_feed
  // keyed on `attending:event:{id}` so this event shows up in the
  // unified /v1/feed and /v1/feed/on-this-day surfaces alongside
  // scrobbles/runs/watches/articles. Idempotent — re-running this
  // path no-ops via the (domain, source_id) unique index.
  let venueName: string | null = null;
  if (canonical.venue_id != null) {
    const [v] = await db
      .select({ name: venues.name })
      .from(venues)
      .where(eq(venues.id, canonical.venue_id))
      .limit(1);
    if (v) venueName = v.name;
  }
  try {
    await insertFeedItem(
      db,
      feedItemFromCanonical(eventId, canonical, venueName)
    );
  } catch (err) {
    // Non-fatal — feed insert mirrors the lastfm/strava patterns where
    // failures are logged but don't block the canonical write.
    console.log(
      `[WARN] attending feed insert failed for event ${eventId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return {
    event_id: eventId,
    action,
    ticket_inserts: ticketInserts,
    performer_inserts: performerInserts,
  };
}
