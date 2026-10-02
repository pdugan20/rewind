import { z } from 'zod';
import { createDb } from '../../db/client.js';
import { LastfmClient } from '../lastfm/client.js';
import { isFiltered } from '../lastfm/filters.js';
import { buildCdnUrl } from '../images/presets.js';
import type { Env } from '../../types/env.js';
import type { MusicCard, MovieCard } from './schema.js';
import { isPublicMusic, LATELY_OWNER_ID } from './policy.js';

const RecentTracks = z.object({
  recenttracks: z.object({
    track: z.array(
      z.object({
        name: z.string().min(1),
        artist: z.object({ '#text': z.string().min(1) }),
        album: z.object({ '#text': z.string() }).optional(),
        date: z.object({ uts: z.string().regex(/^\d+$/) }).optional(),
        '@attr': z.object({ nowplaying: z.string().optional() }).optional(),
      })
    ),
  }),
});

interface ImageRow {
  r2_key: string;
  image_version: number;
  thumbhash: string | null;
  dominant_color: string | null;
  accent_color: string | null;
}

async function imageFor(
  db: D1Database,
  domain: string,
  entity: string,
  id: number | null
) {
  if (id === null) return null;
  const row = await db
    .prepare(
      `SELECT r2_key, image_version, thumbhash,
    dominant_color, accent_color FROM images WHERE user_id = ? AND domain = ?
    AND entity_type = ? AND entity_id = ? AND r2_key <> '' LIMIT 1`
    )
    .bind(LATELY_OWNER_ID, domain, entity, String(id))
    .first<ImageRow>();
  if (!row) return null;
  const poster = domain === 'watching';
  return {
    cdn_url: buildCdnUrl(
      row.r2_key,
      poster ? 'poster-small' : 'small',
      row.image_version
    ),
    width: 150,
    height: poster ? 225 : 150,
    thumbhash: row.thumbhash,
    dominant_color: row.dominant_color,
    accent_color: row.accent_color,
  };
}

interface MusicMetadata {
  track_id: number | null;
  album_id: number | null;
  album_name: string | null;
  artist_filtered: number | null;
  track_filtered: number | null;
  album_filtered: number | null;
}

export async function musicCard(
  db: D1Database,
  item: {
    name: string;
    artist: string;
    album: string | null;
    scrobbled_at: string;
  }
): Promise<MusicCard | null> {
  if (
    !isPublicMusic(item.name, item.album) ||
    isFiltered({
      artistName: item.artist,
      albumName: item.album ?? undefined,
      trackName: item.name,
    })
  )
    return null;
  // Preserve canonical track -> album attribution, and scope every join.
  const row = await db
    .prepare(
      `SELECT t.id AS track_id, al.id AS album_id,
    al.name AS album_name, a.is_filtered AS artist_filtered,
    t.is_filtered AS track_filtered, al.is_filtered AS album_filtered
    FROM lastfm_artists a
    LEFT JOIN lastfm_tracks t ON t.artist_id = a.id AND t.name = ? AND t.user_id = ?
    LEFT JOIN lastfm_albums al ON al.id = t.album_id AND al.user_id = ?
    WHERE a.name = ? AND a.user_id = ? LIMIT 1`
    )
    .bind(
      item.name,
      LATELY_OWNER_ID,
      LATELY_OWNER_ID,
      item.artist,
      LATELY_OWNER_ID
    )
    .first<MusicMetadata>();
  if (row?.artist_filtered || row?.track_filtered || row?.album_filtered)
    return null;
  const album = row?.album_name ?? item.album;
  if (
    !isPublicMusic(item.name, album) ||
    isFiltered({
      artistName: item.artist,
      albumName: album ?? undefined,
      trackName: item.name,
    })
  )
    return null;
  const bytes = new TextEncoder().encode(
    JSON.stringify([item.artist, item.name, item.scrobbled_at])
  );
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const eventId = Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
  return {
    event_id: `scrobble:${eventId}`,
    track_id: row?.track_id ?? null,
    name: item.name,
    artist: item.artist,
    album,
    scrobbled_at: item.scrobbled_at,
    image: await imageFor(db, 'listening', 'albums', row?.album_id ?? null),
  };
}

export async function storedMusic(db: D1Database): Promise<MusicCard | null> {
  const { results } = await db
    .prepare(
      `SELECT t.name, a.name AS artist,
    al.name AS album, s.scrobbled_at FROM lastfm_scrobbles s
    INNER JOIN lastfm_tracks t ON t.id = s.track_id AND t.user_id = ?
    INNER JOIN lastfm_artists a ON a.id = t.artist_id AND a.user_id = ?
    LEFT JOIN lastfm_albums al ON al.id = t.album_id AND al.user_id = ?
    WHERE s.user_id = ? AND COALESCE(t.is_filtered, 0) = 0
    AND COALESCE(a.is_filtered, 0) = 0 AND COALESCE(al.is_filtered, 0) = 0
    ORDER BY s.scrobbled_at DESC, s.id DESC LIMIT 50`
    )
    .bind(LATELY_OWNER_ID, LATELY_OWNER_ID, LATELY_OWNER_ID, LATELY_OWNER_ID)
    .all<{
      name: string;
      artist: string;
      album: string | null;
      scrobbled_at: string;
    }>();
  for (const row of results) {
    const card = await musicCard(db, row);
    if (card) return card;
  }
  return null;
}

export async function latestMusic(env: Env): Promise<MusicCard | null> {
  // The homepage means "last listened", not live playback. Completed
  // scrobbles provide a truthful timestamp and stable event identity.
  const client = new LastfmClient(
    env.LASTFM_API_KEY,
    env.LASTFM_USERNAME,
    AbortSignal.timeout(8_000)
  );
  const parsed = RecentTracks.parse(
    await client.getRecentTracks({ limit: 50 })
  );
  const candidates = parsed.recenttracks.track
    .filter((t) => t['@attr']?.nowplaying !== 'true' && t.date)
    .sort((a, b) => Number(b.date!.uts) - Number(a.date!.uts));
  for (const track of candidates) {
    const time = Number(track.date!.uts) * 1000;
    if (!Number.isFinite(time) || time <= 0 || time > Date.now() + 60_000)
      continue;
    const card = await musicCard(env.DB, {
      name: track.name,
      artist: track.artist['#text'],
      album: track.album?.['#text'] || null,
      scrobbled_at: new Date(time).toISOString(),
    });
    if (card) return card;
  }
  return storedMusic(env.DB);
}

export async function latestMovie(
  db: D1Database,
  excluded: number[]
): Promise<MovieCard | null> {
  const exclusion = excluded.length
    ? `AND m.id NOT IN (${excluded.map(() => '?').join(',')})`
    : '';
  const row = await db
    .prepare(
      `SELECT w.id AS watch_id, m.id AS movie_id,
    m.title, m.year, m.content_rating, m.runtime AS runtime_minutes,
    w.watched_at, w.user_rating FROM watch_history w
    INNER JOIN movies m ON m.id = w.movie_id AND m.user_id = ?
    WHERE w.user_id = ? ${exclusion}
    ORDER BY w.watched_at DESC, w.id DESC LIMIT 1`
    )
    .bind(LATELY_OWNER_ID, LATELY_OWNER_ID, ...excluded)
    .first<
      Omit<MovieCard, 'image' | 'directors' | 'event_id'> & { watch_id: number }
    >();
  if (!row) return null;
  const [art, people] = await Promise.all([
    imageFor(db, 'watching', 'movies', row.movie_id),
    db
      .prepare(
        `SELECT d.name FROM directors d
      INNER JOIN movie_directors md ON md.director_id = d.id
      INNER JOIN movies m ON m.id = md.movie_id AND m.user_id = ?
      WHERE m.id = ? ORDER BY d.name, d.id`
      )
      .bind(LATELY_OWNER_ID, row.movie_id)
      .all<{ name: string }>(),
  ]);
  const { watch_id, ...movie } = row;
  return {
    ...movie,
    event_id: `watch:${watch_id}`,
    directors: people.results.map((p) => p.name),
    image: art,
  };
}

// Keep Drizzle's shared filter loader at the single configured owner boundary.
export const latelyDb = (env: Env) => createDb(env.DB);
