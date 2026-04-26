// One-shot backfill that walks attended_events and writes a row in
// activity_feed for each. Used after the activity-feed integration
// PR ships to populate historical events; new events get feed rows
// inline via loadCanonicalEvent.
//
// Idempotent — insertFeedItems dedupes on (domain, source_id), so
// re-running is safe.

import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { attendedEvents, venues } from '../../db/schema/attending.js';
import { activityFeed } from '../../db/schema/system.js';
import { insertFeedItems } from '../../routes/feed.js';
import { feedItemFromRow } from './feed-items.js';

export interface BackfillFeedOptions {
  limit?: number;
  dryRun?: boolean;
}

export interface BackfillFeedResult {
  scanned: number;
  inserted: number;
  skipped: number;
}

export async function backfillAttendingFeed(
  db: Database,
  opts: BackfillFeedOptions = {}
): Promise<BackfillFeedResult> {
  const { limit = 2000, dryRun = false } = opts;

  const rows = await db
    .select({
      id: attendedEvents.id,
      category: attendedEvents.category,
      event_type: attendedEvents.eventType,
      event_date: attendedEvents.eventDate,
      event_datetime: attendedEvents.eventDatetime,
      title: attendedEvents.title,
      subtitle: attendedEvents.subtitle,
      attended: attendedEvents.attended,
      event_data: attendedEvents.eventData,
      venue_name: venues.name,
    })
    .from(attendedEvents)
    .leftJoin(venues, eq(venues.id, attendedEvents.venueId))
    .where(eq(attendedEvents.userId, 1))
    .limit(limit);

  if (dryRun) {
    return { scanned: rows.length, inserted: 0, skipped: rows.length };
  }

  const items = rows.map((r) =>
    feedItemFromRow({
      id: r.id,
      category: r.category,
      event_type: r.event_type,
      event_date: r.event_date,
      event_datetime: r.event_datetime,
      title: r.title,
      subtitle: r.subtitle,
      attended: r.attended,
      venue_name: r.venue_name ?? null,
      event_data: r.event_data ? safeJson(r.event_data) : null,
    })
  );

  // Pre-count what's already in the feed so we can report
  // inserted vs skipped — insertFeedItems dedupes silently and returns
  // void, so we mirror its lookup here.
  const sourceIds = items.map((i) => i.sourceId);
  const existing = sourceIds.length
    ? await db
        .select({ source_id: activityFeed.sourceId })
        .from(activityFeed)
        .where(
          and(
            eq(activityFeed.domain, 'attending'),
            inArray(activityFeed.sourceId, sourceIds)
          )
        )
    : [];
  const existingSet = new Set(existing.map((e) => e.source_id));
  const inserted = items.filter((i) => !existingSet.has(i.sourceId)).length;

  await insertFeedItems(db, items);

  return {
    scanned: rows.length,
    inserted,
    skipped: rows.length - inserted,
  };
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}
