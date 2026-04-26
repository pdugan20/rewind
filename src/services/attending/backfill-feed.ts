// One-shot backfill that walks attended_events and writes a row in
// activity_feed for each. Used after the activity-feed integration
// PR ships to populate historical events; new events get feed rows
// inline via loadCanonicalEvent.
//
// Idempotent — insertFeedItems dedupes on (domain, source_id), so
// re-running is safe.

import { eq, sql } from 'drizzle-orm';
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

  // insertFeedItems handles its own internal chunking for both the
  // dedupe SELECT and the INSERT VALUES under D1's param cap. We
  // don't track inserted-vs-skipped for the response — the helper
  // returns void. Callers who need the split can re-query feed
  // counts before/after.
  const before = await countAttendingFeedRows(db);
  await insertFeedItems(db, items);
  const after = await countAttendingFeedRows(db);
  const inserted = after - before;

  return {
    scanned: rows.length,
    inserted,
    skipped: rows.length - inserted,
  };
}

async function countAttendingFeedRows(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(activityFeed)
    .where(eq(activityFeed.domain, 'attending'));
  return row?.count ?? 0;
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}
