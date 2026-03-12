import { eq, and, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { createDb } from '../../db/client.js';
import { syncRuns } from '../../db/schema/system.js';
import {
  discogsReleases,
  discogsArtists,
  discogsCollection,
  discogsReleaseArtists,
  discogsWantlist,
  discogsCollectionStats,
} from '../../db/schema/discogs.js';
import { DiscogsClient, type DiscogsCollectionItem } from './client.js';
import { runCrossReference } from './cross-reference.js';
import type { Env } from '../../types/env.js';
import { afterSync } from '../../lib/after-sync.js';
import type { FeedItem, SearchItem } from '../../lib/after-sync.js';

/**
 * Upsert a release and its artists from a Discogs collection item.
 * Returns the local release ID.
 */
async function upsertRelease(
  db: Database,
  client: DiscogsClient,
  item: DiscogsCollectionItem,
  userId: number,
  fetchDetails: boolean
): Promise<number> {
  const info = item.basic_information;
  let releaseData: {
    genres: string[];
    styles: string[];
    tracklist?: Array<{ position: string; title: string; duration: string }>;
    country?: string;
    communityHave?: number;
    communityWant?: number;
    lowestPrice?: number | null;
    numForSale?: number;
    coverUrl?: string;
    labels?: Array<{ name: string; catno: string }>;
  } = {
    genres: info.genres || [],
    styles: info.styles || [],
    coverUrl: info.cover_image || info.thumb || undefined,
    labels: info.labels || [],
  };

  // Fetch release details for new releases
  if (fetchDetails) {
    try {
      const detail = await client.getReleaseDetail(info.id);
      releaseData = {
        ...releaseData,
        tracklist: detail.tracklist,
        country: detail.country,
        communityHave: detail.community?.have,
        communityWant: detail.community?.want,
        lowestPrice: detail.lowest_price,
        numForSale: detail.num_for_sale,
      };
      if (detail.images && detail.images.length > 0) {
        const primary = detail.images.find((i) => i.type === 'primary');
        releaseData.coverUrl = primary ? primary.uri : detail.images[0].uri;
      }
    } catch (err) {
      console.log(
        `[ERROR] Failed to fetch release detail for ${info.id}: ${err}`
      );
    }
  }

  // Upsert release
  const formatNames = (info.formats || []).map((f) => f.name);
  const formatDetails = (info.formats || []).flatMap(
    (f) => f.descriptions || []
  );

  await db
    .insert(discogsReleases)
    .values({
      userId,
      discogsId: info.id,
      title: info.title,
      year: info.year || null,
      coverUrl: releaseData.coverUrl || null,
      thumbUrl: info.thumb || null,
      discogsUrl: `https://www.discogs.com/release/${info.id}`,
      genres: JSON.stringify(releaseData.genres),
      styles: JSON.stringify(releaseData.styles),
      formats: JSON.stringify(formatNames),
      formatDetails: JSON.stringify(formatDetails),
      labels: JSON.stringify(releaseData.labels || info.labels || []),
      tracklist: releaseData.tracklist
        ? JSON.stringify(releaseData.tracklist)
        : null,
      country: releaseData.country || null,
      communityHave: releaseData.communityHave ?? null,
      communityWant: releaseData.communityWant ?? null,
      lowestPrice: releaseData.lowestPrice ?? null,
      numForSale: releaseData.numForSale ?? null,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [discogsReleases.userId, discogsReleases.discogsId],
      set: {
        title: sql`excluded.title`,
        year: sql`excluded.year`,
        coverUrl: sql`excluded.cover_url`,
        thumbUrl: sql`excluded.thumb_url`,
        genres: sql`excluded.genres`,
        styles: sql`excluded.styles`,
        formats: sql`excluded.formats`,
        formatDetails: sql`excluded.format_details`,
        labels: sql`excluded.labels`,
        tracklist: sql`COALESCE(excluded.tracklist, discogs_releases.tracklist)`,
        country: sql`COALESCE(excluded.country, discogs_releases.country)`,
        communityHave: sql`COALESCE(excluded.community_have, discogs_releases.community_have)`,
        communityWant: sql`COALESCE(excluded.community_want, discogs_releases.community_want)`,
        lowestPrice: sql`COALESCE(excluded.lowest_price, discogs_releases.lowest_price)`,
        numForSale: sql`COALESCE(excluded.num_for_sale, discogs_releases.num_for_sale)`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  // Get the local release ID
  const [release] = await db
    .select({ id: discogsReleases.id })
    .from(discogsReleases)
    .where(
      and(
        eq(discogsReleases.userId, userId),
        eq(discogsReleases.discogsId, info.id)
      )
    );

  // Upsert artists
  for (const artist of info.artists) {
    await db
      .insert(discogsArtists)
      .values({
        userId,
        discogsId: artist.id,
        name: artist.name,
        profileUrl: `https://www.discogs.com/artist/${artist.id}`,
      })
      .onConflictDoUpdate({
        target: [discogsArtists.userId, discogsArtists.discogsId],
        set: {
          name: sql`excluded.name`,
        },
      });

    const [artistRow] = await db
      .select({ id: discogsArtists.id })
      .from(discogsArtists)
      .where(
        and(
          eq(discogsArtists.userId, userId),
          eq(discogsArtists.discogsId, artist.id)
        )
      );

    if (artistRow) {
      await db
        .insert(discogsReleaseArtists)
        .values({
          releaseId: release.id,
          artistId: artistRow.id,
        })
        .onConflictDoNothing();
    }
  }

  return release.id;
}

/**
 * Sync the full Discogs collection.
 */
interface SyncedRelease {
  releaseId: number;
  title: string;
  artistName: string;
  dateAdded: string;
}

async function syncCollection(
  db: Database,
  client: DiscogsClient,
  userId: number
): Promise<{ count: number; newReleases: SyncedRelease[] }> {
  console.log('[SYNC] Starting collection sync');
  const items = await client.getAllCollectionItems();

  // Track which instance IDs exist in Discogs
  const remoteInstanceIds = new Set(items.map((i) => i.instance_id));

  // Get existing releases to determine which need detail fetch
  const existingReleases = await db
    .select({ discogsId: discogsReleases.discogsId })
    .from(discogsReleases)
    .where(eq(discogsReleases.userId, userId));
  const existingReleaseIds = new Set(existingReleases.map((r) => r.discogsId));

  let synced = 0;
  const newReleases: SyncedRelease[] = [];

  for (const item of items) {
    const isNew = !existingReleaseIds.has(item.basic_information.id);
    const releaseId = await upsertRelease(db, client, item, userId, isNew);

    if (isNew) {
      const artistName = item.basic_information.artists?.[0]?.name ?? 'Unknown';
      newReleases.push({
        releaseId,
        title: item.basic_information.title,
        artistName,
        dateAdded: item.date_added,
      });
    }

    // Upsert collection item
    const notesStr = item.notes ? JSON.stringify(item.notes) : null;

    await db
      .insert(discogsCollection)
      .values({
        userId,
        releaseId,
        instanceId: item.instance_id,
        folderId: item.folder_id,
        rating: item.rating || 0,
        notes: notesStr,
        dateAdded: item.date_added,
      })
      .onConflictDoUpdate({
        target: [discogsCollection.userId, discogsCollection.instanceId],
        set: {
          releaseId: sql`excluded.release_id`,
          folderId: sql`excluded.folder_id`,
          rating: sql`excluded.rating`,
          notes: sql`excluded.notes`,
          dateAdded: sql`excluded.date_added`,
        },
      });

    synced++;
  }

  // Remove collection items that no longer exist in Discogs
  const localItems = await db
    .select({
      id: discogsCollection.id,
      instanceId: discogsCollection.instanceId,
    })
    .from(discogsCollection)
    .where(eq(discogsCollection.userId, userId));

  for (const local of localItems) {
    if (!remoteInstanceIds.has(local.instanceId)) {
      await db
        .delete(discogsCollection)
        .where(eq(discogsCollection.id, local.id));
    }
  }

  console.log(`[SYNC] Collection sync complete: ${synced} items`);
  return { count: synced, newReleases };
}

/**
 * Sync the Discogs wantlist.
 */
async function syncWantlist(
  db: Database,
  client: DiscogsClient,
  userId: number
): Promise<number> {
  console.log('[SYNC] Starting wantlist sync');
  const items = await client.getAllWantlistItems();

  const remoteIds = new Set(items.map((i) => i.basic_information.id));

  for (const item of items) {
    const info = item.basic_information;
    const artistNames = (info.artists || []).map((a) => a.name);
    const formatNames = (info.formats || []).map((f) => f.name);

    await db
      .insert(discogsWantlist)
      .values({
        userId,
        discogsId: info.id,
        title: info.title,
        artists: JSON.stringify(artistNames),
        year: info.year || null,
        coverUrl: info.cover_image || null,
        thumbUrl: info.thumb || null,
        discogsUrl: `https://www.discogs.com/release/${info.id}`,
        formats: JSON.stringify(formatNames),
        genres: JSON.stringify(info.genres || []),
        notes: item.notes || null,
        rating: item.rating || 0,
        dateAdded: item.date_added,
      })
      .onConflictDoUpdate({
        target: [discogsWantlist.userId, discogsWantlist.discogsId],
        set: {
          title: sql`excluded.title`,
          artists: sql`excluded.artists`,
          year: sql`excluded.year`,
          coverUrl: sql`excluded.cover_url`,
          thumbUrl: sql`excluded.thumb_url`,
          formats: sql`excluded.formats`,
          genres: sql`excluded.genres`,
          notes: sql`excluded.notes`,
          rating: sql`excluded.rating`,
          dateAdded: sql`excluded.date_added`,
        },
      });
  }

  // Remove wantlist items that no longer exist
  const localItems = await db
    .select({
      id: discogsWantlist.id,
      discogsId: discogsWantlist.discogsId,
    })
    .from(discogsWantlist)
    .where(eq(discogsWantlist.userId, userId));

  for (const local of localItems) {
    if (!remoteIds.has(local.discogsId)) {
      await db.delete(discogsWantlist).where(eq(discogsWantlist.id, local.id));
    }
  }

  console.log(`[SYNC] Wantlist sync complete: ${items.length} items`);
  return items.length;
}

/**
 * Compute and store collection statistics.
 */
async function computeStats(db: Database, userId: number): Promise<void> {
  console.log('[SYNC] Computing collection stats');

  // Total items
  const [{ count: totalItems }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(discogsCollection)
    .where(eq(discogsCollection.userId, userId));

  // Wantlist count
  const [{ count: wantlistCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(discogsWantlist)
    .where(eq(discogsWantlist.userId, userId));

  // Format breakdown
  const formatRows = await db
    .select({
      formats: discogsReleases.formats,
    })
    .from(discogsCollection)
    .innerJoin(
      discogsReleases,
      eq(discogsCollection.releaseId, discogsReleases.id)
    )
    .where(eq(discogsCollection.userId, userId));

  const formatCounts: Record<string, number> = {
    vinyl: 0,
    cd: 0,
    cassette: 0,
    other: 0,
  };

  for (const row of formatRows) {
    const formats: string[] = row.formats ? JSON.parse(row.formats) : [];
    const primaryFormat = formats[0]?.toLowerCase() || '';
    if (primaryFormat === 'vinyl') {
      formatCounts.vinyl++;
    } else if (primaryFormat === 'cd') {
      formatCounts.cd++;
    } else if (primaryFormat === 'cassette') {
      formatCounts.cassette++;
    } else {
      formatCounts.other++;
    }
  }

  // Genre breakdown
  const genreCounts: Record<string, number> = {};
  // Query releases with genres
  const genreRows = await db
    .select({ genres: discogsReleases.genres })
    .from(discogsCollection)
    .innerJoin(
      discogsReleases,
      eq(discogsCollection.releaseId, discogsReleases.id)
    )
    .where(eq(discogsCollection.userId, userId));

  for (const row of genreRows) {
    const genres: string[] = row.genres ? JSON.parse(row.genres) : [];
    for (const genre of genres) {
      genreCounts[genre] = (genreCounts[genre] || 0) + 1;
    }
  }

  // Decade breakdown
  const decadeCounts: Record<string, number> = {};
  const yearRows = await db
    .select({ year: discogsReleases.year })
    .from(discogsCollection)
    .innerJoin(
      discogsReleases,
      eq(discogsCollection.releaseId, discogsReleases.id)
    )
    .where(eq(discogsCollection.userId, userId));

  let oldestYear: number | null = null;
  let newestYear: number | null = null;

  for (const row of yearRows) {
    if (row.year) {
      const decade = `${Math.floor(row.year / 10) * 10}s`;
      decadeCounts[decade] = (decadeCounts[decade] || 0) + 1;
      if (!oldestYear || row.year < oldestYear) oldestYear = row.year;
      if (!newestYear || row.year > newestYear) newestYear = row.year;
    }
  }

  // Unique artists
  const [{ count: uniqueArtists }] = await db
    .select({
      count: sql<number>`count(distinct ${discogsReleaseArtists.artistId})`,
    })
    .from(discogsReleaseArtists)
    .innerJoin(
      discogsCollection,
      eq(discogsReleaseArtists.releaseId, discogsCollection.releaseId)
    )
    .where(eq(discogsCollection.userId, userId));

  // Most collected artist
  const topArtistRows = await db
    .select({
      name: discogsArtists.name,
      count: sql<number>`count(*)`,
    })
    .from(discogsReleaseArtists)
    .innerJoin(
      discogsArtists,
      eq(discogsReleaseArtists.artistId, discogsArtists.id)
    )
    .innerJoin(
      discogsCollection,
      eq(discogsReleaseArtists.releaseId, discogsCollection.releaseId)
    )
    .where(eq(discogsCollection.userId, userId))
    .groupBy(discogsArtists.id)
    .orderBy(sql`count(*) desc`)
    .limit(1);

  const mostCollectedArtist = topArtistRows[0]
    ? { name: topArtistRows[0].name, count: topArtistRows[0].count }
    : null;

  // Top genre
  const topGenre =
    Object.entries(genreCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Added this year
  const currentYear = new Date().getFullYear();
  const yearStart = `${currentYear}-01-01`;
  const [{ count: addedThisYear }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(discogsCollection)
    .where(
      and(
        eq(discogsCollection.userId, userId),
        sql`${discogsCollection.dateAdded} >= ${yearStart}`
      )
    );

  // Estimated value (sum of lowest_price where available)
  const [{ total: estimatedValue }] = await db
    .select({ total: sql<number | null>`sum(${discogsReleases.lowestPrice})` })
    .from(discogsCollection)
    .innerJoin(
      discogsReleases,
      eq(discogsCollection.releaseId, discogsReleases.id)
    )
    .where(eq(discogsCollection.userId, userId));

  // Upsert stats
  await db
    .insert(discogsCollectionStats)
    .values({
      userId,
      totalItems,
      byFormat: JSON.stringify(formatCounts),
      wantlistCount,
      uniqueArtists,
      estimatedValue: estimatedValue || null,
      topGenre,
      oldestReleaseYear: oldestYear,
      newestReleaseYear: newestYear,
      mostCollectedArtist: mostCollectedArtist
        ? JSON.stringify(mostCollectedArtist)
        : null,
      addedThisYear,
      byGenre: JSON.stringify(genreCounts),
      byDecade: JSON.stringify(decadeCounts),
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [discogsCollectionStats.userId],
      set: {
        totalItems: sql`excluded.total_items`,
        byFormat: sql`excluded.by_format`,
        wantlistCount: sql`excluded.wantlist_count`,
        uniqueArtists: sql`excluded.unique_artists`,
        estimatedValue: sql`excluded.estimated_value`,
        topGenre: sql`excluded.top_genre`,
        oldestReleaseYear: sql`excluded.oldest_release_year`,
        newestReleaseYear: sql`excluded.newest_release_year`,
        mostCollectedArtist: sql`excluded.most_collected_artist`,
        addedThisYear: sql`excluded.added_this_year`,
        byGenre: sql`excluded.by_genre`,
        byDecade: sql`excluded.by_decade`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  console.log('[SYNC] Stats computation complete');
}

/**
 * Record a sync run in the sync_runs table.
 */
async function recordSyncRun(
  db: Database,
  userId: number,
  syncType: string,
  status: 'running' | 'completed' | 'failed',
  startedAt: string,
  itemsSynced?: number,
  error?: string
): Promise<number> {
  const [run] = await db
    .insert(syncRuns)
    .values({
      userId,
      domain: 'collecting',
      syncType,
      status,
      startedAt,
      completedAt: status !== 'running' ? new Date().toISOString() : undefined,
      itemsSynced: itemsSynced ?? 0,
      error: error ?? null,
    })
    .returning({ id: syncRuns.id });

  return run.id;
}

/**
 * Update an existing sync run record.
 */
async function updateSyncRun(
  db: Database,
  runId: number,
  status: 'completed' | 'failed',
  itemsSynced?: number,
  error?: string
): Promise<void> {
  await db
    .update(syncRuns)
    .set({
      status,
      completedAt: new Date().toISOString(),
      itemsSynced: itemsSynced ?? 0,
      error: error ?? null,
    })
    .where(eq(syncRuns.id, runId));
}

/**
 * Full Discogs sync: collection + wantlist + stats + cross-reference.
 */
export async function syncCollecting(
  env: Env,
  userId: number = 1
): Promise<void> {
  const db = createDb(env.DB);
  const client = new DiscogsClient(
    env.DISCOGS_PERSONAL_TOKEN,
    env.DISCOGS_USERNAME
  );
  const startedAt = new Date().toISOString();

  const runId = await recordSyncRun(db, userId, 'full', 'running', startedAt);

  try {
    const collectionResult = await syncCollection(db, client, userId);
    const wantlistCount = await syncWantlist(db, client, userId);

    await computeStats(db, userId);
    await runCrossReference(db, env.DB, userId);

    await updateSyncRun(
      db,
      runId,
      'completed',
      collectionResult.count + wantlistCount
    );

    // Post-sync: feed, search, revalidation
    const feedItems: FeedItem[] = collectionResult.newReleases.map((r) => ({
      domain: 'collecting',
      eventType: 'release_added',
      occurredAt: r.dateAdded,
      title: `Added ${r.title}`,
      subtitle: r.artistName,
      sourceId: `discogs:release:${r.releaseId}`,
    }));
    const searchItems: SearchItem[] = collectionResult.newReleases.map((r) => ({
      domain: 'collecting',
      entityType: 'release',
      entityId: String(r.releaseId),
      title: r.title,
      subtitle: r.artistName,
    }));
    await afterSync(db, { domain: 'collecting', feedItems, searchItems });

    console.log(
      `[SYNC] Collecting sync complete: ${collectionResult.count} collection, ${wantlistCount} wantlist`
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] Collecting sync failed: ${errorMsg}`);
    await updateSyncRun(db, runId, 'failed', 0, errorMsg);
    throw err;
  }
}

/**
 * Check if today is Sunday (for weekly cron).
 */
export function isSunday(): boolean {
  return new Date().getUTCDay() === 0;
}
