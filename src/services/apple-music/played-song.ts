/**
 * A song played from an album, used to identify the album in the catalog.
 * Prefers the latest play recorded on the album; plays from before album
 * snapshots (album_recorded = 0) reach the album through their track, so a
 * track of the album is the fallback.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  lastfmArtists,
  lastfmScrobbles,
  lastfmTracks,
} from '../../db/schema/lastfm.js';

export async function playedSong(
  db: Database,
  userId: number,
  albumId: number
): Promise<{ track: string; artist: string } | null> {
  return (await playedSongs(db, userId, albumId, 1))[0] ?? null;
}

/** How many recent plays are read to find distinct songs. */
const RECENT_PLAYS = 50;

/**
 * Up to `limit` distinct songs played from an album, most recent first. A
 * song the catalog edition lacks (a bonus track, a store-specific title)
 * cannot identify the album, so a lookup can fall back to another one.
 */
export async function playedSongs(
  db: Database,
  userId: number,
  albumId: number,
  limit: number
): Promise<{ track: string; artist: string }[]> {
  const columns = { track: lastfmTracks.name, artist: lastfmArtists.name };
  const trackArtist = and(
    eq(lastfmArtists.id, lastfmTracks.artistId),
    eq(lastfmArtists.userId, lastfmTracks.userId)
  );
  const recorded = await db
    .select(columns)
    .from(lastfmScrobbles)
    .innerJoin(
      lastfmTracks,
      and(
        eq(lastfmTracks.id, lastfmScrobbles.trackId),
        eq(lastfmTracks.userId, lastfmScrobbles.userId)
      )
    )
    .innerJoin(lastfmArtists, trackArtist)
    .where(
      and(
        eq(lastfmScrobbles.userId, userId),
        eq(lastfmScrobbles.albumId, albumId),
        eq(lastfmScrobbles.albumRecorded, 1)
      )
    )
    .orderBy(desc(lastfmScrobbles.scrobbledAt))
    .limit(RECENT_PLAYS);
  const distinct = (rows: { track: string; artist: string }[]) => {
    const seen = new Set<string>();
    return rows
      .filter((row) => !seen.has(row.track) && !!seen.add(row.track))
      .slice(0, limit);
  };
  if (recorded.length) return distinct(recorded);
  const tracks = await db
    .select(columns)
    .from(lastfmTracks)
    .innerJoin(lastfmArtists, trackArtist)
    .where(
      and(eq(lastfmTracks.userId, userId), eq(lastfmTracks.albumId, albumId))
    )
    .limit(RECENT_PLAYS);
  return distinct(tracks);
}
