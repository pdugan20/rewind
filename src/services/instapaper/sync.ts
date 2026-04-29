/**
 * Instapaper sync worker.
 * Syncs bookmarks, highlights, and metadata from Instapaper into D1.
 */

import { eq, and, sql, inArray, gte } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { readingItems, readingHighlights } from '../../db/schema/reading.js';
import { syncRuns } from '../../db/schema/system.js';
import {
  InstapaperClient,
  type InstapaperBookmark,
  type InstapaperHighlight,
} from './client.js';
import {
  transformBookmark,
  computeWordCount,
  deriveStatus,
} from './transforms.js';
import { afterSync } from '../../lib/after-sync.js';
import type { FeedItem, SearchItem } from '../../lib/after-sync.js';
import { htmlToText } from '../../lib/html-to-text.js';
import { BROWSER_HEADERS_NAVIGATE } from '../../lib/browser-headers.js';
import { fetchOgFallback } from '../../lib/og-fallback.js';

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

interface OgEnv {
  SCRAPER_API_KEY?: string;
  OPENGRAPH_IO_KEY?: string;
}

async function fetchOgMetadata(url: string, env?: OgEnv): Promise<OgMetadata> {
  const result: OgMetadata = {
    ogImage: null,
    siteName: null,
    author: null,
    publishedAt: null,
    ogDescription: null,
    articleTags: null,
  };

  let html = '';
  let directOk = false;
  try {
    const response = await fetch(url, {
      headers: BROWSER_HEADERS_NAVIGATE,
      redirect: 'follow',
    });
    if (response.ok) {
      // Read only the first 50KB to find the <head> section
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        while (html.length < 50_000) {
          const { done, value } = await reader.read();
          if (done) break;
          html += decoder.decode(value, { stream: true });
          if (html.includes('</head>')) break;
        }
        reader.cancel();
        directOk = true;
      }
    }
  } catch {
    // Non-fatal — paywall, anti-bot, network. Fall through to scraper tier.
  }

  // Helper to extract meta content from the head HTML we have
  const getMeta = (property: string): string | null => {
    if (!html) return null;
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

  if (directOk) {
    result.ogImage = getMeta('og:image');
    result.siteName = getMeta('og:site_name');
    result.ogDescription = getMeta('og:description');
    result.publishedAt =
      getMeta('article:published_time') ??
      getMeta('datePublished') ??
      getMeta('date');
    // NYT (and some other sources) put a URL in `article:author` rather
    // than a name. Skip URL-shaped values and fall through to the next
    // tag; if all we have is a URL, convert `https://site/by/jane-doe`
    // into "Jane Doe" by titlecasing the last path slug.
    const pickName = (raw: string | null): string | null => {
      if (!raw) return null;
      if (!/^https?:\/\//i.test(raw)) return raw;
      const slug = raw.replace(/\/+$/, '').split('/').pop();
      if (!slug) return null;
      return slug
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
    };
    result.author =
      pickName(getMeta('author')) ??
      pickName(getMeta('article:author')) ??
      pickName(getMeta('byl'));

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
  }

  // Tier 3/4 fallback for image + description when direct fetch didn't
  // yield them (DataDome on NYT, PerimeterX on Bloomberg, etc). Only
  // fires when keys are configured and the cheap path came up empty.
  if (env && (!result.ogImage || !result.ogDescription)) {
    const fb = await fetchOgFallback(url, env);
    if (fb) {
      if (!result.ogImage && fb.image) result.ogImage = fb.image;
      if (!result.ogDescription && fb.description)
        result.ogDescription = fb.description;
    }
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
        sourceHash: bookmark.hash,
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
      sourceHash: bookmark.hash,
      userId: 1,
    })
    .returning({ id: readingItems.id });

  return { id: inserted.id, isNew: true };
}

/**
 * Enrich a new article with OG metadata and word count.
 */
export async function enrichArticle(
  db: Database,
  client: InstapaperClient,
  itemId: number,
  bookmarkId: number,
  url: string | null,
  ogEnv?: OgEnv
): Promise<void> {
  const updates: Record<string, unknown> = {};

  // Fetch OG metadata from article URL
  if (url) {
    const og = await fetchOgMetadata(url, ogEnv);
    if (og.siteName) updates.siteName = og.siteName;
    if (og.author) updates.author = og.author;
    if (og.ogImage) updates.ogImageUrl = og.ogImage;
    if (og.publishedAt) updates.publishedAt = og.publishedAt;
    if (og.ogDescription) updates.ogDescription = og.ogDescription;
    if (og.articleTags) updates.articleTags = og.articleTags;
  }

  // Fetch article text for word count
  let getTextError: string | null = null;
  try {
    const html = await client.getText(bookmarkId);
    const { wordCount, estimatedReadMin } = computeWordCount(html);
    updates.content = html;
    updates.bodyExcerpt = htmlToText(html, { maxChars: 12000 });
    updates.wordCount = wordCount;
    updates.estimatedReadMin = estimatedReadMin;
  } catch (err) {
    getTextError = err instanceof Error ? err.message : String(err);
    console.log(
      `[SYNC] Failed to get text for bookmark ${bookmarkId}: ${getTextError}`
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
    // Both OG fetch and getText came back empty/errored — mark as failed with
    // the real reason so re-enrichment and debugging have something to go on.
    const reason = getTextError
      ? `getText: ${getTextError}`
      : 'No OG metadata found';
    await db
      .update(readingItems)
      .set({
        enrichmentStatus: 'failed',
        enrichmentError: reason,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(readingItems.id, itemId));
  }
}

/**
 * Upsert highlights for a bookmark from a pre-fetched list.
 * Returns the DB rows (including generated ids) so the caller can index
 * newly-inserted highlights into the search index.
 */
async function upsertHighlights(
  db: Database,
  itemId: number,
  highlights: InstapaperHighlight[]
): Promise<{
  count: number;
  rows: { id: number; text: string; note: string | null }[];
}> {
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

  // Read back the final set for this item so the caller can index the
  // current snapshot in FTS. Including note so body contains both.
  const rows = await db
    .select({
      id: readingHighlights.id,
      text: readingHighlights.text,
      note: readingHighlights.note,
    })
    .from(readingHighlights)
    .where(eq(readingHighlights.itemId, itemId));

  return { count, rows };
}

/**
 * Sync highlights for a bookmark by fetching from the API.
 * Used as a fallback when highlights aren't included inline.
 */
async function syncHighlights(
  db: Database,
  client: InstapaperClient,
  itemId: number,
  bookmarkId: number
): Promise<{
  count: number;
  rows: { id: number; text: string; note: string | null }[];
}> {
  let highlights;
  try {
    highlights = await client.listHighlights(bookmarkId);
  } catch {
    return { count: 0, rows: [] };
  }
  return upsertHighlights(db, itemId, highlights);
}

/**
 * Build the `have` parameter string from existing bookmarks in DB.
 * Format: "bookmarkId:hash,bookmarkId:hash,..."
 */
async function buildHaveParam(db: Database): Promise<string> {
  const existing = await db
    .select({
      sourceId: readingItems.sourceId,
      sourceHash: readingItems.sourceHash,
    })
    .from(readingItems)
    .where(
      and(eq(readingItems.source, 'instapaper'), eq(readingItems.userId, 1))
    );

  return existing
    .map((row) =>
      row.sourceHash ? `${row.sourceId}:${row.sourceHash}` : row.sourceId
    )
    .join(',');
}

/**
 * Build the `highlights` parameter string from existing highlights in DB.
 * Format: "highlightId-highlightId-..."
 */
async function buildHighlightsParam(db: Database): Promise<string> {
  const existing = await db
    .select({ sourceId: readingHighlights.sourceId })
    .from(readingHighlights)
    .where(eq(readingHighlights.userId, 1));

  return existing
    .filter((row) => row.sourceId !== null)
    .map((row) => row.sourceId)
    .join('-');
}

// ─── Main sync function ─────────────────────────────────────────────

export async function syncReading(
  db: Database,
  env: {
    INSTAPAPER_CONSUMER_KEY: string;
    INSTAPAPER_CONSUMER_SECRET: string;
    INSTAPAPER_ACCESS_TOKEN: string;
    INSTAPAPER_ACCESS_TOKEN_SECRET: string;
    SCRAPER_API_KEY?: string;
    OPENGRAPH_IO_KEY?: string;
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
    // Build delta sync params from existing data
    const haveParam = await buildHaveParam(db);
    const highlightsParam = await buildHighlightsParam(db);
    console.log(
      `[SYNC] Delta sync: ${haveParam ? haveParam.split(',').length : 0} known bookmarks, ${highlightsParam ? highlightsParam.split('-').length : 0} known highlights`
    );

    // Sync each folder. The Instapaper API hard-caps `bookmarks/list`
    // at 500 per call regardless of `have=`, so 500 is the realistic
    // ceiling for any single folder. The previous archive cap of 100
    // was leaving 80% of the available archive on the table — bumped
    // to match unread/starred. Custom user folders are also enumerated
    // (via `folders/list`) so bookmarks living only in custom folders
    // get ingested too — the prior code only iterated the 3 default
    // folders, which left ~30 articles invisible to Rewind.
    const customFolders = await client.listFolders();
    const folders: { id: string; limit: number }[] = [
      { id: 'unread', limit: 500 },
      { id: 'starred', limit: 500 },
      { id: 'archive', limit: 500 },
      ...customFolders.map((f) => ({
        id: String(f.folder_id),
        limit: 500,
      })),
    ];

    for (const folder of folders) {
      console.log(
        `[SYNC] Fetching ${folder.id} bookmarks (limit ${folder.limit})`
      );
      const result = await client.listBookmarks({
        folderId: folder.id,
        limit: folder.limit,
        have: haveParam || undefined,
        highlights: highlightsParam || undefined,
      });
      console.log(
        `[SYNC] Got ${result.bookmarks.length} bookmarks, ${result.highlights.length} highlights, ${result.deleteIds.length} deletes from ${folder.id}`
      );

      // Group inline highlights by bookmark_id for efficient lookup
      const highlightsByBookmark = new Map<number, InstapaperHighlight[]>();
      for (const h of result.highlights) {
        const existing = highlightsByBookmark.get(h.bookmark_id) ?? [];
        existing.push(h);
        highlightsByBookmark.set(h.bookmark_id, existing);
      }

      // Handle deleted bookmarks
      if (result.deleteIds.length > 0) {
        const deleteSourceIds = result.deleteIds.map(String);
        await db
          .delete(readingItems)
          .where(
            and(
              eq(readingItems.source, 'instapaper'),
              eq(readingItems.userId, 1),
              inArray(readingItems.sourceId, deleteSourceIds)
            )
          );
        console.log(
          `[SYNC] Deleted ${result.deleteIds.length} bookmarks removed from Instapaper`
        );
      }

      for (const bookmark of result.bookmarks) {
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
            bookmark.url,
            {
              SCRAPER_API_KEY: env.SCRAPER_API_KEY,
              OPENGRAPH_IO_KEY: env.OPENGRAPH_IO_KEY,
            }
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

        // Sync highlights — use inline highlights if available, otherwise fetch individually
        const inlineHighlights = highlightsByBookmark.get(bookmark.bookmark_id);
        const hResult = inlineHighlights
          ? await upsertHighlights(db, id, inlineHighlights)
          : await syncHighlights(db, client, id, bookmark.bookmark_id);
        highlightsSynced += hResult.count;

        // Index each highlight in FTS so `search` can hit them independently
        // from the parent article. Title = first 80 chars, subtitle = parent,
        // body = full text (+ note if any) for longer matches.
        for (const h of hResult.rows) {
          const title = h.text.length > 80 ? h.text.slice(0, 80) + '…' : h.text;
          const body = h.note ? `${h.text} ${h.note}` : h.text;
          searchItems.push({
            domain: 'reading',
            entityType: 'highlight',
            entityId: String(h.id),
            title,
            subtitle: bookmark.title,
            body: body.length > title.length ? body : undefined,
          });
        }
      }
    }

    // ─── Untitled-sweep ──────────────────────────────────────────────
    // Instapaper accepts an iOS share immediately but extracts page
    // metadata server-side over the following minutes. If our 6h cron
    // lands in that window we capture the partial state and store
    // title="Untitled" via the transformBookmark fallback. The bookmark
    // hash on Instapaper's side does not always change when their
    // backend later fills in metadata, so the next regular delta sync
    // (which uses `have=…` to skip unchanged hashes) misses the update.
    //
    // Targeted force-refresh: any reading_items row with title="Untitled"
    // saved within the last 7 days gets re-fetched. Older Untitleds are
    // left alone — extraction genuinely failed (paywalled scrape,
    // deleted page) and Instapaper won't have anything new for us.
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();
    const staleUntitled = await db
      .select({ sourceId: readingItems.sourceId })
      .from(readingItems)
      .where(
        and(
          eq(readingItems.source, 'instapaper'),
          eq(readingItems.userId, 1),
          eq(readingItems.title, 'Untitled'),
          gte(readingItems.savedAt, sevenDaysAgo)
        )
      );

    if (staleUntitled.length > 0) {
      const staleSourceIds = new Set(
        staleUntitled
          .map((r) => r.sourceId)
          .filter((s): s is string => s !== null)
      );
      console.log(
        `[SYNC] Untitled-sweep: ${staleSourceIds.size} stale articles within 7d; force-refreshing`
      );
      let healed = 0;
      for (const folderId of ['unread', 'starred', 'archive']) {
        // Force-fetch without the delta `have` filter so Instapaper returns
        // current metadata for bookmarks whose hash didn't change but whose
        // title finally resolved server-side.
        const fresh = await client.listBookmarks({
          folderId,
          limit: 200,
        });
        for (const bookmark of fresh.bookmarks) {
          if (!staleSourceIds.has(String(bookmark.bookmark_id))) continue;
          const newTitle = bookmark.title?.trim();
          if (!newTitle || newTitle === 'Untitled') continue;
          await upsertBookmark(db, bookmark, folderId);
          healed++;
        }
      }
      console.log(
        `[SYNC] Untitled-sweep: ${healed} of ${staleSourceIds.size} titles healed`
      );
      itemsSynced += healed;
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
