// Convert attended events into activity-feed rows. The cross-domain
// /v1/feed endpoint reads from the unified `activity_feed` table; each
// domain is responsible for inserting its own items via `afterSync` /
// `insertFeedItems` after a sync (or on demand).
//
// Source-id discipline: every feed row dedupes on (domain, source_id),
// so we use a stable per-event key — `attending:event:{id}`. Re-running
// the backfill (or re-loading the same event) is idempotent.

import type { FeedItem } from '../../lib/after-sync.js';
import type { CanonicalEvent } from './enrich.js';

interface AttendedEventRow {
  id: number;
  category: string;
  event_type: string;
  event_date: string;
  event_datetime: string | null;
  title: string;
  subtitle: string | null;
  attended: number; // 0/1
  venue_name: string | null;
  event_data: Record<string, unknown> | null;
}

/**
 * Build a feed item from a freshly-loaded canonical event. Used inline
 * by `loadCanonicalEvent` so the activity feed is up to date the
 * moment a new event lands.
 */
export function feedItemFromCanonical(
  eventId: number,
  canonical: CanonicalEvent,
  venueName: string | null
): FeedItem {
  return formatFeedItem({
    id: eventId,
    category: canonical.category,
    event_type: canonical.event_type,
    event_date: canonical.event_date,
    event_datetime: canonical.event_datetime,
    title: canonical.title,
    subtitle: canonical.subtitle,
    attended: 1,
    venue_name: venueName,
    event_data: canonical.event_data,
  });
}

/**
 * Build a feed item from a stored event row (used by the backfill
 * endpoint that walks existing rows in attended_events).
 */
export function feedItemFromRow(row: AttendedEventRow): FeedItem {
  return formatFeedItem(row);
}

function formatFeedItem(ev: AttendedEventRow): FeedItem {
  // occurredAt: prefer the precise event_datetime when present,
  // otherwise the date-only event_date with midday fallback so it
  // sorts cleanly against scrobbles/runs/watches in the feed.
  const occurredAt =
    ev.event_datetime && /T\d{2}:\d{2}/.test(ev.event_datetime)
      ? ev.event_datetime
      : `${ev.event_date}T12:00:00.000Z`;

  // Title: lead with category-appropriate verb. Sports → "Saw Mariners
  // vs Astros" etc.; concerts → "Saw Glass Animals". Keep the actual
  // matchup/show name in the title body so the feed row reads
  // self-contained without venue.
  const verb = verbForCategory(ev.category);
  const title = `${verb} ${ev.title}`;

  // Subtitle: prefer the score line (event.subtitle is "Mariners 4,
  // Astros 2" for sports). Fall back to venue name; empty otherwise.
  const subtitle = ev.subtitle ?? ev.venue_name ?? undefined;

  // Useful for downstream consumers who want richer rendering without
  // joining back to the canonical row.
  const metadata: Record<string, unknown> = {
    event_type: ev.event_type,
    venue: ev.venue_name,
    attended: ev.attended === 1,
  };
  if (ev.event_data && typeof ev.event_data === 'object') {
    const ed = ev.event_data as Record<string, unknown>;
    if (ed.my_team_won != null) metadata.my_team_won = ed.my_team_won;
    if (ed.attendance != null) metadata.attendance = ed.attendance;
  }

  return {
    domain: 'attending',
    eventType: eventTypeForFeed(ev.event_type, ev.attended === 1),
    occurredAt,
    title,
    subtitle,
    sourceId: `event:${ev.id}`,
    metadata,
  };
}

function verbForCategory(category: string): string {
  switch (category) {
    case 'sports':
      return 'Saw';
    case 'music':
      return 'Saw';
    case 'arts':
      return 'Attended';
    default:
      return 'Attended';
  }
}

function eventTypeForFeed(_eventType: string, attended: boolean): string {
  // Distinguish no-shows so consumers can filter / style differently.
  // Most events use `event_attended` to mirror the existing one-noun
  // pattern from listening (`new_artist`, `new_album`). The first arg
  // is plumbed for future use (e.g. concert vs game styling) but
  // currently unused.
  if (!attended) return 'event_missed';
  return 'event_attended';
}
