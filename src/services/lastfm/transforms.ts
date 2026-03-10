import type { LastfmRecentTrack } from './client.js';

export interface NormalizedScrobble {
  artistName: string;
  artistMbid: string | null;
  albumName: string;
  albumMbid: string | null;
  trackName: string;
  trackMbid: string | null;
  trackUrl: string;
  scrobbledAt: string | null;
  isNowPlaying: boolean;
}

export function normalizeScrobble(
  track: LastfmRecentTrack
): NormalizedScrobble {
  const isNowPlaying = track['@attr']?.nowplaying === 'true';
  const scrobbledAt = track.date
    ? new Date(parseInt(track.date.uts) * 1000).toISOString()
    : null;

  return {
    artistName: track.artist['#text'],
    artistMbid: track.artist.mbid || null,
    albumName: track.album['#text'],
    albumMbid: track.album.mbid || null,
    trackName: track.name,
    trackMbid: track.mbid || null,
    trackUrl: track.url,
    scrobbledAt,
    isNowPlaying,
  };
}

export function normalizeScrobbles(
  tracks: LastfmRecentTrack[]
): NormalizedScrobble[] {
  return tracks.map(normalizeScrobble);
}
