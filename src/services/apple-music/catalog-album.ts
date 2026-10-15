/**
 * Finds the Apple Music catalog album a play came from, by album name.
 *
 * Used by the album check (src/services/itunes/album-enrich.ts). The iTunes
 * Search API rate-limits Cloudflare's shared egress, and a song search for a
 * well-known track returns the artist's own albums; the catalog API is
 * authenticated with the developer token, and searching by album name finds
 * soundtracks directly:
 *
 *   GET https://api.music.apple.com/v1/catalog/us/search?types=albums&term=…
 *   GET https://api.music.apple.com/v1/catalog/us/albums/{id}?include=tracks
 *
 * A candidate counts only when its title matches the played album and the
 * played song is on its tracklist, so the album artist it reports (for
 * example "Various Artists") describes the release that was played. A
 * candidate whose track is credited to the played artist wins. Without one
 * (dialogue clips are credited to the actors, not the character Last.fm
 * reports), only a single candidate holding the song is accepted; ambiguity
 * decides nothing.
 *
 * A short or common album name can be crowded out of the search by other
 * artists' releases ("Star Wars" returns ten John Williams scores before
 * Wilco's album), so a search that confirms nothing is repeated once with
 * the played artist's name added to the term.
 */

import {
  albumMatches,
  artistIdentityMatches,
  trackMatches,
} from '../images/sources/utils.js';

const ORIGIN = 'https://api.music.apple.com';
const API = `${ORIGIN}/v1/catalog/us`;
/** Tracklist pages followed per album; Apple pages relationships. */
const TRACK_PAGES = 5;
/** Candidates whose tracklists are opened per lookup. */
const CANDIDATES = 3;

export interface CatalogAlbum {
  id: number;
  name: string;
  artistName: string;
  url: string;
}

export type CatalogAlbumResult =
  | { status: 'found'; album: CatalogAlbum }
  | { status: 'no_match' }
  | { status: 'rate_limited' }
  | { status: 'error'; detail: string };

interface CatalogTrack {
  attributes?: { name?: string; artistName?: string };
}
interface TrackPage {
  data?: CatalogTrack[];
  next?: string;
}
interface CatalogAlbumResource {
  id?: string;
  type?: string;
  attributes?: { name?: string; artistName?: string; url?: string };
  relationships?: { tracks?: TrackPage };
}

async function get<T>(
  path: string,
  token: string
): Promise<{ ok: true; body: T } | { ok: false; status: number }> {
  const response = await fetch(
    path.startsWith('/v1/') ? `${ORIGIN}${path}` : `${API}${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, body: (await response.json()) as T };
}

const failure = (status: number): CatalogAlbumResult =>
  status === 429
    ? { status: 'rate_limited' }
    : { status: 'error', detail: `Apple Music HTTP ${status}` };

export async function findCatalogAlbum(
  token: string,
  albumName: string,
  played: { track: string; artist: string }
): Promise<CatalogAlbumResult> {
  const term = albumName.replace(/[:/]/g, ' ').replace(/\s+/g, ' ').trim();
  const first = await searchAndConfirm(token, term, albumName, played);
  const artist = played.artist
    .replace(/[:/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    first.status !== 'no_match' ||
    !artist ||
    term.toLowerCase().includes(artist.toLowerCase())
  )
    return first;
  return searchAndConfirm(token, `${term} ${artist}`, albumName, played);
}

async function searchAndConfirm(
  token: string,
  term: string,
  albumName: string,
  played: { track: string; artist: string }
): Promise<CatalogAlbumResult> {
  const search = await get<{
    results?: { albums?: { data?: CatalogAlbumResource[] } };
  }>(
    `/search?${new URLSearchParams({ term, types: 'albums', limit: '10' })}`,
    token
  );
  if (!search.ok) return failure(search.status);
  const candidates = (search.body.results?.albums?.data ?? []).filter(
    (album) =>
      album.attributes?.name && albumMatches(albumName, album.attributes.name)
  );
  const holding: Array<{ album: CatalogAlbum; byPlayedArtist: boolean }> = [];
  for (const candidate of candidates.slice(0, CANDIDATES)) {
    const detail = await get<{ data?: CatalogAlbumResource[] }>(
      `/albums/${candidate.id}?include=tracks`,
      token
    );
    if (!detail.ok) return failure(detail.status);
    const album = detail.body.data?.[0];
    const attrs = album?.attributes;
    const id = Number(album?.id);
    if (
      !Number.isSafeInteger(id) ||
      !attrs?.name ||
      !attrs.artistName ||
      !attrs.url
    )
      continue;
    const tracks = [...(album?.relationships?.tracks?.data ?? [])];
    let next = album?.relationships?.tracks?.next;
    for (let page = 1; next && page < TRACK_PAGES; page++) {
      const more = await get<TrackPage>(next, token);
      if (!more.ok) return failure(more.status);
      tracks.push(...(more.body.data ?? []));
      next = more.body.next;
    }
    const songs = tracks.filter(
      (track) =>
        !!track.attributes?.name &&
        trackMatches(played.track, track.attributes.name)
    );
    if (!songs.length) continue;
    holding.push({
      album: {
        id,
        name: attrs.name,
        artistName: attrs.artistName,
        url: attrs.url,
      },
      byPlayedArtist: songs.some(
        (track) =>
          !!track.attributes?.artistName &&
          artistIdentityMatches(played.artist, track.attributes.artistName)
      ),
    });
  }
  const chosen =
    holding.find((candidate) => candidate.byPlayedArtist) ??
    (holding.length === 1 ? holding[0] : undefined);
  return chosen
    ? { status: 'found', album: chosen.album }
    : { status: 'no_match' };
}
