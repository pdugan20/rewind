/**
 * Full-archive deletion reconciliation for Instapaper.
 *
 * The normal sync (syncReading) detects deletions via the `have=` parameter
 * on bookmarks/list — Instapaper returns a `delete` entry for any source_id
 * in `have=` that's no longer in the queried folder. The catch is that
 * bookmarks/list only ever returns/reasons-about the ~500 most recent
 * items per folder; everything older is invisible to that single call.
 * Items deleted on Instapaper years ago can leak in our DB indefinitely.
 *
 * The Instapaper API doesn't actually support pagination of older items
 * via `have=` — the response cap is 500 regardless. But we CAN ask the
 * API "do these specific old IDs still exist?" by sending them in `have=`
 * directly. The server will mark them as `delete` for any folder they
 * aren't in, regardless of how old they are.
 *
 * So this module skips pagination and goes straight to chunked
 * delete-probing:
 *   1. Pull every source_id (and its hash, if known) from our DB.
 *   2. Chunk them and for each chunk × each folder, call bookmarks/list
 *      with have=<chunk>. Track which source_ids the server reports as
 *      delete (i.e. "not in this folder") versus which ones it doesn't
 *      mention (i.e. "still here, hash matches") or returns as a fresh
 *      bookmark (i.e. "here, hash mismatch — take this").
 *   3. An item is truly deleted iff every folder reports it as delete.
 *      Anything reported as present in any folder is kept.
 *
 * Cost: ceil(N / chunk_size) calls per folder. With N ~= 20k, chunk
 * size 1000, and 13 folders, that's ~260 API calls. At the client's
 * 200ms rate limit that's ~50-60s; cron events allow this comfortably.
 *
 * Safety: refuses to purge more than MAX_PURGE_FRACTION of the DB in
 * a single pass — guards against algorithm bugs (an earlier version
 * mass-flagged 95% of items as missing because it assumed the API
 * paginated, which it doesn't). When the guard trips, the result
 * surfaces `abortedReason` for the operator to inspect.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { readingItems } from '../../db/schema/reading.js';
import { images } from '../../db/schema/system.js';
import { InstapaperClient } from './client.js';

const PAGE_SIZE = 500;
// How many source_ids to send per `have=` call. Each entry serializes as
// "id:hash" (~25 chars), so 1000 entries is ~25KB on the wire — well
// under any reasonable URL/body cap and keeps each round-trip snappy.
const HAVE_CHUNK = 1000;
// D1 caps bound parameters per query at 100. Chunk DELETE statements
// well under that — we burn 2 slots on the domain/entity_type filters,
// leaving 98 for the IN list. Round down to leave headroom.
const DELETE_CHUNK = 80;
// Refuse to purge more than this fraction of the user's reading_items
// in a single reconcile pass. When this trips we abort with a clear
// reason so the operator notices instead of silently wiping the DB.
const MAX_PURGE_FRACTION = 0.1;

export interface ReconcileResult {
  foldersScanned: number;
  apiCalls: number;
  knownInDb: number;
  candidates: number;
  deleted: number;
  imagesDeleted: number;
  tookMs: number;
  abortedReason?: string;
}

/**
 * For one folder × one chunk, ask the API which of the chunk's IDs
 * aren't in this folder. Returns the set of source_ids the server
 * reported as `delete` for this folder (i.e. "not here").
 *
 * Items in the chunk that the server does NOT mention are still in
 * this folder (hash matched, omitted by `have=`); items returned as
 * bookmarks are in this folder with a stale hash.
 */
async function probeFolderForChunk(
  client: InstapaperClient,
  folderId: string,
  chunk: { id: string; hash: string | null }[]
): Promise<Set<string>> {
  const haveStr = chunk
    .map(({ id, hash }) => (hash ? `${id}:${hash}` : id))
    .join(',');
  const result = await client.listBookmarks({
    folderId,
    limit: PAGE_SIZE,
    have: haveStr,
  });
  return new Set(result.deleteIds.map(String));
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

  // Pull every Instapaper source_id we track + its row id and known hash.
  const dbRows = await db
    .select({
      sourceId: readingItems.sourceId,
      sourceHash: readingItems.sourceHash,
      id: readingItems.id,
    })
    .from(readingItems)
    .where(
      and(eq(readingItems.source, 'instapaper'), eq(readingItems.userId, 1))
    );

  const dbBySourceId = new Map<string, number>();
  const knownChunkInput: { id: string; hash: string | null }[] = [];
  for (const r of dbRows) {
    if (r.sourceId == null) continue;
    dbBySourceId.set(r.sourceId, r.id);
    knownChunkInput.push({ id: r.sourceId, hash: r.sourceHash ?? null });
  }

  // For each chunk × folder, ask the API which IDs aren't in that folder.
  // Track the count of folders that reported each ID as missing — an ID
  // reported missing from EVERY folder is truly deleted. We start at 0
  // for every known ID and only count up the per-folder "missing" signals
  // we actually see; any folder that returns the item as present (i.e.
  // doesn't include it in delete_ids) leaves that count short of the
  // folder total, keeping the item.
  const missingCount = new Map<string, number>();
  for (const { id } of knownChunkInput) missingCount.set(id, 0);

  let apiCalls = 0;
  for (let i = 0; i < knownChunkInput.length; i += HAVE_CHUNK) {
    const chunk = knownChunkInput.slice(i, i + HAVE_CHUNK);
    for (const folderId of folders) {
      const missingFromFolder = await probeFolderForChunk(
        client,
        folderId,
        chunk
      );
      apiCalls++;
      for (const id of missingFromFolder) {
        missingCount.set(id, (missingCount.get(id) ?? 0) + 1);
      }
    }
  }

  const folderTotal = folders.length;
  const candidates: string[] = [];
  for (const [id, count] of missingCount.entries()) {
    if (count === folderTotal) candidates.push(id);
  }

  let deleted = 0;
  let imagesDeleted = 0;
  let abortedReason: string | undefined;

  const purgeFraction =
    dbBySourceId.size === 0 ? 0 : candidates.length / dbBySourceId.size;
  if (purgeFraction > MAX_PURGE_FRACTION) {
    abortedReason = `safety_abort: ${candidates.length}/${dbBySourceId.size} items (${(purgeFraction * 100).toFixed(1)}%) flagged for deletion exceeds MAX_PURGE_FRACTION=${MAX_PURGE_FRACTION * 100}%; refusing to purge`;
  } else if (candidates.length > 0) {
    const toDeleteRowIds = candidates
      .map((sid) => dbBySourceId.get(sid))
      .filter((id): id is number => id !== undefined);
    const toDeleteRowIdStrs = toDeleteRowIds.map(String);

    for (let i = 0; i < toDeleteRowIdStrs.length; i += DELETE_CHUNK) {
      const chunk = toDeleteRowIdStrs.slice(i, i + DELETE_CHUNK);
      const imgResult = await db
        .delete(images)
        .where(
          and(
            eq(images.domain, 'reading'),
            eq(images.entityType, 'articles'),
            inArray(images.entityId, chunk)
          )
        );
      imagesDeleted += Number(
        (imgResult as { meta?: { changes?: number } }).meta?.changes ?? 0
      );
    }

    for (let i = 0; i < candidates.length; i += DELETE_CHUNK) {
      const chunk = candidates.slice(i, i + DELETE_CHUNK);
      const itemResult = await db
        .delete(readingItems)
        .where(
          and(
            eq(readingItems.source, 'instapaper'),
            eq(readingItems.userId, 1),
            inArray(readingItems.sourceId, chunk)
          )
        );
      deleted += Number(
        (itemResult as { meta?: { changes?: number } }).meta?.changes ?? 0
      );
    }
  }

  return {
    foldersScanned: folders.length,
    apiCalls,
    knownInDb: dbBySourceId.size,
    candidates: candidates.length,
    deleted,
    imagesDeleted,
    tookMs: Date.now() - t0,
    ...(abortedReason ? { abortedReason } : {}),
  };
}

// Re-export for tests.
export const __TEST__ = {
  probeFolderForChunk,
  PAGE_SIZE,
  HAVE_CHUNK,
  DELETE_CHUNK,
  MAX_PURGE_FRACTION,
};
