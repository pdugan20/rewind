import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';

export interface AlbumTrackHistory {
  id: number;
  name: string;
  appleMusicUrl: string | null;
  previewUrl: string | null;
  scrobbleCount: number;
  firstScrobbledAt: string | null;
}

// Keep the two disjoint attribution modes indexable. A CASE across a joined
// song/event cannot narrow the initial search to one album, and can cause the
// entire user's history to be scanned for every song in a detail request.
export function albumTrackHistoryQuery(albumId: number, userId: number) {
  return sql`WITH events AS (
    SELECT s.track_id,s.scrobbled_at
    FROM lastfm_scrobbles s INDEXED BY idx_lastfm_scrobbles_user_album_date
    WHERE s.user_id=${userId} AND s.album_id=${albumId} AND s.album_recorded=1
    UNION ALL
    SELECT s.track_id,s.scrobbled_at
    FROM lastfm_tracks t INDEXED BY idx_lastfm_tracks_user_album
    JOIN lastfm_scrobbles s INDEXED BY idx_lastfm_scrobbles_user_track_date
      ON s.track_id=t.id AND s.user_id=t.user_id
    WHERE t.user_id=${userId} AND t.album_id=${albumId} AND s.album_recorded<>1
  ), candidates AS (
    SELECT t.id FROM lastfm_tracks t INDEXED BY idx_lastfm_tracks_user_album
      WHERE t.user_id=${userId} AND t.album_id=${albumId} AND (
        NOT EXISTS (SELECT 1 FROM lastfm_scrobbles s INDEXED BY idx_lastfm_scrobbles_user_track_date WHERE s.user_id=${userId} AND s.track_id=t.id)
        OR EXISTS (SELECT 1 FROM lastfm_scrobbles s INDEXED BY idx_lastfm_scrobbles_user_track_date WHERE s.user_id=${userId} AND s.track_id=t.id AND s.album_recorded<>1)
      )
    UNION
    SELECT track_id FROM lastfm_scrobbles INDEXED BY idx_lastfm_scrobbles_user_album_date
      WHERE user_id=${userId} AND album_id=${albumId} AND album_recorded=1
  )
  SELECT t.id,t.name,t.apple_music_url AS "appleMusicUrl",
    t.preview_url AS "previewUrl",count(e.track_id) AS "scrobbleCount",
    min(e.scrobbled_at) AS "firstScrobbledAt"
  FROM candidates c JOIN lastfm_tracks t ON t.id=c.id AND t.user_id=${userId}
  LEFT JOIN events e ON e.track_id=t.id
  WHERE t.is_filtered=0 AND EXISTS(SELECT 1 FROM lastfm_albums a WHERE a.id=${albumId} AND a.user_id=${userId})
  GROUP BY t.id ORDER BY count(e.track_id) DESC,t.id`;
}

export async function albumTrackHistory(
  db: Database,
  albumId: number,
  userId: number
) {
  return db.all<AlbumTrackHistory>(albumTrackHistoryQuery(albumId, userId));
}

export async function artistAlbumHistory(
  db: Database,
  artistId: number,
  userId: number
) {
  return db.all<{
    id: number;
    name: string;
    appleMusicUrl: string | null;
    playcount: number;
  }>(sql`
    WITH events AS (
      SELECT a.id AS album_id,s.track_id
      FROM lastfm_albums a
      JOIN lastfm_scrobbles s INDEXED BY idx_lastfm_scrobbles_user_album_date
        ON s.album_id=a.id AND s.user_id=a.user_id AND s.album_recorded=1
      JOIN lastfm_tracks t ON t.id=s.track_id AND t.user_id=s.user_id AND t.is_filtered=0
      WHERE a.artist_id=${artistId} AND a.user_id=${userId} AND a.is_filtered=0
      UNION ALL
      SELECT a.id AS album_id,s.track_id
      FROM lastfm_albums a
      JOIN lastfm_tracks t INDEXED BY idx_lastfm_tracks_user_album
        ON t.album_id=a.id AND t.user_id=a.user_id AND t.is_filtered=0
      JOIN lastfm_scrobbles s INDEXED BY idx_lastfm_scrobbles_user_track_date
        ON s.track_id=t.id AND s.user_id=t.user_id AND s.album_recorded<>1
      WHERE a.artist_id=${artistId} AND a.user_id=${userId} AND a.is_filtered=0
    )
    SELECT a.id,a.name,a.apple_music_url AS "appleMusicUrl",count(*) AS playcount
    FROM events e JOIN lastfm_albums a ON a.id=e.album_id AND a.user_id=${userId}
    GROUP BY a.id HAVING count(DISTINCT e.track_id)>=2
    ORDER BY count(*) DESC,a.id LIMIT 10`);
}
