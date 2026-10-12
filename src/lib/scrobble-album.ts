import { sql } from 'drizzle-orm';
import { lastfmScrobbles, lastfmTracks } from '../db/schema/lastfm.js';

// Old events have no original album snapshot. Preserve the existing attribution
// as a compatibility fallback; never invent an original album during migration.
// Explicitly album-less new plays must not inherit a track's default album.
export const scrobbleAlbumId = sql<
  number | null
>`CASE WHEN ${lastfmScrobbles.albumRecorded}=1 THEN ${lastfmScrobbles.albumId} ELSE ${lastfmTracks.albumId} END`;

// Song summaries have a single album slot: use the latest owned event, including
// an explicitly missing album. Fall back only when the song has no events.
export const latestTrackAlbumId = sql<number | null>`CASE WHEN EXISTS (
  SELECT 1 FROM lastfm_scrobbles s WHERE s.track_id=${lastfmTracks.id} AND s.user_id=${lastfmTracks.userId}
) THEN (
  SELECT CASE WHEN s.album_recorded=1 THEN s.album_id ELSE ${lastfmTracks.albumId} END
  FROM lastfm_scrobbles s WHERE s.track_id=${lastfmTracks.id} AND s.user_id=${lastfmTracks.userId}
  ORDER BY s.scrobbled_at DESC,s.id DESC LIMIT 1
) ELSE ${lastfmTracks.albumId} END`;
