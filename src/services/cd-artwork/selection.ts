import { readPixels } from '../../../scripts/cd-artwork/pixels.mjs';
import type { ArtworkEnv, JobRequest } from './types.js';
import {
  ArtworkError,
  providerJson,
  downloadImage,
  resolveEditionCandidates,
  resolveSource,
  type CatalogAlbum,
} from './sources.js';
import {
  albumMatches,
  artistIdentityMatches,
  trackMatches,
} from '../images/sources/utils.js';

export interface SelectedSource {
  request: JobRequest;
  sourceUrl: string;
  preparedBytes?: Uint8Array;
  preparedMime?: string;
  retailRetryAfter?: number;
  sourceKind: 'retail' | 'cover';
  identityType: 'representative_release' | 'reviewed_source';
  selectedImageId: string | null;
  discovery: { outcome: string; [key: string]: unknown };
}
interface Collection {
  collectionId?: number | string;
  collectionName?: string;
  artistName?: string;
  artworkUrl100?: string;
  wrapperType?: string;
  trackName?: string;
}
interface AppleResource {
  id: string;
  attributes?: {
    name?: string;
    artistName?: string;
    artwork?: { url: string };
  };
  relationships?: { tracks?: { data?: AppleResource[] } };
}
const appleCollection = (album: AppleResource): Collection => ({
  wrapperType: 'collection',
  collectionId: album.id,
  collectionName: album.attributes?.name,
  artistName: album.attributes?.artistName,
  artworkUrl100: album.attributes?.artwork?.url
    .replace('{w}', '1200')
    .replace('{h}', '1200')
    .replace('{f}', 'jpg'),
});
async function searchCoverCatalog(env: ArtworkEnv, album: CatalogAlbum) {
  const authenticated = !!env.APPLE_MUSIC_DEVELOPER_TOKEN;
  const url = new URL(
    authenticated
      ? 'https://api.music.apple.com/v1/catalog/us/search'
      : 'https://itunes.apple.com/search'
  );
  url.searchParams.set('term', `${album.artist} ${album.name}`);
  url.searchParams.set(
    authenticated ? 'types' : 'entity',
    'album' + (authenticated ? 's' : '')
  );
  url.searchParams.set('limit', '10');
  if (authenticated) {
    const result = await providerJson<{
      results?: { albums?: { data?: AppleResource[] } };
    }>(env, url.href);
    return (result?.results?.albums?.data ?? []).map(appleCollection);
  }
  return (
    (await providerJson<{ results: Collection[] }>(env, url.href))?.results ??
    []
  );
}
async function lookupCoverCatalog(
  env: ArtworkEnv,
  id: string
): Promise<Collection[]> {
  if (!env.APPLE_MUSIC_DEVELOPER_TOKEN)
    return (
      (
        await providerJson<{ results: Collection[] }>(
          env,
          `https://itunes.apple.com/lookup?id=${id}&entity=song&limit=200`
        )
      )?.results ?? []
    );
  const result = await providerJson<{ data?: AppleResource[] }>(
    env,
    `https://api.music.apple.com/v1/catalog/us/albums/${id}?include=tracks`
  );
  const album = result?.data?.find((a) => a.id === id);
  if (!album) return [];
  return [
    appleCollection(album),
    ...(album.relationships?.tracks?.data ?? []).map((song): Collection => ({
      wrapperType: 'track',
      collectionId: id,
      artistName: song.attributes?.artistName,
      trackName: song.attributes?.name,
    })),
  ];
}
/** Two independent checks: exact album/artist metadata and an observed track.
 * Cover-only albums never need a physical-release identifier. Provider errors
 * remain errors; they are not evidence that a CD or cover does not exist.
 */
export async function verifiedCover(
  env: ArtworkEnv,
  albumId: number,
  userId: number,
  album: CatalogAlbum,
  allowLegacy = false
): Promise<SelectedSource> {
  const tracks = await env.DB.prepare(
    'SELECT t.name FROM lastfm_scrobbles s INDEXED BY idx_lastfm_scrobbles_user_album_date JOIN lastfm_tracks t NOT INDEXED ON t.id=s.track_id AND t.user_id=s.user_id WHERE s.user_id=? AND s.album_recorded=1 AND s.album_id=? AND t.is_filtered=0 ORDER BY s.scrobbled_at DESC LIMIT 8'
  )
    .bind(userId, albumId)
    .all<{ name: string }>();
  let legacyEvidence = false;
  if (!tracks.results.length && allowLegacy) {
    const legacy = await env.DB.prepare(
      'SELECT t.name FROM lastfm_tracks t INDEXED BY idx_lastfm_tracks_user_album JOIN lastfm_scrobbles s INDEXED BY idx_lastfm_scrobbles_user_track_date ON s.track_id=t.id AND s.user_id=t.user_id WHERE t.user_id=? AND t.album_id=? AND t.is_filtered=0 AND s.album_recorded=0 ORDER BY s.scrobbled_at DESC LIMIT 8'
    )
      .bind(userId, albumId)
      .all<{ name: string }>();
    tracks.results.push(...legacy.results);
    legacyEvidence = legacy.results.length > 0;
  }
  if (!tracks.results.length)
    throw new ArtworkError('cover_identity_unverified');
  let id = album.apple_music_id == null ? null : String(album.apple_music_id);
  if (!id || !/^\d+$/.test(id)) {
    const candidates = (await searchCoverCatalog(env, album)).filter(
      (c) =>
        c.collectionId &&
        c.collectionName &&
        c.artistName &&
        artistIdentityMatches(album.artist, c.artistName) &&
        albumMatches(album.name, c.collectionName, album.artist)
    );
    const ids = [...new Set(candidates.map((c) => String(c.collectionId)))];
    if (ids.length !== 1)
      throw new ArtworkError(
        ids.length ? 'cover_identity_ambiguous' : 'cover_not_found'
      );
    id = ids[0];
  }
  if (!/^\d+$/.test(id)) throw new ArtworkError('cover_identity_unverified');
  const lookup = await lookupCoverCatalog(env, id);
  const collection = lookup.find(
    (c) => c.wrapperType === 'collection' && String(c.collectionId) === id
  );
  if (
    !collection?.artistName ||
    !collection.collectionName ||
    !artistIdentityMatches(album.artist, collection.artistName) ||
    !albumMatches(album.name, collection.collectionName, album.artist)
  )
    throw new ArtworkError('cover_identity_unverified');
  const songs =
    lookup.filter(
      (c) =>
        c.wrapperType === 'track' &&
        String(c.collectionId) === id &&
        c.artistName &&
        artistIdentityMatches(album.artist, c.artistName)
    ) ?? [];
  if (
    !tracks.results.some((t) =>
      songs.some((s) => s.trackName && trackMatches(t.name, s.trackName))
    )
  )
    throw new ArtworkError('cover_track_mismatch');
  const artwork = collection.artworkUrl100;
  if (!artwork) throw new ArtworkError('cover_not_found');
  const sourceUrl = artwork.replace(/\d+x\d+bb(?=\.)/, '1200x1200bb');
  const u = new URL(sourceUrl);
  if (
    u.protocol !== 'https:' ||
    !/(^|\.)mzstatic\.com$/.test(u.hostname) ||
    u.username ||
    u.password ||
    u.port
  )
    throw new ArtworkError('source_host_not_allowed');
  return {
    request: {
      album_id: albumId,
      release_id: null,
      medium_position: null,
      source_kind: 'cover',
      cover_url: sourceUrl,
    },
    sourceUrl,
    sourceKind: 'cover',
    identityType: 'reviewed_source',
    selectedImageId: null,
    discovery: {
      outcome: 'cover_found',
      collection_id: id,
      catalog_provider: env.APPLE_MUSIC_DEVELOPER_TOKEN
        ? 'apple_music'
        : 'itunes',
      album_artist_verified: true,
      observed_track_verified: true,
      play_evidence: legacyEvidence
        ? 'legacy_track_association'
        : 'recorded_album',
    },
  };
}
export async function selectAutomaticSource(
  env: ArtworkEnv,
  albumId: number,
  userId: number,
  album: CatalogAlbum,
  releaseId: string,
  mediumPosition: number,
  allowLegacy = false
): Promise<SelectedSource> {
  // A stored Apple binding is independent identity evidence, not permission
  // to ignore contradictory metadata when a retail scan happens to exist.
  const verified = album.apple_music_id
    ? await verifiedCover(env, albumId, userId, album, allowLegacy)
    : null;
  let cover: SelectedSource | null = null;
  try {
    let releases = releaseId ? [releaseId] : [];
    if (!releases.length) {
      const candidates = await resolveEditionCandidates(env, album);
      // Multiple pressings of one proven logical album can supply representative
      // art. Different/unknown release groups remain ambiguous. Inspect at most
      // three stable IDs; never claim that a representative scan is owned.
      const groups = new Set(
        candidates.candidates.map((c) => c.release_group_id)
      );
      if (
        groups.size === 1 &&
        !groups.has(null) &&
        (candidates.group_verified || !candidates.results_truncated)
      )
        releases = candidates.candidates
          .map((c) => c.release_id)
          .sort()
          .slice(0, 3);
    }
    for (const release of releases) {
      const request: JobRequest = {
        album_id: albumId,
        release_id: release,
        medium_position: mediumPosition,
        source_kind: 'retail',
      };
      const found = await resolveSource(env, request, album, true);
      const images = found.discovery.images.filter((i) => i.approved);
      if (found.discovery.outcome === 'found' && images.length === 1) {
        request.image_id = images[0].id;
        const downloaded = await usableSource(images[0].url);
        if (downloaded)
          return {
            preparedBytes: downloaded.bytes,
            preparedMime: downloaded.mime,
            ...found,
            sourceUrl: images[0].url,
            sourceKind: 'retail',
            identityType: 'representative_release',
            selectedImageId: images[0].id,
            request,
          };
      }
      if (found.discovery.covers.length === 1) {
        // Keep one verified cover while checking the remaining bounded retail candidates.
        const front = found.discovery.covers[0];
        const downloaded = await usableSource(front.url);
        if (downloaded)
          cover ??= {
            preparedBytes: downloaded.bytes,
            preparedMime: downloaded.mime,
            request: { ...request, source_kind: 'cover', cover_url: front.url },
            sourceUrl: front.url,
            sourceKind: 'cover',
            identityType: 'representative_release',
            selectedImageId: front.id,
            discovery: { ...found.discovery, outcome: 'cover_found' },
          };
      }
    }
    return (
      cover ??
      verified ??
      (await verifiedCover(env, albumId, userId, album, allowLegacy))
    );
  } catch (error) {
    if (!(error instanceof ArtworkError) || ![429, 503].includes(error.status))
      throw error;
    // Available cover evidence can produce a design while retail discovery is
    // pending. Retain the outage and retry; never record retail art as absent.
    const fallback =
      verified ??
      cover ??
      (await verifiedCover(env, albumId, userId, album, allowLegacy));
    return {
      ...fallback,
      retailRetryAfter: error.retryAfter,
      discovery: {
        ...fallback.discovery,
        outcome: 'retail_provider_pending',
        retail_retry_after: error.retryAfter,
      },
    };
  }
}

async function usableSource(url: string) {
  try {
    const downloaded = await downloadImage(url);
    let pixels;
    try {
      pixels = readPixels(downloaded.bytes);
    } catch {
      return null;
    }
    return Math.max(pixels.width, pixels.height) >= 660 &&
      pixels.width * pixels.height <= 12000000
      ? downloaded
      : null;
  } catch (error) {
    if (
      error instanceof ArtworkError &&
      error.status === 422 &&
      [
        'source_fetch_failed',
        'source_format_unsupported',
        'source_too_large',
      ].includes(error.code)
    )
      return null;
    throw error;
  }
}
