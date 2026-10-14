/**
 * Prepared recent-albums shelf for a CD-player client.
 *
 * Built after each scrobble sync and stored as one row, so the read route is a
 * single primary-key lookup. Each album carries its catalog tracklist in
 * disc/track order when one is stored, and falls back to the songs actually
 * played from it. Everything a client might want to experiment with is
 * included (all image sizes, Apple Music ids and links, per-track play counts
 * and last-played times); clients choose what to display.
 */

import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  lastfmAlbumTracks,
  lastfmAlbums,
  lastfmArtists,
  lastfmScrobbles,
  lastfmTracks,
  listeningDiscmanSnapshots,
} from '../../db/schema/lastfm.js';
import { images } from '../../db/schema/system.js';
import { scrobbleAlbumId } from '../../lib/scrobble-album.js';
import { buildCdnUrl } from '../images/presets.js';
import { trackMatches } from '../images/sources/utils.js';
import {
  DISCMAN_ALBUM_LIMIT,
  DiscmanAlbum as DiscmanAlbumSchema,
  DiscmanSnapshot,
  type DiscmanAlbum,
  type DiscmanImage,
  type DiscmanTrack,
} from './schema.js';

const SCAN_BATCH_SIZE = 100;
// Album-wise listening spends ~10-15 scrobbles per album, so 12 albums
// usually resolve in the first few hundred rows. The cap bounds a pathological
// history (one album on repeat) without imposing a time window.
const SCAN_LIMIT = 3000;

interface ScanRow {
  scrobbleId: number;
  scrobbledAt: string;
  trackFiltered: number | null;
  albumId: number | null;
  albumFiltered: number | null;
  artistFiltered: number | null;
}

interface SelectedAlbum {
  albumId: number;
  lastPlayedAt: string;
}

/** Newest-first distinct albums, skipping filtered tracks, albums and artists. */
export async function selectRecentAlbums(
  db: Database,
  userId: number,
  limit = DISCMAN_ALBUM_LIMIT
): Promise<SelectedAlbum[]> {
  const selected = new Map<number, SelectedAlbum>();
  let inspected = 0;
  let cursor: { at: string; id: number } | null = null;
  while (selected.size < limit && inspected < SCAN_LIMIT) {
    const take = Math.min(SCAN_BATCH_SIZE, SCAN_LIMIT - inspected);
    const cursorCondition: SQL | undefined = cursor
      ? sql<boolean>`(${lastfmScrobbles.scrobbledAt}, ${lastfmScrobbles.id}) < (${cursor.at}, ${cursor.id})`
      : undefined;
    const rows: ScanRow[] = await db
      .select({
        scrobbleId: lastfmScrobbles.id,
        scrobbledAt: lastfmScrobbles.scrobbledAt,
        trackFiltered: lastfmTracks.isFiltered,
        albumId: lastfmAlbums.id,
        albumFiltered: lastfmAlbums.isFiltered,
        artistFiltered: lastfmArtists.isFiltered,
      })
      .from(lastfmScrobbles)
      .innerJoin(
        lastfmTracks,
        and(
          eq(lastfmScrobbles.trackId, lastfmTracks.id),
          eq(lastfmScrobbles.userId, lastfmTracks.userId)
        )
      )
      .leftJoin(
        lastfmAlbums,
        and(
          eq(scrobbleAlbumId, lastfmAlbums.id),
          eq(lastfmAlbums.userId, lastfmScrobbles.userId)
        )
      )
      .leftJoin(
        lastfmArtists,
        and(
          eq(lastfmAlbums.artistId, lastfmArtists.id),
          eq(lastfmAlbums.userId, lastfmArtists.userId)
        )
      )
      .where(and(eq(lastfmScrobbles.userId, userId), cursorCondition))
      .orderBy(desc(lastfmScrobbles.scrobbledAt), desc(lastfmScrobbles.id))
      .limit(take);
    if (rows.length === 0) break;
    inspected += rows.length;
    for (const row of rows) {
      if (
        row.albumId === null ||
        row.trackFiltered === 1 ||
        row.albumFiltered === 1 ||
        row.artistFiltered === null ||
        row.artistFiltered === 1 ||
        selected.has(row.albumId)
      )
        continue;
      selected.set(row.albumId, {
        albumId: row.albumId,
        lastPlayedAt: row.scrobbledAt,
      });
      if (selected.size === limit) break;
    }
    const last = rows.at(-1)!;
    cursor = { at: last.scrobbledAt, id: last.scrobbleId };
    if (rows.length < take) break;
  }
  return [...selected.values()];
}

function httpsUrl(value: string | null, host?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (host && url.hostname !== host) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const appleMusicUrl = (value: string | null) =>
  httpsUrl(value, 'music.apple.com');
const previewUrl = (value: string | null) =>
  httpsUrl(value, 'audio-ssl.itunes.apple.com');

// Stored durations can be 0 when a provider reported no length; the contract
// only admits positive milliseconds.
const durationMs = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;

async function imagesFor(
  db: Database,
  userId: number,
  entityType: 'albums' | 'artists',
  ids: number[]
): Promise<Map<number, DiscmanImage>> {
  const map = new Map<number, DiscmanImage>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      entityId: images.entityId,
      r2Key: images.r2Key,
      thumbhash: images.thumbhash,
      dominantColor: images.dominantColor,
      accentColor: images.accentColor,
      imageVersion: images.imageVersion,
    })
    .from(images)
    .where(
      and(
        eq(images.domain, 'listening'),
        eq(images.entityType, entityType),
        eq(images.userId, userId),
        inArray(images.entityId, ids.map(String))
      )
    );
  for (const row of rows) {
    if (!row.r2Key) continue;
    const url = (size: string) =>
      buildCdnUrl(row.r2Key, size, row.imageVersion);
    map.set(Number(row.entityId), {
      thumbhash: row.thumbhash,
      dominant_color: row.dominantColor,
      accent_color: row.accentColor,
      urls: {
        thumbnail: url('thumbnail'),
        small: url('small'),
        medium: url('medium'),
        large: url('large'),
      },
    });
  }
  return map;
}

interface PlayedTrack {
  album_id: number;
  track_id: number;
  name: string;
  is_filtered: number;
  apple_music_id: number | null;
  apple_music_url: string | null;
  preview_url: string | null;
  duration_ms: number | null;
  play_count: number;
  last_played_at: string;
}

/**
 * Per-track play counts for the selected albums. The two halves mirror
 * scrobbleAlbumId so each half can use an owner/album index instead of
 * evaluating the CASE across the whole history.
 */
function playedTracks(db: Database, userId: number, albumIds: number[]) {
  const ids = sql.join(
    albumIds.map((id) => sql`${id}`),
    sql`, `
  );
  return db.all<PlayedTrack>(sql`
    SELECT p.album_id, t.id AS track_id, t.name, t.is_filtered,
      t.apple_music_id, t.apple_music_url, t.preview_url, t.duration_ms,
      COUNT(*) AS play_count, MAX(p.scrobbled_at) AS last_played_at
    FROM (
      SELECT s.album_id AS album_id, s.track_id, s.scrobbled_at
      FROM lastfm_scrobbles s
      WHERE s.user_id = ${userId} AND s.album_recorded = 1
        AND s.album_id IN (${ids})
      UNION ALL
      SELECT t.album_id AS album_id, s.track_id, s.scrobbled_at
      FROM lastfm_tracks t
      JOIN lastfm_scrobbles s ON s.track_id = t.id AND s.user_id = t.user_id
      WHERE t.user_id = ${userId} AND s.album_recorded = 0
        AND t.album_id IN (${ids})
    ) p
    JOIN lastfm_tracks t ON t.id = p.track_id AND t.user_id = ${userId}
    GROUP BY p.album_id, t.id
    ORDER BY p.album_id, t.id
  `);
}

function playedToTrack(played: PlayedTrack, position: number): DiscmanTrack {
  return {
    position,
    disc_number: null,
    track_number: null,
    name: played.name,
    duration_ms: durationMs(played.duration_ms),
    isrc: null,
    apple_music_id: played.apple_music_id,
    apple_music_url: appleMusicUrl(played.apple_music_url),
    preview_url: previewUrl(played.preview_url),
    track_id: played.track_id,
    play_count: Number(played.play_count),
    last_played_at: played.last_played_at,
  };
}

export async function buildDiscmanSnapshot(
  db: Database,
  userId: number,
  now = new Date(),
  preselected?: SelectedAlbum[]
): Promise<DiscmanSnapshot> {
  const selected = preselected ?? (await selectRecentAlbums(db, userId));
  const albumIds = selected.map((album) => album.albumId);
  if (albumIds.length === 0)
    return { schema_version: 1, built_at: now.toISOString(), albums: [] };

  const [albumRows, catalogRows, played, albumImages] = await Promise.all([
    db
      .select({
        id: lastfmAlbums.id,
        name: lastfmAlbums.name,
        url: lastfmAlbums.url,
        appleMusicId: lastfmAlbums.appleMusicId,
        appleMusicUrl: lastfmAlbums.appleMusicUrl,
        releasedYear: lastfmAlbums.releasedYear,
        totalTracks: lastfmAlbums.totalTracks,
        artistId: lastfmArtists.id,
        artistName: lastfmArtists.name,
        artistUrl: lastfmArtists.url,
        artistAppleMusicId: lastfmArtists.appleMusicId,
        artistAppleMusicUrl: lastfmArtists.appleMusicUrl,
        artistGenre: lastfmArtists.genre,
      })
      .from(lastfmAlbums)
      .innerJoin(
        lastfmArtists,
        and(
          eq(lastfmAlbums.artistId, lastfmArtists.id),
          eq(lastfmAlbums.userId, lastfmArtists.userId)
        )
      )
      .where(
        and(eq(lastfmAlbums.userId, userId), inArray(lastfmAlbums.id, albumIds))
      ),
    db
      .select()
      .from(lastfmAlbumTracks)
      .where(
        and(
          eq(lastfmAlbumTracks.userId, userId),
          inArray(lastfmAlbumTracks.albumId, albumIds)
        )
      )
      .orderBy(
        lastfmAlbumTracks.albumId,
        lastfmAlbumTracks.discNumber,
        lastfmAlbumTracks.trackNumber
      ),
    playedTracks(db, userId, albumIds),
    imagesFor(db, userId, 'albums', albumIds),
  ]);
  const artistImages = await imagesFor(db, userId, 'artists', [
    ...new Set(albumRows.map((row) => row.artistId)),
  ]);

  const albumsById = new Map(albumRows.map((row) => [row.id, row]));
  const albums: DiscmanAlbum[] = [];
  for (const { albumId, lastPlayedAt } of selected) {
    const album = albumsById.get(albumId);
    if (!album) continue;
    const plays = played.filter((row) => row.album_id === albumId);
    const catalog = catalogRows.filter((row) => row.albumId === albumId);
    const filteredPlays = plays.filter((row) => row.is_filtered === 1);
    const audiblePlays = plays.filter((row) => row.is_filtered !== 1);

    let tracks: DiscmanTrack[];
    let source: DiscmanAlbum['tracklist_source'];
    if (catalog.length > 0) {
      source = 'catalog';
      tracks = [];
      const sameId = (row: (typeof catalog)[number], p: PlayedTrack) =>
        p.apple_music_id !== null && p.apple_music_id === row.appleMusicId;
      const sameName = (row: (typeof catalog)[number], p: PlayedTrack) =>
        trackMatches(row.name, p.name);
      // A catalog song the owner filtered out (an audiobook chapter, a
      // skit) stays out of the shelf.
      const shown = catalog.filter(
        (row) => !filteredPlays.some((p) => sameId(row, p) || sameName(row, p))
      );
      // Each played song attaches to one catalog row: exact catalog ids
      // first, then names, so a title repeated across discs or editions
      // does not count the same plays twice.
      const matches = new Map<number, PlayedTrack>();
      const claimed = new Set<number>();
      for (const same of [sameId, sameName])
        for (const row of shown) {
          if (matches.has(row.id)) continue;
          const match = audiblePlays.find(
            (p) => !claimed.has(p.track_id) && same(row, p)
          );
          if (!match) continue;
          matches.set(row.id, match);
          claimed.add(match.track_id);
        }
      for (const row of shown) {
        const match = matches.get(row.id);
        tracks.push({
          position: tracks.length + 1,
          disc_number: row.discNumber,
          track_number: row.trackNumber,
          name: row.name,
          duration_ms:
            durationMs(row.durationMs) ?? durationMs(match?.duration_ms),
          isrc: row.isrc,
          apple_music_id: row.appleMusicId,
          apple_music_url: appleMusicUrl(row.appleMusicUrl),
          preview_url:
            previewUrl(row.previewUrl) ??
            previewUrl(match?.preview_url ?? null),
          track_id: match?.track_id ?? null,
          play_count: match ? Number(match.play_count) : 0,
          last_played_at: match?.last_played_at ?? null,
        });
      }
    } else {
      source = 'listens';
      // Track ids grow as songs are first heard, which approximates album
      // order for album-wise listening.
      tracks = audiblePlays.map((row, index) => playedToTrack(row, index + 1));
    }

    const candidate: DiscmanAlbum = {
      id: album.id,
      name: album.name,
      url: album.url,
      apple_music_id: album.appleMusicId,
      apple_music_url: appleMusicUrl(album.appleMusicUrl),
      released_year: album.releasedYear,
      total_tracks: album.totalTracks,
      image: albumImages.get(album.id) ?? null,
      artist: {
        id: album.artistId,
        name: album.artistName,
        url: album.artistUrl,
        apple_music_id: album.artistAppleMusicId,
        apple_music_url: appleMusicUrl(album.artistAppleMusicUrl),
        genre: album.artistGenre,
        image: artistImages.get(album.artistId) ?? null,
      },
      last_played_at: lastPlayedAt,
      play_count: audiblePlays.reduce(
        (sum, row) => sum + Number(row.play_count),
        0
      ),
      tracklist_source: source,
      tracks,
    };
    // One malformed stored value must not take down the whole shelf.
    const parsed = DiscmanAlbumSchema.safeParse(candidate);
    if (parsed.success) albums.push(parsed.data);
    else
      console.log(
        `[ERROR] Discman album ${album.id} skipped: ${parsed.error.issues
          .map((issue) => issue.path.join('.'))
          .join(', ')}`
      );
  }
  return DiscmanSnapshot.parse({
    schema_version: 1,
    built_at: now.toISOString(),
    albums,
  });
}

/** Build and store the owner's shelf. Returns the stored snapshot. */
export async function publishDiscmanSnapshot(
  db: Database,
  userId: number,
  preselected?: SelectedAlbum[]
): Promise<DiscmanSnapshot> {
  const snapshot = await buildDiscmanSnapshot(
    db,
    userId,
    new Date(),
    preselected
  );
  const value = {
    userId,
    snapshot: JSON.stringify(snapshot),
    builtAt: snapshot.built_at,
  };
  await db
    .insert(listeningDiscmanSnapshots)
    .values(value)
    .onConflictDoUpdate({
      target: listeningDiscmanSnapshots.userId,
      set: { snapshot: value.snapshot, builtAt: value.builtAt },
    });
  return snapshot;
}

export async function readDiscmanSnapshot(
  db: Database,
  userId: number
): Promise<DiscmanSnapshot | null> {
  const [row] = await db
    .select({ snapshot: listeningDiscmanSnapshots.snapshot })
    .from(listeningDiscmanSnapshots)
    .where(eq(listeningDiscmanSnapshots.userId, userId))
    .limit(1);
  if (!row) return null;
  // A row written under an older contract is rebuilt rather than served.
  try {
    const parsed = DiscmanSnapshot.safeParse(JSON.parse(row.snapshot));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
