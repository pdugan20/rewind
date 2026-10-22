/**
 * Finds the Apple Music catalog release a Last.fm play came from.
 *
 * Searching by album name alone is fragile: a common title is crowded out by
 * other artists' releases ("Star Wars"), and Last.fm's names differ from the
 * catalog's in small ways. The played song is a much better key, because the
 * catalog search ranks a song and its artist together and tolerates small
 * title differences. So candidates come from, in order:
 *
 * 1. a song search for the played song and artist, then the same search with
 *    the album name added (it surfaces soundtracks and compilations a plain
 *    search ranks below the artist's own albums); the songs whose album title
 *    matches the played album are opened to read that album;
 * 2. every release holding the same recording, by the matched songs' ISRC,
 *    which finds an EP or single a search ranks low (the catalog caps this
 *    list at about 50, so it supplements the search rather than replacing it);
 * 3. the album-name search in catalog-album.ts, confirmed by the played song
 *    on the tracklist, for plays credited to someone else in the catalog
 *    (dialogue clips on a soundtrack).
 *
 * A release counts only when its title matches the played album
 * (match.ts). Among them the closest title wins; when the closest titles
 * name different releases, nothing is decided.
 */

import { artistIdentityMatches } from '../images/sources/utils.js';
import {
  catalogFailure,
  catalogGet,
  findCatalogAlbum,
  type CatalogAlbum,
  type CatalogAlbumResult,
} from './catalog-album.js';
import { comparableTitle } from '../images/sources/utils.js';
import {
  releaseMatchRank,
  albumSongMatches,
  recordingCreditsMatch,
} from './match.js';

/** One play: its song, the song's artist, and the album Last.fm reported. */
interface PlayedSong {
  album: string;
  track: string;
  artist: string;
}

interface AlbumResource {
  id?: string;
  type?: string;
  attributes?: { name?: string; artistName?: string; url?: string };
}
interface SongResource {
  id?: string;
  type?: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    isrc?: string;
  };
  relationships?: { albums?: { data?: AlbumResource[] } };
}

/** Song search results read per search. */
const SONG_RESULTS = 15;
/** Matched songs opened to read their albums. */
const SONGS_OPENED = 5;
/** Recordings whose releases are listed by ISRC. */
const ISRCS_LISTED = 2;

/** Whether a catalog credit names the played artist, alone or with others. */
function creditsArtist(played: string, credited: string): boolean {
  return recordingCreditsMatch(played, credited);
}

interface Candidate {
  album: CatalogAlbum;
  rank: number;
  order: number;
}

export async function resolveCatalogAlbum(
  token: string,
  played: PlayedSong
): Promise<CatalogAlbumResult> {
  const candidates = new Map<number, Candidate>();
  const consider = (album: AlbumResource | undefined) => {
    const id = Number(album?.id);
    const attrs = album?.attributes;
    if (
      album?.type !== 'albums' ||
      !Number.isSafeInteger(id) ||
      !attrs?.name ||
      !attrs.artistName ||
      !attrs.url ||
      candidates.has(id)
    )
      return;
    const rank = releaseMatchRank(played.album, attrs.name, played.artist);
    if (rank > 0)
      candidates.set(id, {
        album: {
          id,
          name: attrs.name,
          artistName: attrs.artistName,
          url: attrs.url,
        },
        rank,
        order: candidates.size,
      });
  };
  const isPlayedSong = (song: SongResource) =>
    !!song.attributes?.name &&
    !!song.attributes.artistName &&
    albumSongMatches(
      played.track,
      song.attributes.name,
      releaseMatchRank(
        played.album,
        song.attributes.albumName ?? '',
        played.artist
      ) > 0
        ? song.attributes.albumName!
        : ''
    ) &&
    creditsArtist(played.artist, song.attributes.artistName);

  const albumTerm = played.album
    .replace(/[:/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const terms = [
    `${played.track} ${played.artist}`,
    `${played.track} ${played.artist} ${albumTerm}`,
  ];
  const isrcs: string[] = [];
  for (const term of terms) {
    const search = await catalogGet<{
      results?: { songs?: { data?: SongResource[] } };
    }>(
      `/search?${new URLSearchParams({ term, types: 'songs', limit: String(SONG_RESULTS) })}`,
      token
    );
    if (!search.ok) return catalogFailure(search.status);
    const songs = (search.body.results?.songs?.data ?? []).filter(isPlayedSong);
    for (const song of songs) {
      const isrc = song.attributes?.isrc;
      if (isrc && !isrcs.includes(isrc)) isrcs.push(isrc);
    }
    const onPlayedAlbum = songs.filter(
      (song) =>
        !!song.id &&
        !!song.attributes?.albumName &&
        releaseMatchRank(
          played.album,
          song.attributes.albumName,
          played.artist
        ) > 0
    );
    if (onPlayedAlbum.length) {
      const opened = await catalogGet<{ data?: SongResource[] }>(
        `/songs?${new URLSearchParams({
          ids: onPlayedAlbum
            .slice(0, SONGS_OPENED)
            .map((song) => song.id)
            .join(','),
          include: 'albums',
        })}`,
        token
      );
      if (!opened.ok) return catalogFailure(opened.status);
      for (const song of opened.body.data ?? [])
        if (isPlayedSong(song))
          for (const album of song.relationships?.albums?.data ?? [])
            consider(album);
    }
    if (candidates.size) break;
  }

  for (const isrc of candidates.size ? [] : isrcs.slice(0, ISRCS_LISTED)) {
    const listed = await catalogGet<{ data?: SongResource[] }>(
      `/songs?${new URLSearchParams({ 'filter[isrc]': isrc, include: 'albums' })}`,
      token
    );
    if (!listed.ok) return catalogFailure(listed.status);
    for (const song of listed.body.data ?? [])
      for (const album of song.relationships?.albums?.data ?? [])
        consider(album);
  }

  if (!candidates.size)
    return findCatalogAlbum(token, played.album, {
      track: played.track,
      artist: played.artist,
    });
  return choose(played, [...candidates.values()]);
}

/**
 * The closest title wins. Several releases may share it (a reissue, an
 * explicit and a clean edition): prefer one credited to the played artist,
 * then the catalog's own ranking. Closest titles naming different releases
 * decide nothing.
 */
function choose(
  played: PlayedSong,
  candidates: Candidate[]
): CatalogAlbumResult {
  const best = Math.max(...candidates.map((c) => c.rank));
  const top = candidates.filter((c) => c.rank === best);
  const titles = new Set(top.map((c) => comparableTitle(c.album.name)));
  if (titles.size > 1) return { status: 'no_match' };
  top.sort(
    (a, b) =>
      Number(artistIdentityMatches(played.artist, b.album.artistName)) -
        Number(artistIdentityMatches(played.artist, a.album.artistName)) ||
      a.order - b.order
  );
  return {
    status: 'found',
    album: top[0].album,
    ...(!artistIdentityMatches(played.artist, top[0].album.artistName)
      ? { trackArtistVerified: true }
      : {}),
  };
}
