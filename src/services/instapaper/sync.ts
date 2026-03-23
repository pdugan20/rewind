/**
 * Instapaper sync worker.
 * Syncs bookmarks, highlights, and metadata from Instapaper into D1.
 */

import { eq, and, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { readingItems, readingHighlights } from '../../db/schema/reading.js';
import { syncRuns } from '../../db/schema/system.js';
import { InstapaperClient, type InstapaperBookmark } from './client.js';
import {
  transformBookmark,
  computeWordCount,
  deriveStatus,
} from './transforms.js';
import { afterSync } from '../../lib/after-sync.js';
import type { FeedItem, SearchItem } from '../../lib/after-sync.js';

interface SyncResult {
  itemsSynced: number;
  highlightsSynced: number;
  newArticles: number;
}

// ─── Sync run tracking ──────────────────────────────────────────────

async function startSyncRun(db: Database): Promise<number> {
  const result = await db
    .insert(syncRuns)
    .values({
      domain: 'reading',
      syncType: 'bookmarks',
      status: 'running',
      startedAt: new Date().toISOString(),
    })
    .returning({ id: syncRuns.id });
  return result[0].id;
}

async function completeSyncRun(
  db: Database,
  runId: number,
  itemsSynced: number,
  metadata?: string
): Promise<void> {
  await db
    .update(syncRuns)
    .set({
      status: 'completed',
      completedAt: new Date().toISOString(),
      itemsSynced,
      metadata,
    })
    .where(eq(syncRuns.id, runId));
}

async function failSyncRun(
  db: Database,
  runId: number,
  error: string
): Promise<void> {
  await db
    .update(syncRuns)
    .set({
      status: 'failed',
      completedAt: new Date().toISOString(),
      error,
    })
    .where(eq(syncRuns.id, runId));
}

// ─── OG metadata extraction ─────────────────────────────────────────

interface OgMetadata {
  ogImage: string | null;
  siteName: string | null;
  author: string | null;
  publishedAt: string | null;
  ogDescription: string | null;
  articleTags: string | null;
}

async function fetchOgMetadata(url: string): Promise<OgMetadata> {
  const result: OgMetadata = {
    ogImage: null,
    siteName: null,
    author: null,
    publishedAt: null,
    ogDescription: null,
    articleTags: null,
  };
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
    });
    if (!response.ok) return result;

    // Read only the first 50KB to find the <head> section
    const reader = response.body?.getReader();
    if (!reader) return result;

    let html = '';
    const decoder = new TextDecoder();
    while (html.length < 50000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.includes('</head>')) break;
    }
    reader.cancel();

    // Helper to extract meta content
    const getMeta = (property: string): string | null => {
      const re1 = new RegExp(
        `<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']+)["']`,
        'i'
      );
      const re2 = new RegExp(
        `<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${property}["']`,
        'i'
      );
      return html.match(re1)?.[1] ?? html.match(re2)?.[1] ?? null;
    };

    result.ogImage = getMeta('og:image');
    result.siteName = getMeta('og:site_name');
    result.ogDescription = getMeta('og:description');
    result.publishedAt =
      getMeta('article:published_time') ??
      getMeta('datePublished') ??
      getMeta('date');
    result.author =
      getMeta('author') ?? getMeta('article:author') ?? getMeta('byl');

    // Article tags/section
    const section = getMeta('article:section');
    const tags: string[] = [];
    if (section) tags.push(section);
    const tagRegex =
      /<meta[^>]*(?:property|name)=["']article:tag["'][^>]*content=["']([^"']+)["']/gi;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(html)) !== null) {
      tags.push(tagMatch[1]);
    }
    result.articleTags = tags.length > 0 ? JSON.stringify(tags) : null;
  } catch {
    // Non-fatal — article may be behind a paywall or unavailable
  }
  return result;
}

// ─── Core sync ──────────────────────────────────────────────────────

/**
 * Upsert a single bookmark into reading_items.
 * Returns { id, isNew } for feed/search integration.
 */
async function upsertBookmark(
  db: Database,
  bookmark: InstapaperBookmark,
  folder: string
): Promise<{ id: number; isNew: boolean }> {
  const transformed = transformBookmark(bookmark, folder);

  // Check if exists
  const [existing] = await db
    .select({
      id: readingItems.id,
      hash: sql<string>`${readingItems.source}`, // just need the row
      startedAt: readingItems.startedAt,
      finishedAt: readingItems.finishedAt,
    })
    .from(readingItems)
    .where(
      and(
        eq(readingItems.source, 'instapaper'),
        eq(readingItems.sourceId, transformed.sourceId),
        eq(readingItems.userId, 1)
      )
    )
    .limit(1);

  if (existing) {
    // Update — preserve startedAt and finishedAt if already set
    await db
      .update(readingItems)
      .set({
        title: transformed.title,
        description: transformed.description,
        status: transformed.status,
        progress: transformed.progress,
        progressUpdatedAt: transformed.progressUpdatedAt,
        starred: transformed.starred,
        folder: transformed.folder,
        tags: transformed.tags,
        startedAt: existing.startedAt ?? transformed.startedAt,
        finishedAt: existing.finishedAt ?? transformed.finishedAt,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(readingItems.id, existing.id));

    return { id: existing.id, isNew: false };
  }

  // Insert new
  const [inserted] = await db
    .insert(readingItems)
    .values({
      ...transformed,
      userId: 1,
    })
    .returning({ id: readingItems.id });

  return { id: inserted.id, isNew: true };
}

/**
 * Enrich a new article with OG metadata and word count.
 */
async function enrichArticle(
  db: Database,
  client: InstapaperClient,
  itemId: number,
  bookmarkId: number,
  url: string | null
): Promise<void> {
  const updates: Record<string, unknown> = {};

  // Fetch OG metadata from article URL
  if (url) {
    const og = await fetchOgMetadata(url);
    if (og.siteName) updates.siteName = og.siteName;
    if (og.author) updates.author = og.author;
    if (og.ogImage) updates.ogImageUrl = og.ogImage;
    if (og.publishedAt) updates.publishedAt = og.publishedAt;
    if (og.ogDescription) updates.ogDescription = og.ogDescription;
    if (og.articleTags) updates.articleTags = og.articleTags;
  }

  // Fetch article text for word count
  try {
    const html = await client.getText(bookmarkId);
    const { wordCount, estimatedReadMin } = computeWordCount(html);
    updates.content = html;
    updates.wordCount = wordCount;
    updates.estimatedReadMin = estimatedReadMin;
  } catch {
    console.log(
      `[SYNC] Failed to get text for bookmark ${bookmarkId}, skipping word count`
    );
  }

  if (Object.keys(updates).length > 0) {
    updates.enrichmentStatus = 'completed';
    updates.enrichmentError = null;
    updates.updatedAt = new Date().toISOString();
    await db
      .update(readingItems)
      .set(updates)
      .where(eq(readingItems.id, itemId));
  } else if (url) {
    // OG fetch returned nothing — mark as failed
    await db
      .update(readingItems)
      .set({
        enrichmentStatus: 'failed',
        enrichmentError: 'No OG metadata found',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(readingItems.id, itemId));
  }
}

/**
 * Sync highlights for a bookmark.
 */
async function syncHighlights(
  db: Database,
  client: InstapaperClient,
  itemId: number,
  bookmarkId: number
): Promise<number> {
  let highlights;
  try {
    highlights = await client.listHighlights(bookmarkId);
  } catch {
    return 0;
  }

  let count = 0;
  const returnedSourceIds: string[] = [];

  for (const h of highlights) {
    const sourceId = String(h.highlight_id);
    returnedSourceIds.push(sourceId);
    await db
      .insert(readingHighlights)
      .values({
        userId: 1,
        itemId,
        sourceId,
        text: h.text,
        position: h.position,
        createdAt: new Date(h.time * 1000).toISOString(),
      })
      .onConflictDoNothing();
    count++;
  }

  // Remove highlights deleted from Instapaper
  if (returnedSourceIds.length > 0) {
    await db.delete(readingHighlights).where(
      and(
        eq(readingHighlights.itemId, itemId),
        sql`${readingHighlights.sourceId} NOT IN (${sql.join(
          returnedSourceIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      )
    );
  } else {
    // No highlights returned — delete all for this item
    await db
      .delete(readingHighlights)
      .where(eq(readingHighlights.itemId, itemId));
  }

  return count;
}

// ─── Main sync function ─────────────────────────────────────────────

export async function syncReading(
  db: Database,
  env: {
    INSTAPAPER_CONSUMER_KEY: string;
    INSTAPAPER_CONSUMER_SECRET: string;
    INSTAPAPER_ACCESS_TOKEN: string;
    INSTAPAPER_ACCESS_TOKEN_SECRET: string;
  }
): Promise<SyncResult> {
  const runId = await startSyncRun(db);

  const client = new InstapaperClient(
    env.INSTAPAPER_CONSUMER_KEY,
    env.INSTAPAPER_CONSUMER_SECRET,
    env.INSTAPAPER_ACCESS_TOKEN,
    env.INSTAPAPER_ACCESS_TOKEN_SECRET
  );

  let itemsSynced = 0;
  let highlightsSynced = 0;
  let newArticles = 0;
  const feedItems: FeedItem[] = [];
  const searchItems: SearchItem[] = [];

  try {
    // Sync each folder
    const folders: { id: string; limit: number }[] = [
      { id: 'unread', limit: 500 },
      { id: 'starred', limit: 500 },
      { id: 'archive', limit: 100 }, // Only recent archives
    ];

    for (const folder of folders) {
      console.log(
        `[SYNC] Fetching ${folder.id} bookmarks (limit ${folder.limit})`
      );
      const bookmarks = await client.listBookmarks(folder.id, folder.limit);
      console.log(`[SYNC] Got ${bookmarks.length} bookmarks from ${folder.id}`);

      for (const bookmark of bookmarks) {
        const { id, isNew } = await upsertBookmark(db, bookmark, folder.id);
        itemsSynced++;

        if (isNew) {
          newArticles++;

          // Enrich new articles with OG metadata and word count
          await enrichArticle(
            db,
            client,
            id,
            bookmark.bookmark_id,
            bookmark.url
          );

          // Feed item
          const status = deriveStatus(folder.id, bookmark.progress);
          if (status === 'finished') {
            feedItems.push({
              domain: 'reading',
              eventType: 'article_finished',
              occurredAt: new Date(bookmark.time * 1000).toISOString(),
              title: `Finished reading: ${bookmark.title}`,
              sourceId: `instapaper:${bookmark.bookmark_id}`,
            });
          } else {
            feedItems.push({
              domain: 'reading',
              eventType: 'article_saved',
              occurredAt: new Date(bookmark.time * 1000).toISOString(),
              title: `Saved: ${bookmark.title}`,
              sourceId: `instapaper:${bookmark.bookmark_id}`,
            });
          }

          // Search item
          searchItems.push({
            domain: 'reading',
            entityType: 'article',
            entityId: String(id),
            title: bookmark.title,
            subtitle: bookmark.description || undefined,
          });
        }

        // Sync highlights for all bookmarks (not just new)
        const hCount = await syncHighlights(
          db,
          client,
          id,
          bookmark.bookmark_id
        );
        highlightsSynced += hCount;
      }
    }

    // Post-sync: feed + search
    await afterSync(db, {
      domain: 'reading',
      feedItems,
      searchItems,
    });

    const metadata = JSON.stringify({
      newArticles,
      highlightsSynced,
    });
    await completeSyncRun(db, runId, itemsSynced, metadata);

    console.log(
      `[SYNC] Reading sync complete: ${itemsSynced} items, ${newArticles} new, ${highlightsSynced} highlights`
    );

    return { itemsSynced, highlightsSynced, newArticles };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failSyncRun(db, runId, message);
    console.log(`[ERROR] Reading sync failed: ${message}`);
    throw error;
  }
}
