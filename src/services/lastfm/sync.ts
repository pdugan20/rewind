import { eq, and, desc, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  lastfmArtists,
  lastfmAlbums,
  lastfmTracks,
  lastfmScrobbles,
  lastfmTopArtists,
  lastfmTopAlbums,
  lastfmTopTracks,
  lastfmUserStats,
} from '../../db/schema/lastfm.js';
import { syncRuns, revalidationHooks } from '../../db/schema/system.js';
import { LastfmClient, LASTFM_PERIODS } from './client.js';
import type { LastfmPeriod } from './client.js';
import { normalizeScrobble } from './transforms.js';
import { isFiltered, loadFilters } from './filters.js';

async function upsertArtist(
  db: Database,
  name: string,
  mbid: string | null,
  url?: string
): Promise<number> {
  // Try to find existing artist
  const [existing] = await db
    .select({ id: lastfmArtists.id })
    .from(lastfmArtists)
    .where(eq(lastfmArtists.name, name))
    .limit(1);

  if (existing) {
    if (mbid) {
      await db
        .update(lastfmArtists)
        .set({ mbid, updatedAt: new Date().toISOString() })
        .where(eq(lastfmArtists.id, existing.id));
    }
    return existing.id;
  }

  const filtered = isFiltered({ artistName: name }) ? 1 : 0;
  const result = await db
    .insert(lastfmArtists)
    .values({
      name,
      mbid,
      url,
      isFiltered: filtered,
    })
    .returning({ id: lastfmArtists.id });

  return result[0].id;
}

async function upsertAlbum(
  db: Database,
  name: string,
  artistId: number,
  mbid: string | null,
  artistName: string,
  url?: string
): Promise<number> {
  const [existing] = await db
    .select({ id: lastfmAlbums.id })
    .from(lastfmAlbums)
    .where(
      and(eq(lastfmAlbums.name, name), eq(lastfmAlbums.artistId, artistId))
    )
    .limit(1);

  if (existing) {
    if (mbid) {
      await db
        .update(lastfmAlbums)
        .set({ mbid, updatedAt: new Date().toISOString() })
        .where(eq(lastfmAlbums.id, existing.id));
    }
    return existing.id;
  }

  const filtered = isFiltered({ artistName, albumName: name }) ? 1 : 0;
  const result = await db
    .insert(lastfmAlbums)
    .values({
      name,
      artistId,
      mbid,
      url,
      isFiltered: filtered,
    })
    .returning({ id: lastfmAlbums.id });

  return result[0].id;
}

async function upsertTrack(
  db: Database,
  name: string,
  artistId: number,
  albumId: number | null,
  mbid: string | null,
  artistName: string,
  albumName?: string,
  url?: string
): Promise<number> {
  const [existing] = await db
    .select({ id: lastfmTracks.id })
    .from(lastfmTracks)
    .where(
      and(eq(lastfmTracks.name, name), eq(lastfmTracks.artistId, artistId))
    )
    .limit(1);

  if (existing) {
    // Update album association if we have one and the track doesn't
    if (albumId) {
      await db
        .update(lastfmTracks)
        .set({
          albumId,
          mbid: mbid || undefined,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(lastfmTracks.id, existing.id));
    }
    return existing.id;
  }

  const filtered = isFiltered({
    artistName,
    albumName,
    trackName: name,
  })
    ? 1
    : 0;
  const result = await db
    .insert(lastfmTracks)
    .values({
      name,
      artistId,
      albumId,
      mbid,
      url,
      isFiltered: filtered,
    })
    .returning({ id: lastfmTracks.id });

  return result[0].id;
}

async function startSyncRun(db: Database, syncType: string): Promise<number> {
  const result = await db
    .insert(syncRuns)
    .values({
      domain: 'listening',
      syncType,
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

/**
 * Get the timestamp of the most recent scrobble to use as the `from` parameter.
 */
async function getLastScrobbleTimestamp(db: Database): Promise<number | null> {
  const [latest] = await db
    .select({ scrobbledAt: lastfmScrobbles.scrobbledAt })
    .from(lastfmScrobbles)
    .orderBy(desc(lastfmScrobbles.scrobbledAt))
    .limit(1);

  if (!latest) return null;
  return Math.floor(new Date(latest.scrobbledAt).getTime() / 1000);
}

/**
 * Incremental scrobble sync: fetch new scrobbles since last sync.
 */
export async function syncRecentScrobbles(
  db: Database,
  client: LastfmClient
): Promise<number> {
  const runId = await startSyncRun(db, 'scrobbles');
  let totalSynced = 0;

  try {
    const lastTimestamp = await getLastScrobbleTimestamp(db);
    // Add 1 second to avoid re-fetching the last scrobble
    const from = lastTimestamp ? lastTimestamp + 1 : undefined;

    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const response = await client.getRecentTracks({
        limit: 200,
        page,
        from,
      });

      const attr = response.recenttracks['@attr'];
      totalPages = parseInt(attr.totalPages);

      const tracks = response.recenttracks.track;
      if (!tracks || tracks.length === 0) break;

      for (const rawTrack of tracks) {
        const track = normalizeScrobble(rawTrack);

        // Skip now-playing tracks (no timestamp)
        if (track.isNowPlaying || !track.scrobbledAt) continue;

        const artistId = await upsertArtist(
          db,
          track.artistName,
          track.artistMbid
        );
        const albumId = track.albumName
          ? await upsertAlbum(
              db,
              track.albumName,
              artistId,
              track.albumMbid,
              track.artistName
            )
          : null;
        const trackId = await upsertTrack(
          db,
          track.trackName,
          artistId,
          albumId,
          track.trackMbid,
          track.artistName,
          track.albumName,
          track.trackUrl
        );

        // Insert scrobble (skip if duplicate timestamp+track)
        const [existingScrobble] = await db
          .select({ id: lastfmScrobbles.id })
          .from(lastfmScrobbles)
          .where(
            and(
              eq(lastfmScrobbles.trackId, trackId),
              eq(lastfmScrobbles.scrobbledAt, track.scrobbledAt)
            )
          )
          .limit(1);

        if (!existingScrobble) {
          await db.insert(lastfmScrobbles).values({
            trackId,
            scrobbledAt: track.scrobbledAt,
          });
          totalSynced++;
        }
      }

      page++;
    }

    const lastTs = await getLastScrobbleTimestamp(db);
    await completeSyncRun(
      db,
      runId,
      totalSynced,
      JSON.stringify({ lastScrobbleTimestamp: lastTs })
    );

    console.log(`[SYNC] Synced ${totalSynced} new scrobbles`);
    return totalSynced;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failSyncRun(db, runId, message);
    console.log(`[ERROR] Scrobble sync failed: ${message}`);
    throw error;
  }
}

/**
 * Sync top lists for all periods and entity types.
 */
export async function syncTopLists(
  db: Database,
  client: LastfmClient
): Promise<number> {
  const runId = await startSyncRun(db, 'top_lists');
  let totalSynced = 0;

  try {
    for (const period of LASTFM_PERIODS) {
      totalSynced += await syncTopArtistsForPeriod(db, client, period);
      totalSynced += await syncTopAlbumsForPeriod(db, client, period);
      totalSynced += await syncTopTracksForPeriod(db, client, period);
    }

    await completeSyncRun(db, runId, totalSynced);
    console.log(`[SYNC] Synced ${totalSynced} top list entries`);
    return totalSynced;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failSyncRun(db, runId, message);
    console.log(`[ERROR] Top lists sync failed: ${message}`);
    throw error;
  }
}

async function syncTopArtistsForPeriod(
  db: Database,
  client: LastfmClient,
  period: LastfmPeriod
): Promise<number> {
  const response = await client.getTopArtists({ period, limit: 30 });
  const artists = response.topartists.artist;

  // Delete existing entries for this period
  await db.delete(lastfmTopArtists).where(eq(lastfmTopArtists.period, period));

  let rank = 0;
  for (const item of artists) {
    const artistId = await upsertArtist(db, item.name, item.mbid || null);

    // Update playcount on artist
    await db
      .update(lastfmArtists)
      .set({
        playcount: parseInt(item.playcount),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(lastfmArtists.id, artistId));

    // Check if artist is filtered
    const [artist] = await db
      .select({ isFiltered: lastfmArtists.isFiltered })
      .from(lastfmArtists)
      .where(eq(lastfmArtists.id, artistId))
      .limit(1);

    if (artist?.isFiltered) continue;

    rank++;
    await db.insert(lastfmTopArtists).values({
      period,
      rank,
      artistId,
      playcount: parseInt(item.playcount),
    });
  }

  return rank;
}

async function syncTopAlbumsForPeriod(
  db: Database,
  client: LastfmClient,
  period: LastfmPeriod
): Promise<number> {
  const response = await client.getTopAlbums({ period, limit: 30 });
  const albums = response.topalbums.album;

  await db.delete(lastfmTopAlbums).where(eq(lastfmTopAlbums.period, period));

  let rank = 0;
  for (const item of albums) {
    const artistId = await upsertArtist(
      db,
      item.artist.name,
      item.artist.mbid || null
    );
    const albumId = await upsertAlbum(
      db,
      item.name,
      artistId,
      item.mbid || null,
      item.artist.name
    );

    // Update playcount on album
    await db
      .update(lastfmAlbums)
      .set({
        playcount: parseInt(item.playcount),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(lastfmAlbums.id, albumId));

    const [album] = await db
      .select({ isFiltered: lastfmAlbums.isFiltered })
      .from(lastfmAlbums)
      .where(eq(lastfmAlbums.id, albumId))
      .limit(1);

    if (album?.isFiltered) continue;

    rank++;
    await db.insert(lastfmTopAlbums).values({
      period,
      rank,
      albumId,
      playcount: parseInt(item.playcount),
    });
  }

  return rank;
}

async function syncTopTracksForPeriod(
  db: Database,
  client: LastfmClient,
  period: LastfmPeriod
): Promise<number> {
  const response = await client.getTopTracks({ period, limit: 30 });
  const tracks = response.toptracks.track;

  await db.delete(lastfmTopTracks).where(eq(lastfmTopTracks.period, period));

  let rank = 0;
  for (const item of tracks) {
    const artistId = await upsertArtist(
      db,
      item.artist.name,
      item.artist.mbid || null
    );
    const trackId = await upsertTrack(
      db,
      item.name,
      artistId,
      null,
      item.mbid || null,
      item.artist.name,
      undefined,
      item.url
    );

    const [track] = await db
      .select({ isFiltered: lastfmTracks.isFiltered })
      .from(lastfmTracks)
      .where(eq(lastfmTracks.id, trackId))
      .limit(1);

    if (track?.isFiltered) continue;

    rank++;
    await db.insert(lastfmTopTracks).values({
      period,
      rank,
      trackId,
      playcount: parseInt(item.playcount),
    });
  }

  return rank;
}

/**
 * Sync user stats from Last.fm API and local DB counts.
 */
export async function syncUserStats(
  db: Database,
  client: LastfmClient
): Promise<void> {
  const runId = await startSyncRun(db, 'user_stats');

  try {
    const info = await client.getUserInfo();
    const totalScrobbles = parseInt(info.user.playcount);
    const registeredDate = new Date(
      parseInt(info.user.registered.unixtime) * 1000
    ).toISOString();

    // Count unique entities from local DB
    const [artistCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(lastfmArtists);
    const [albumCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(lastfmAlbums);
    const [trackCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(lastfmTracks);

    // Upsert stats (only one row per user)
    const [existing] = await db
      .select({ id: lastfmUserStats.id })
      .from(lastfmUserStats)
      .where(eq(lastfmUserStats.userId, 1))
      .limit(1);

    const stats = {
      totalScrobbles,
      uniqueArtists: artistCount.count,
      uniqueAlbums: albumCount.count,
      uniqueTracks: trackCount.count,
      registeredDate,
      updatedAt: new Date().toISOString(),
    };

    if (existing) {
      await db
        .update(lastfmUserStats)
        .set(stats)
        .where(eq(lastfmUserStats.id, existing.id));
    } else {
      await db.insert(lastfmUserStats).values(stats);
    }

    await completeSyncRun(db, runId, 1);
    console.log(`[SYNC] Updated user stats: ${totalScrobbles} total scrobbles`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failSyncRun(db, runId, message);
    console.log(`[ERROR] User stats sync failed: ${message}`);
    throw error;
  }
}

/**
 * Full historical backfill: fetch all scrobbles from the beginning of time.
 */
export async function backfillScrobbles(
  db: Database,
  client: LastfmClient
): Promise<number> {
  const runId = await startSyncRun(db, 'backfill');
  let totalSynced = 0;

  try {
    let page = 1;
    let totalPages = 1;

    // Fetch from oldest to newest
    while (page <= totalPages) {
      const response = await client.getRecentTracks({
        limit: 200,
        page,
      });

      const attr = response.recenttracks['@attr'];
      totalPages = parseInt(attr.totalPages);

      console.log(
        `[SYNC] Backfill page ${page}/${totalPages} (${totalSynced} synced so far)`
      );

      const tracks = response.recenttracks.track;
      if (!tracks || tracks.length === 0) break;

      for (const rawTrack of tracks) {
        const track = normalizeScrobble(rawTrack);
        if (track.isNowPlaying || !track.scrobbledAt) continue;

        const artistId = await upsertArtist(
          db,
          track.artistName,
          track.artistMbid
        );
        const albumId = track.albumName
          ? await upsertAlbum(
              db,
              track.albumName,
              artistId,
              track.albumMbid,
              track.artistName
            )
          : null;
        const trackId = await upsertTrack(
          db,
          track.trackName,
          artistId,
          albumId,
          track.trackMbid,
          track.artistName,
          track.albumName,
          track.trackUrl
        );

        const [existingScrobble] = await db
          .select({ id: lastfmScrobbles.id })
          .from(lastfmScrobbles)
          .where(
            and(
              eq(lastfmScrobbles.trackId, trackId),
              eq(lastfmScrobbles.scrobbledAt, track.scrobbledAt)
            )
          )
          .limit(1);

        if (!existingScrobble) {
          await db.insert(lastfmScrobbles).values({
            trackId,
            scrobbledAt: track.scrobbledAt,
          });
          totalSynced++;
        }
      }

      page++;
    }

    await completeSyncRun(
      db,
      runId,
      totalSynced,
      JSON.stringify({ totalPages })
    );
    console.log(`[SYNC] Backfill complete: ${totalSynced} scrobbles`);
    return totalSynced;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failSyncRun(db, runId, message);
    console.log(`[ERROR] Backfill failed: ${message}`);
    throw error;
  }
}

/**
 * Fire revalidation hooks after sync completes.
 */
export async function fireRevalidationHooks(db: Database): Promise<void> {
  const hooks = await db
    .select()
    .from(revalidationHooks)
    .where(
      and(
        eq(revalidationHooks.domain, 'listening'),
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
          domain: 'listening',
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

/**
 * Main sync orchestrator called by cron or admin endpoint.
 */
export async function syncListening(
  db: Database,
  client: LastfmClient,
  options: { type: 'scrobbles' | 'top_lists' | 'stats' | 'full' | 'backfill' }
): Promise<{ itemsSynced: number }> {
  // Load filter rules from DB into memory for this sync run
  await loadFilters(db);

  let totalSynced = 0;

  switch (options.type) {
    case 'scrobbles':
      totalSynced = await syncRecentScrobbles(db, client);
      break;
    case 'top_lists':
      totalSynced = await syncTopLists(db, client);
      break;
    case 'stats':
      await syncUserStats(db, client);
      totalSynced = 1;
      break;
    case 'backfill':
      totalSynced = await backfillScrobbles(db, client);
      break;
    case 'full':
      totalSynced += await syncRecentScrobbles(db, client);
      totalSynced += await syncTopLists(db, client);
      await syncUserStats(db, client);
      totalSynced += 1;
      break;
  }

  await fireRevalidationHooks(db);
  return { itemsSynced: totalSynced };
}
