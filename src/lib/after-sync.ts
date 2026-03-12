/**
 * Post-sync hook that populates activity feed, search index,
 * and fires revalidation hooks after any domain sync completes.
 *
 * Sync services call afterSync() with explicit items rather than
 * querying back, since sync functions don't track what was new.
 */

import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import { revalidationHooks } from '../db/schema/system.js';
import { insertFeedItems } from '../routes/feed.js';
import { upsertSearchIndexBatch } from '../routes/search.js';

type Database = ReturnType<typeof drizzle>;

export interface FeedItem {
  domain: string;
  eventType: string;
  occurredAt: string;
  title: string;
  subtitle?: string;
  imageKey?: string;
  sourceId: string;
  metadata?: Record<string, unknown>;
}

export interface SearchItem {
  domain: string;
  entityType: string;
  entityId: string;
  title: string;
  subtitle?: string;
  imageKey?: string;
}

export interface AfterSyncInput {
  domain: string;
  feedItems?: FeedItem[];
  searchItems?: SearchItem[];
}

/**
 * Run all post-sync side effects: feed insert, search index, revalidation hooks.
 * Each step is non-fatal — failures are logged but don't block the others.
 */
export async function afterSync(
  db: Database,
  input: AfterSyncInput
): Promise<void> {
  const { domain, feedItems, searchItems } = input;

  // 1. Insert feed items
  if (feedItems && feedItems.length > 0) {
    try {
      await insertFeedItems(db, feedItems);
    } catch (error) {
      console.log(
        `[ERROR] Feed insert failed for ${domain}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 2. Update search index
  if (searchItems && searchItems.length > 0) {
    try {
      await upsertSearchIndexBatch(db, searchItems);
    } catch (error) {
      console.log(
        `[ERROR] Search index update failed for ${domain}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 3. Fire revalidation hooks
  try {
    await fireRevalidationHooks(db, domain);
  } catch (error) {
    console.log(
      `[ERROR] Revalidation hooks failed for ${domain}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Fire revalidation hooks for a given domain.
 * Queries all active hooks for the domain and POSTs to each URL.
 */
async function fireRevalidationHooks(
  db: Database,
  domain: string
): Promise<void> {
  const hooks = await db
    .select()
    .from(revalidationHooks)
    .where(
      and(
        eq(revalidationHooks.domain, domain),
        eq(revalidationHooks.isActive, 1)
      )
    );

  for (const hook of hooks) {
    try {
      await fetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Revalidation-Secret': hook.secret,
        },
        body: JSON.stringify({
          domain,
          timestamp: new Date().toISOString(),
        }),
      });
      console.log(`[SYNC] Revalidation hook fired: ${hook.url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[ERROR] Revalidation hook failed: ${hook.url} - ${message}`);
    }
  }
}
