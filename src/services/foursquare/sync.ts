import { eq, sql } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import { checkins } from '../../db/schema/places.js';
import { syncRuns } from '../../db/schema/system.js';
import { FoursquareClient, type FoursquareCheckin } from './client.js';
import { afterSync } from '../../lib/after-sync.js';
import type { FeedItem, SearchItem } from '../../lib/after-sync.js';
import type { Env } from '../../types/env.js';

const PAGE_SIZE = 250;
const DEFAULT_MAX_PAGES = 8;

export interface SyncedCheckin {
  foursquareId: string;
  venueId: string;
  venueName: string;
  venueCity: string | null;
  checkedInAt: string;
}

export function buildCheckinFeedItem(c: SyncedCheckin): FeedItem {
  return {
    domain: 'places',
    eventType: 'checkin',
    occurredAt: c.checkedInAt,
    title: `Checked in at ${c.venueName}`,
    sourceId: `foursquare:checkin:${c.foursquareId}`,
  };
}

/**
 * Primary category name, falling back to the first listed category.
 */
function primaryCategory(item: FoursquareCheckin): string | null {
  const categories = item.venue?.categories;
  if (!categories || categories.length === 0) return null;
  return (categories.find((c) => c.primary) ?? categories[0]).name;
}

export interface CheckinSyncOptions {
  maxPages?: number;
}

export interface CheckinSyncResult {
  synced: number;
  skipped: number;
  remaining: number;
  newCheckins: SyncedCheckin[];
}

/**
 * Bounded, resumable oldest-first walk of the Foursquare checkin history.
 *
 * The cursor is simply the local COUNT of stored checkins for the user:
 * `sort=oldestfirst` + offset means an interrupted batch resumes exactly
 * where it stopped. Legacy checkins with no venue are skipped without
 * insert, so the cursor can lag the API offset slightly — the resulting
 * overlap re-fetch is deduplicated by the unique foursquare_id index,
 * with `meta.changes` guarding the counts (the episode-sync lesson).
 */
export async function syncCheckins(
  db: Database,
  client: FoursquareClient,
  userId: number,
  options: CheckinSyncOptions = {}
): Promise<CheckinSyncResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  const [cursor] = await db
    .select({ count: sql<number>`count(*)` })
    .from(checkins)
    .where(eq(checkins.userId, userId));
  let offset = cursor?.count ?? 0;

  console.log(`[SYNC] Foursquare checkins walk from offset ${offset}`);

  let synced = 0;
  let skipped = 0;
  let total = offset;
  const newCheckins: SyncedCheckin[] = [];

  for (let page = 0; page < maxPages; page++) {
    const result = await client.getCheckins({ offset, limit: PAGE_SIZE });
    total = result.count;
    if (result.items.length === 0) break;

    for (const item of result.items) {
      const venue = item.venue;
      if (!venue) {
        console.log(`[INFO] Skipping checkin ${item.id} - no venue`);
        skipped++;
        continue;
      }

      const checkedInAt = new Date(item.createdAt * 1000).toISOString();
      const insertResult = await db
        .insert(checkins)
        .values({
          userId,
          foursquareId: item.id,
          venueId: venue.id,
          venueName: venue.name,
          venueCategory: primaryCategory(item),
          venueCity: venue.location?.city ?? null,
          venueState: venue.location?.state ?? null,
          venueCountry: venue.location?.country ?? null,
          lat: venue.location?.lat ?? null,
          lng: venue.location?.lng ?? null,
          checkedInAt,
          shout: item.shout ?? null,
        })
        .onConflictDoNothing();

      // Conflict on idx_checkins_foursquare_id: an overlap re-fetch of an
      // already-stored checkin. Count it as skipped for truthful totals.
      if (insertResult.meta.changes === 0) {
        skipped++;
        continue;
      }

      newCheckins.push({
        foursquareId: item.id,
        venueId: venue.id,
        venueName: venue.name,
        venueCity: venue.location?.city ?? null,
        checkedInAt,
      });
      synced++;
    }

    offset += result.items.length;
    if (offset >= total) break;
  }

  const remaining = Math.max(0, total - offset);
  return { synced, skipped, remaining, newCheckins };
}

/**
 * Places domain sync entrypoint: bounded Foursquare checkin batch with
 * sync_runs lifecycle and feed/search side effects. Returns remaining so
 * the admin route's caller can loop until 0.
 */
export async function syncPlaces(
  env: Env,
  options: CheckinSyncOptions = {},
  userId: number = 1
): Promise<{ synced: number; remaining: number }> {
  const db = createDb(env.DB);
  const startedAt = new Date().toISOString();

  const [run] = await db
    .insert(syncRuns)
    .values({
      userId,
      domain: 'places',
      syncType: 'foursquare',
      status: 'running',
      startedAt,
      itemsSynced: 0,
    })
    .returning({ id: syncRuns.id });

  try {
    const accessToken = env.FOURSQUARE_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error('FOURSQUARE_ACCESS_TOKEN is not configured');
    }
    const client = new FoursquareClient(accessToken);

    const result = await syncCheckins(db, client, userId, options);

    await db
      .update(syncRuns)
      .set({
        status: 'completed',
        completedAt: new Date().toISOString(),
        itemsSynced: result.synced,
        metadata: JSON.stringify({
          skipped: result.skipped,
          remaining: result.remaining,
        }),
      })
      .where(eq(syncRuns.id, run.id));

    const feedItems: FeedItem[] = result.newCheckins.map(buildCheckinFeedItem);
    // One search item per venue: upsertSearchIndexBatch replaces on
    // (domain, entity_type, entity_id), so cross-run repeats are safe —
    // dedup here only avoids same-batch churn.
    const seenVenues = new Set<string>();
    const searchItems: SearchItem[] = [];
    for (const c of result.newCheckins) {
      if (seenVenues.has(c.venueId)) continue;
      seenVenues.add(c.venueId);
      searchItems.push({
        domain: 'places',
        entityType: 'venue',
        entityId: c.venueId,
        title: c.venueName,
        subtitle: c.venueCity ?? undefined,
      });
    }
    await afterSync(db, { domain: 'places', feedItems, searchItems });

    console.log(
      `[SYNC] Foursquare checkin batch complete: ${result.synced} synced, ${result.skipped} skipped, ${result.remaining} remaining`
    );
    return { synced: result.synced, remaining: result.remaining };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] Foursquare sync failed: ${errorMsg}`);
    await db
      .update(syncRuns)
      .set({
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: errorMsg,
      })
      .where(eq(syncRuns.id, run.id));
    throw err;
  }
}
