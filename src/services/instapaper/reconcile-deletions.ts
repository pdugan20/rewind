/**
 * Full-archive deletion reconciliation for Instapaper.
 *
 * The normal sync (syncReading) detects deletions via the `have=` parameter
 * on bookmarks/list — Instapaper returns a `delete` entry for any source_id
 * in `have=` that's no longer in the queried folder. The catch is that
 * bookmarks/list hard-caps at 500 items per call regardless of `have=`,
 * so for accounts with thousands of archived bookmarks the deletion signal
 * never reaches us for items outside that 500-item window. Items deleted
 * on Instapaper years ago can leak in our DB indefinitely.
 *
 * This module fixes that with an enumerate-and-reconcile pass:
 *   1. For each folder (default + user-defined), page through ALL bookmarks
 *      using `have=` as a rolling pagination cursor.
 *   2. Accumulate the union of source_ids seen across every folder.
 *   3. Any reading_items.source_id NOT in that union is truly deleted on
 *      Instapaper — purge from reading_items + images.
 *
 * Cost: ~ceil(total_bookmarks / 500) API calls per folder, plus rate-limit
 * pauses between calls. For a 19k-bookmark account that's ~40 calls; with
 * 200ms latency + Instapaper's recommended <1 req/sec pacing, the full
 * pass takes ~40-60s. Run weekly via cron.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { readingItems } from '../../db/schema/reading.js';
import { images } from '../../db/schema/system.js';
import { InstapaperClient } from './client.js';

const PAGE_SIZE = 500;
// How many source_ids to send per `have=` chunk. The string format is
// "id:hash,id:hash,..." — at ~25 chars per entry, 1k chunks stays well
// under any sane URL/body cap and keeps each request snappy.
const HAVE_CHUNK = 1000;
// Soft cap on pages per folder so a runaway loop can't burn the whole
// Worker invocation on a single misbehaving folder. 80 * 500 = 40k items,
// well over realistic account sizes.
const MAX_PAGES_PER_FOLDER = 80;

export interface ReconcileResult {
  foldersScanned: number;
  pagesFetched: number;
  bookmarksSeen: number;
  candidates: number;
  deleted: number;
  imagesDeleted: number;
  tookMs: number;
}

/**
 * Walk every bookmark in a single folder using have= as a pagination
 * cursor. Each page returns up to 500 bookmarks not already in `have=`;
 * we add them to `have` and request again until the response is short.
 *
 * Returns the set of source_ids found in this folder.
 */
async function paginateFolder(
  client: InstapaperClient,
  folderId: string
): Promise<{ ids: Set<string>; pages: number }> {
  const seen = new Set<string>();
  let pages = 0;

  for (let page = 0; page < MAX_PAGES_PER_FOLDER; page++) {
    const haveStr = seen.size === 0 ? undefined : Array.from(seen).join(',');
    const result = await client.listBookmarks({
      folderId,
      limit: PAGE_SIZE,
      have: haveStr,
    });
    pages++;

    if (result.bookmarks.length === 0) break;

    for (const b of result.bookmarks) {
      seen.add(String(b.bookmark_id));
    }

    // Last page: server returned fewer than the cap → no more to fetch.
    if (result.bookmarks.length < PAGE_SIZE) break;
  }

  return { ids: seen, pages };
}

/**
 * Cross-check folder presence for a chunk of known source_ids. For each
 * folder, send the chunk as `have=` and inspect which IDs come back as
 * deletes vs bookmarks. An item is "still present somewhere" if any
 * folder returns it as a bookmark; otherwise the user has either deleted
 * it or it lives in a folder we didn't enumerate.
 *
 * This is a defense-in-depth check on top of paginateFolder — covers the
 * case where pagination missed an item due to server-side reordering or
 * concurrent writes during the scan.
 */
async function verifyChunk(
  client: InstapaperClient,
  folders: string[],
  chunk: string[]
): Promise<Set<string>> {
  const stillPresent = new Set<string>();
  for (const folderId of folders) {
    // For verification we use plain ids (no hash) so the server treats
    // every item as "I have an unknown version" — it'll then return
    // either the current bookmark (still in this folder) or a delete
    // entry (not here). Hash matching would let it omit unchanged
    // items from the response, defeating the check.
    const haveStr = chunk.join(',');
    const result = await client.listBookmarks({
      folderId,
      limit: PAGE_SIZE,
      have: haveStr,
    });
    for (const b of result.bookmarks) {
      stillPresent.add(String(b.bookmark_id));
    }
  }
  return stillPresent;
}

export async function reconcileReadingDeletions(
  db: Database,
  env: {
    INSTAPAPER_CONSUMER_KEY: string;
    INSTAPAPER_CONSUMER_SECRET: string;
    INSTAPAPER_ACCESS_TOKEN: string;
    INSTAPAPER_ACCESS_TOKEN_SECRET: string;
  }
): Promise<ReconcileResult> {
  const t0 = Date.now();
  const client = new InstapaperClient(
    env.INSTAPAPER_CONSUMER_KEY,
    env.INSTAPAPER_CONSUMER_SECRET,
    env.INSTAPAPER_ACCESS_TOKEN,
    env.INSTAPAPER_ACCESS_TOKEN_SECRET
  );

  // Enumerate every folder we know about.
  const customFolders = await client.listFolders();
  const folders = [
    'unread',
    'starred',
    'archive',
    ...customFolders.map((f) => String(f.folder_id)),
  ];

  // Pass 1 — paginate each folder and union the bookmark IDs seen.
  const seenAnywhere = new Set<string>();
  let pagesFetched = 0;
  for (const folderId of folders) {
    const { ids, pages } = await paginateFolder(client, folderId);
    pagesFetched += pages;
    for (const id of ids) seenAnywhere.add(id);
  }

  // What does our DB think exists?
  const dbRows = await db
    .select({ sourceId: readingItems.sourceId, id: readingItems.id })
    .from(readingItems)
    .where(
      and(eq(readingItems.source, 'instapaper'), eq(readingItems.userId, 1))
    );

  const dbBySourceId = new Map<string, number>();
  for (const r of dbRows) {
    if (r.sourceId) dbBySourceId.set(r.sourceId, r.id);
  }

  // Candidates: in our DB but not seen by pagination.
  const candidates: string[] = [];
  for (const sourceId of dbBySourceId.keys()) {
    if (!seenAnywhere.has(sourceId)) candidates.push(sourceId);
  }

  // Pass 2 — for each candidate, do a chunked verify across all folders.
  // Anything that comes back as a bookmark from any folder is a false
  // positive (pagination raced or skipped it); only purge items confirmed
  // missing from every folder.
  const stillPresentAnywhere = new Set<string>();
  for (let i = 0; i < candidates.length; i += HAVE_CHUNK) {
    const chunk = candidates.slice(i, i + HAVE_CHUNK);
    const found = await verifyChunk(client, folders, chunk);
    for (const id of found) stillPresentAnywhere.add(id);
  }

  // Purge.
  const toDeleteSourceIds = candidates.filter(
    (id) => !stillPresentAnywhere.has(id)
  );
  let deleted = 0;
  let imagesDeleted = 0;
  if (toDeleteSourceIds.length > 0) {
    const toDeleteRowIds = toDeleteSourceIds
      .map((sid) => dbBySourceId.get(sid))
      .filter((id): id is number => id !== undefined);
    const toDeleteRowIdStrs = toDeleteRowIds.map(String);

    const imgResult = await db
      .delete(images)
      .where(
        and(
          eq(images.domain, 'reading'),
          eq(images.entityType, 'articles'),
          inArray(images.entityId, toDeleteRowIdStrs)
        )
      );
    imagesDeleted = Number(
      (imgResult as { meta?: { changes?: number } }).meta?.changes ?? 0
    );

    const itemResult = await db
      .delete(readingItems)
      .where(
        and(
          eq(readingItems.source, 'instapaper'),
          eq(readingItems.userId, 1),
          inArray(readingItems.sourceId, toDeleteSourceIds)
        )
      );
    deleted = Number(
      (itemResult as { meta?: { changes?: number } }).meta?.changes ?? 0
    );
  }

  return {
    foldersScanned: folders.length,
    pagesFetched,
    bookmarksSeen: seenAnywhere.size,
    candidates: candidates.length,
    deleted,
    imagesDeleted,
    tookMs: Date.now() - t0,
  };
}

// Re-export for tests.
export const __TEST__ = {
  paginateFolder,
  verifyChunk,
  PAGE_SIZE,
  HAVE_CHUNK,
};
