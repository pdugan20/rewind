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
  const columns = { track: lastfmTracks.name, artist: lastfmArtists.name };
  const trackArtist = and(
    eq(lastfmArtists.id, lastfmTracks.artistId),
    eq(lastfmArtists.userId, lastfmTracks.userId)
  );
  const [recorded] = await db
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
    .limit(1);
  if (recorded) return recorded;
  const [track] = await db
    .select(columns)
    .from(lastfmTracks)
    .innerJoin(lastfmArtists, trackArtist)
    .where(
      and(eq(lastfmTracks.userId, userId), eq(lastfmTracks.albumId, albumId))
    )
    .limit(1);
  return track ?? null;
}
