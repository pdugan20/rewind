/**
 * Apple Music catalog tracklist enrichment.
 *
 * Scrobbles only tell us which songs were played. A CD-style player needs the
 * album as released: every song in disc/track order with its preview. This
 * reads the album from the catalog API with its tracks relationship and
 * stores the whole tracklist in lastfm_album_tracks.
 *
 *   GET https://api.music.apple.com/v1/catalog/us/albums/{id}?include=tracks
 *
 * Uses the same developer token and identity checks as album.ts. A matched
 * read replaces the album's rows as one set; transient failures leave the
 * stored tracklist and retry timestamp untouched; confirmed no-matches are
 * cooled down by tracklist_synced_at like apple_music_enriched_at.
 */

import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  lastfmAlbumTracks,
  lastfmAlbums,
  lastfmArtists,
  lastfmScrobbles,
  lastfmTracks,
} from '../../db/schema/lastfm.js';
import {
  albumMatches,
  artistIdentityMatches,
} from '../images/sources/utils.js';
import { findCatalogAlbum, type CatalogAlbum } from './catalog-album.js';

const API_ORIGIN = 'https://api.music.apple.com';
const CATALOG_BASE = `${API_ORIGIN}/v1/catalog/us/albums`;
const NINETY_DAYS_AGO_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')";
// The tracks relationship pages at 300; box sets beyond a few pages are not
// worth more catalog calls for a preview player.
const MAX_TRACK_PAGES = 4;
const PREVIEW_HOST = 'audio-ssl.itunes.apple.com';
// D1 binds at most 100 parameters per statement and counts every statement
// toward the invocation's query limit. A row binds 12 values, so 8 rows per
// insert keeps a long tracklist to a handful of statements.
const ROWS_PER_INSERT = 8;
// Throttling or a rejected developer token fails every remaining album the
// same way; stop and let the next sync retry.
const STOP_STATUSES = new Set([401, 403, 429]);

interface CatalogSong {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    artistName?: string;
    discNumber?: number;
    trackNumber?: number;
    durationInMillis?: number;
    isrc?: string;
    url?: string;
    previews?: Array<{ url?: string }>;
  };
}

interface TrackPage {
  data?: CatalogSong[];
  next?: string;
}

interface CatalogAlbumWithTracks {
  data?: Array<{
    id: string;
    type: string;
    attributes?: { name?: string; artistName?: string };
    relationships?: { tracks?: TrackPage };
  }>;
}

interface CatalogTrack {
  appleMusicId: number;
  discNumber: number;
  trackNumber: number;
  name: string;
  artistName: string | null;
  durationMs: number | null;
  isrc: string | null;
  previewUrl: string | null;
  appleMusicUrl: string | null;
}

type TracklistResult =
  | { status: 'matched'; tracks: CatalogTrack[] }
  | { status: 'no_match' }
  | { status: 'error'; stop?: boolean };

// Words that name a packaging of the same recordings. Recording variants such
// as instrumental, acoustic, remix, sped-up or re-recorded ("Taylor's
// Version") are deliberately absent.
const EDITION_WORDS =
  "(?:\\d+\\s*am|til dawn|(?:super )?deluxe|expanded|(?:\\d+(?:st|nd|rd|th) )?anniversary|special|bonus(?: tracks?)?|collector'?s|complete|platinum|international|tour|\\d{4})";
// A whole trailing bracket: "(Live)", "(3am Edition)", "(The Til Dawn
// Edition)", "(Deluxe)" or "(Remastered 2011)". Never "(Live at Wembley)".
const EDITION_QUALIFIER = new RegExp(
  `\\s*[([](?:live|(?:the )?(?:${EDITION_WORDS} )*(?:edition|version)|(?:\\d{4} )?remaster(?:ed)?(?: \\d{4})?|(?:super )?deluxe|expanded)[)\\]]\\s*$`,
  'i'
);

/**
 * The stored catalog id was chosen from the songs actually played, so the
 * catalog may name that edition: "Midnights (3am Edition)" or
 * "From the Muddy Banks of the Wishkah (Live)" for a bare stored title.
 * Only the catalog side drops such qualifiers; a different title, or a
 * stored qualifier the catalog lacks, still fails.
 */
export function tracklistTitleMatches(
  stored: string,
  catalog: string,
  artistName: string
): boolean {
  if (albumMatches(stored, catalog, artistName)) return true;
  let bare = catalog;
  while (EDITION_QUALIFIER.test(bare))
    bare = bare.replace(EDITION_QUALIFIER, '');
  return bare !== catalog && albumMatches(stored, bare, artistName);
}

async function getJson<T>(
  url: string,
  developerToken: string
): Promise<{ ok: true; body: T } | { ok: false; status: number | null }> {
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${developerToken}` },
    });
    if (!resp.ok) return { ok: false, status: resp.status };
    return { ok: true, body: (await resp.json()) as T };
  } catch {
    return { ok: false, status: null };
  }
}

function previewUrl(song: CatalogSong): string | null {
  const raw = song.attributes?.previews?.[0]?.url;
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === PREVIEW_HOST
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function toTrack(song: CatalogSong): CatalogTrack | null {
  const a = song.attributes;
  const id = Number(song.id);
  if (
    song.type !== 'songs' ||
    !a ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof a.name !== 'string' ||
    !a.name ||
    typeof a.trackNumber !== 'number' ||
    a.trackNumber <= 0
  )
    return null;
  return {
    appleMusicId: id,
    discNumber:
      typeof a.discNumber === 'number' && a.discNumber > 0 ? a.discNumber : 1,
    trackNumber: a.trackNumber,
    name: a.name,
    artistName: typeof a.artistName === 'string' ? a.artistName : null,
    durationMs:
      typeof a.durationInMillis === 'number' && a.durationInMillis > 0
        ? a.durationInMillis
        : null,
    isrc: typeof a.isrc === 'string' && a.isrc ? a.isrc : null,
    previewUrl: previewUrl(song),
    appleMusicUrl:
      typeof a.url === 'string' && a.url.startsWith('https://music.apple.com/')
        ? a.url
        : null,
  };
}

/**
 * Fetch one album's catalog tracklist after validating album and artist
 * identity. Music videos and malformed rows are dropped; duplicate positions
 * keep the first row so the stored set satisfies the position unique index.
 */
export async function fetchAlbumTracklist(
  developerToken: string,
  appleMusicId: number,
  expected: { name: string; artistName: string }
): Promise<TracklistResult> {
  const first = await getJson<CatalogAlbumWithTracks>(
    `${CATALOG_BASE}/${appleMusicId}?include=tracks`,
    developerToken
  );
  if (!first.ok) {
    console.log(
      `[WARN] Apple Music tracklist /albums/${appleMusicId} returned ${first.status ?? 'network error'}`
    );
    if (first.status === 404) return { status: 'no_match' };
    return {
      status: 'error',
      stop: first.status !== null && STOP_STATUSES.has(first.status),
    };
  }
  const album = (Array.isArray(first.body?.data) ? first.body.data : []).find(
    (item) => item?.id === String(appleMusicId) && item.type === 'albums'
  );
  const attrs = album?.attributes;
  if (!attrs) return { status: 'error' };
  if (
    typeof attrs.name !== 'string' ||
    typeof attrs.artistName !== 'string' ||
    !tracklistTitleMatches(expected.name, attrs.name, expected.artistName) ||
    !artistIdentityMatches(expected.artistName, attrs.artistName)
  )
    return { status: 'no_match' };

  const songs: CatalogSong[] = [];
  let page: TrackPage | undefined = album?.relationships?.tracks;
  for (let n = 0; page && n < MAX_TRACK_PAGES; n++) {
    if (Array.isArray(page.data)) songs.push(...page.data);
    // `next` is a path on the API origin; never follow anything else.
    if (typeof page.next !== 'string' || !page.next.startsWith('/v1/')) break;
    const more = await getJson<TrackPage>(
      `${API_ORIGIN}${page.next}`,
      developerToken
    );
    if (!more.ok)
      return {
        status: 'error',
        stop: more.status !== null && STOP_STATUSES.has(more.status),
      };
    page = more.body;
  }

  const seen = new Set<string>();
  const tracks: CatalogTrack[] = [];
  for (const song of songs) {
    const track = toTrack(song);
    if (!track) continue;
    const position = `${track.discNumber}:${track.trackNumber}`;
    if (seen.has(position)) continue;
    seen.add(position);
    tracks.push(track);
  }
  if (tracks.length === 0) return { status: 'no_match' };
  tracks.sort(
    (a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber
  );
  return { status: 'matched', tracks };
}

/** A song played from this album, used to confirm a catalog album. */
async function playedSong(
  db: Database,
  userId: number,
  albumId: number
): Promise<string | null> {
  const [recorded] = await db
    .select({ name: lastfmTracks.name })
    .from(lastfmScrobbles)
    .innerJoin(
      lastfmTracks,
      and(
        eq(lastfmTracks.id, lastfmScrobbles.trackId),
        eq(lastfmTracks.userId, lastfmScrobbles.userId)
      )
    )
    .where(
      and(
        eq(lastfmScrobbles.userId, userId),
        eq(lastfmScrobbles.albumId, albumId),
        eq(lastfmScrobbles.albumRecorded, 1)
      )
    )
    .orderBy(desc(lastfmScrobbles.scrobbledAt))
    .limit(1);
  if (recorded) return recorded.name;
  const [track] = await db
    .select({ name: lastfmTracks.name })
    .from(lastfmTracks)
    .where(
      and(eq(lastfmTracks.userId, userId), eq(lastfmTracks.albumId, albumId))
    )
    .limit(1);
  return track?.name ?? null;
}

/**
 * The catalog album to use when the stored Apple Music id names a different
 * release (Wilco's "Star Wars" was stored as the "Alpha Mike Foxtrot" box).
 * Searched by album name and confirmed by a played song on its tracklist,
 * then held to the same title and artist identity as any stored id.
 * 'retry' means the lookup itself failed; the album stays unstamped.
 */
async function recoverCatalogAlbum(
  db: Database,
  developerToken: string,
  album: { id: number; name: string; artistName: string; appleMusicId: number },
  userId: number
): Promise<CatalogAlbum | 'retry' | null> {
  const song = await playedSong(db, userId, album.id);
  if (!song) return null;
  const found = await findCatalogAlbum(developerToken, album.name, {
    track: song,
    artist: album.artistName,
  });
  if (found.status === 'rate_limited' || found.status === 'error')
    return 'retry';
  if (found.status !== 'found' || found.album.id === album.appleMusicId)
    return null;
  return tracklistTitleMatches(
    album.name,
    found.album.name,
    album.artistName
  ) && artistIdentityMatches(album.artistName, found.album.artistName)
    ? found.album
    : null;
}

/**
 * Store catalog tracklists for the given albums when missing or older than
 * 90 days. Bounded by the caller's id list, so a sync only spends catalog
 * calls on albums it is about to show.
 */
export async function syncAlbumTracklists(
  db: Database,
  developerToken: string,
  albumIds: number[],
  userId = 1
): Promise<{ stored: number; skipped: number }> {
  if (albumIds.length === 0) return { stored: 0, skipped: 0 };
  const candidates = await db
    .select({
      id: lastfmAlbums.id,
      name: lastfmAlbums.name,
      artistName: lastfmArtists.name,
      appleMusicId: lastfmAlbums.appleMusicId,
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
      and(
        eq(lastfmAlbums.userId, userId),
        inArray(lastfmAlbums.id, albumIds),
        eq(lastfmAlbums.isFiltered, 0),
        eq(lastfmAlbums.identityConflict, 0),
        eq(lastfmArtists.isFiltered, 0),
        eq(lastfmArtists.identityConflict, 0),
        sql`${lastfmAlbums.appleMusicId} IS NOT NULL`,
        or(
          isNull(lastfmAlbums.tracklistSyncedAt),
          lt(lastfmAlbums.tracklistSyncedAt, sql.raw(NINETY_DAYS_AGO_SQL))
        )
      )
    );

  let stored = 0;
  let skipped = 0;
  for (const album of candidates) {
    if (album.appleMusicId == null) continue;
    let result = await fetchAlbumTracklist(developerToken, album.appleMusicId, {
      name: album.name,
      artistName: album.artistName,
    });
    if (result.status === 'error') {
      skipped++;
      if (result.stop) break;
      continue;
    }
    const now = new Date().toISOString();
    let corrected: CatalogAlbum | null = null;
    if (result.status === 'no_match') {
      const recovered = await recoverCatalogAlbum(
        db,
        developerToken,
        { ...album, appleMusicId: album.appleMusicId },
        userId
      );
      if (recovered === 'retry') {
        skipped++;
        continue;
      }
      if (recovered) {
        const recheck = await fetchAlbumTracklist(
          developerToken,
          recovered.id,
          {
            name: album.name,
            artistName: album.artistName,
          }
        );
        if (recheck.status === 'error') {
          skipped++;
          if (recheck.stop) break;
          continue;
        }
        if (recheck.status === 'matched') {
          result = recheck;
          corrected = recovered;
        }
      }
    }
    // Guarded on the id read above, so a concurrent change is not overwritten.
    const stamp = db
      .update(lastfmAlbums)
      .set({
        tracklistSyncedAt: now,
        updatedAt: now,
        ...(corrected
          ? { appleMusicId: corrected.id, appleMusicUrl: corrected.url }
          : {}),
      })
      .where(
        and(
          eq(lastfmAlbums.id, album.id),
          eq(lastfmAlbums.userId, userId),
          eq(lastfmAlbums.appleMusicId, album.appleMusicId)
        )
      );
    if (result.status === 'no_match') {
      await stamp;
      skipped++;
      continue;
    }
    if (corrected)
      console.log(
        `[ENRICH] album ${album.id} catalog id ${album.appleMusicId} -> ${corrected.id}`
      );
    const clear = db
      .delete(lastfmAlbumTracks)
      .where(
        and(
          eq(lastfmAlbumTracks.userId, userId),
          eq(lastfmAlbumTracks.albumId, album.id)
        )
      );
    const rows = result.tracks.map((track) => ({
      userId,
      albumId: album.id,
      ...track,
      syncedAt: now,
    }));
    const inserts = [];
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT)
      inserts.push(
        db.insert(lastfmAlbumTracks).values(rows.slice(i, i + ROWS_PER_INSERT))
      );
    try {
      // One atomic batch: readers never see a half-replaced tracklist.
      await db.batch([stamp, clear, ...inserts]);
      stored++;
    } catch (err) {
      // Leave this album unstamped for a later retry; keep going.
      console.log(
        `[ERROR] Tracklist store failed for album ${album.id}: ${err instanceof Error ? err.message : String(err)}`
      );
      skipped++;
    }
  }
  return { stored, skipped };
}
