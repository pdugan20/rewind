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
 * example "Various Artists") describes the release that was played.
 */

import { albumMatches, trackMatches } from '../images/sources/utils.js';

const API = 'https://api.music.apple.com/v1/catalog/us';
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

interface CatalogAlbumResource {
  id?: string;
  type?: string;
  attributes?: { name?: string; artistName?: string; url?: string };
  relationships?: {
    tracks?: { data?: Array<{ attributes?: { name?: string } }> };
  };
}

async function get<T>(
  path: string,
  token: string
): Promise<{ ok: true; body: T } | { ok: false; status: number }> {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
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
  trackName: string
): Promise<CatalogAlbumResult> {
  const term = albumName.replace(/[:/]/g, ' ').replace(/\s+/g, ' ').trim();
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
      !attrs.url ||
      !(album?.relationships?.tracks?.data ?? []).some(
        (track) =>
          !!track.attributes?.name &&
          trackMatches(trackName, track.attributes.name)
      )
    )
      continue;
    return {
      status: 'found',
      album: {
        id,
        name: attrs.name,
        artistName: attrs.artistName,
        url: attrs.url,
      },
    };
  }
  return { status: 'no_match' };
}
