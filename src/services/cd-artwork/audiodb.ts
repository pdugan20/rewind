import type { ArtworkEnv } from './types.js';
import { sha256 } from './types.js';
import { albumMatches } from '../images/sources/utils.js';
import {
  ArtworkError,
  boundedBytes,
  providerJson,
  type CatalogAlbum,
} from './sources.js';
import { readPixels } from '../../../scripts/cd-artwork/pixels.mjs';

const HOST = 'r2.theaudiodb.com';
const KEY = (
  userId: number,
  albumId: number,
  groupId: string,
  providerAlbumId: string
) => `audiodb/reviews/${userId}/${albumId}/${groupId}/${providerAlbumId}.json`;
const BYTES_KEY = (hash: string) => `audiodb/reviewed-assets/${hash}.png`;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[a-f0-9]{64}$/;

export interface AudioDbBinding {
  groupId: string;
  providerAlbumId: string;
  sourceUrl: string;
  sourceSha256: string;
}
export interface PreparedAudioDbArtwork extends AudioDbBinding {
  bytes: Uint8Array;
  artist: string;
  album: string;
}
export interface ReviewedAudioDbArtwork extends AudioDbBinding {
  officialArtwork: true;
  reviewEvidence: string;
  bytes: Uint8Array;
}
interface ApiAlbum {
  idAlbum?: string;
  strAlbum?: string;
  strArtist?: string;
  strMusicBrainzID?: string;
  strMusicBrainzReleaseGroupID?: string;
  strAlbumCDart?: string;
}

function normalize(s: string) {
  return s.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}
function safeCdartUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ArtworkError('audiodb_cdart_url_invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== HOST ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/images\/media\/album\/cdart\/[A-Za-z0-9_-]+\.png$/.test(url.pathname)
  )
    throw new ArtworkError('audiodb_cdart_url_invalid');
  return url.href;
}

async function exactAlbum(
  env: ArtworkEnv,
  album: CatalogAlbum,
  groupId: string
) {
  if (!UUID.test(groupId)) throw new ArtworkError('audiodb_group_unverified');
  let result: { album?: ApiAlbum[] | null } | null;
  try {
    result = await providerJson<{ album?: ApiAlbum[] | null }>(
      env,
      `https://www.theaudiodb.com/api/v1/json/123/album-mb.php?i=${encodeURIComponent(groupId)}`
    );
  } catch (error) {
    if (error instanceof ArtworkError) throw error;
    throw new ArtworkError('audiodb_provider_unavailable', 503);
  }
  const rows = result?.album ?? [];
  const matching = rows.filter((row) => {
    const boundGroup = row.strMusicBrainzReleaseGroupID ?? row.strMusicBrainzID;
    return (
      row.idAlbum &&
      SAFE_ID.test(row.idAlbum) &&
      row.strAlbum &&
      row.strArtist &&
      normalize(row.strAlbum) === normalize(album.name) &&
      normalize(row.strArtist) === normalize(album.artist) &&
      boundGroup?.toLowerCase() === groupId.toLowerCase() &&
      row.strAlbumCDart
    );
  });
  if (
    rows.some(
      (row) =>
        row.strAlbum &&
        row.strArtist &&
        albumMatches(album.name, row.strAlbum, album.artist) &&
        normalize(row.strArtist) === normalize(album.artist) &&
        (
          row.strMusicBrainzReleaseGroupID ?? row.strMusicBrainzID
        )?.toLowerCase() !== groupId.toLowerCase()
    )
  )
    throw new ArtworkError('audiodb_identity_contradiction', 422);
  if (matching.length > 1)
    throw new ArtworkError('audiodb_identity_ambiguous', 422);
  const row = matching[0];
  if (!row) return null;
  return {
    providerAlbumId: row.idAlbum!,
    sourceUrl: safeCdartUrl(row.strAlbumCDart!),
    album: row.strAlbum!,
    artist: row.strArtist!,
  };
}

async function downloadCdart(url: string) {
  const safeUrl = safeCdartUrl(url);
  let response: Response;
  try {
    response = await fetch(safeUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      headers: { Accept: 'image/png' },
    });
  } catch {
    throw new ArtworkError('audiodb_image_unavailable', 503);
  }
  if (response.status >= 300 && response.status < 400)
    throw new ArtworkError('audiodb_redirect_rejected', 422);
  if (!response.ok)
    throw new ArtworkError(
      'audiodb_image_unavailable',
      response.status === 429 || response.status >= 500 ? 503 : 422
    );
  let bytes: Uint8Array;
  try {
    bytes = await boundedBytes(response, 12 * 1024 * 1024);
  } catch (error) {
    if (error instanceof ArtworkError) throw error;
    throw new ArtworkError('audiodb_image_unavailable', 503);
  }
  if (
    bytes.length < 24 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => bytes[index] === byte
    )
  )
    throw new ArtworkError('audiodb_image_format_invalid');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (width < 660 || height < 660 || width * height > 12_000_000)
    throw new ArtworkError('audiodb_image_dimensions_invalid');
  let decoded;
  try {
    decoded = readPixels(bytes);
  } catch {
    throw new ArtworkError('audiodb_image_format_invalid');
  }
  if (
    decoded.width !== width ||
    decoded.height !== height ||
    decoded.width < 660 ||
    decoded.height < 660 ||
    decoded.width * decoded.height > 12_000_000
  )
    throw new ArtworkError('audiodb_image_dimensions_invalid');
  return bytes;
}

/** Fetch exact album metadata and its PNG for an explicit owner review flow. */
export async function prepareAudioDbArtwork(
  env: ArtworkEnv,
  album: CatalogAlbum,
  groupId: string
): Promise<PreparedAudioDbArtwork | null> {
  const match = await exactAlbum(env, album, groupId);
  if (!match) return null;
  const bytes = await downloadCdart(match.sourceUrl);
  return {
    groupId,
    providerAlbumId: match.providerAlbumId,
    sourceUrl: match.sourceUrl,
    sourceSha256: await sha256(bytes),
    bytes,
    album: match.album,
    artist: match.artist,
  };
}

/** Store only an explicit official-artwork decision and exact reviewed source bytes. */
export async function reviewAudioDbArtwork(
  env: ArtworkEnv,
  userId: number,
  albumId: number,
  album: CatalogAlbum,
  prepared: PreparedAudioDbArtwork,
  officialArtwork: true,
  reviewEvidence: string,
  expectedPreviousSha256: string | null = null
): Promise<AudioDbBinding> {
  if (
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !Number.isSafeInteger(albumId) ||
    albumId <= 0 ||
    officialArtwork !== true ||
    reviewEvidence.trim().length < 12 ||
    reviewEvidence.length > 2000 ||
    !UUID.test(prepared.groupId) ||
    !SAFE_ID.test(prepared.providerAlbumId) ||
    !HASH.test(prepared.sourceSha256) ||
    (await sha256(prepared.bytes)) !== prepared.sourceSha256
  )
    throw new ArtworkError('audiodb_review_invalid', 400);
  const checked = await exactAlbum(env, album, prepared.groupId);
  if (
    !checked ||
    normalize(checked.album) !== normalize(prepared.album) ||
    normalize(checked.artist) !== normalize(prepared.artist) ||
    checked.providerAlbumId !== prepared.providerAlbumId ||
    checked.sourceUrl !== safeCdartUrl(prepared.sourceUrl)
  )
    throw new ArtworkError('audiodb_review_binding_changed', 409);
  const refreshed = await downloadCdart(checked.sourceUrl);
  if (
    (await sha256(refreshed)) !== prepared.sourceSha256 ||
    (await sha256(prepared.bytes)) !== prepared.sourceSha256
  )
    throw new ArtworkError('audiodb_review_source_changed', 409);
  const binding: AudioDbBinding = {
    groupId: prepared.groupId,
    providerAlbumId: prepared.providerAlbumId,
    sourceUrl: prepared.sourceUrl,
    sourceSha256: prepared.sourceSha256,
  };
  const assetKey = BYTES_KEY(prepared.sourceSha256);
  await env.ARTWORK.put(assetKey, prepared.bytes, {
    httpMetadata: {
      contentType: 'image/png',
      cacheControl: 'private, no-store',
    },
    onlyIf: { etagDoesNotMatch: '*' },
  });
  const decision = {
    version: 1,
    user_id: userId,
    album_id: albumId,
    ...binding,
    officialArtwork: true,
    reviewEvidence: reviewEvidence.trim(),
    assetKey,
  };
  const key = KEY(userId, albumId, prepared.groupId, prepared.providerAlbumId);
  const previous = await env.ARTWORK.get(key);
  let condition: { etagMatches: string } | { etagDoesNotMatch: '*' };
  if (previous) {
    let current: { sourceSha256?: string };
    try {
      current = await previous.json<{ sourceSha256?: string }>();
    } catch {
      throw new ArtworkError('audiodb_review_conflict', 409);
    }
    if (current.sourceSha256 === binding.sourceSha256) return binding;
    if (
      !expectedPreviousSha256 ||
      current.sourceSha256 !== expectedPreviousSha256 ||
      !previous.etag
    )
      throw new ArtworkError('audiodb_review_conflict', 409);
    condition = { etagMatches: previous.etag };
  } else {
    if (expectedPreviousSha256 !== null)
      throw new ArtworkError('audiodb_review_conflict', 409);
    condition = { etagDoesNotMatch: '*' };
  }
  const stored = await env.ARTWORK.put(key, JSON.stringify(decision), {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'private, no-store',
    },
    onlyIf: condition,
  });
  if (!stored) throw new ArtworkError('audiodb_review_conflict', 409);
  return binding;
}

/** Return exact bytes only when the current provider row still matches an explicit review. */
export async function readReviewedAudioDbArtwork(
  env: ArtworkEnv,
  userId: number,
  albumId: number,
  binding: AudioDbBinding
): Promise<ReviewedAudioDbArtwork | null> {
  if (
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !Number.isSafeInteger(albumId) ||
    albumId <= 0 ||
    !UUID.test(binding.groupId) ||
    !SAFE_ID.test(binding.providerAlbumId) ||
    !HASH.test(binding.sourceSha256)
  )
    return null;
  let url: string;
  try {
    url = safeCdartUrl(binding.sourceUrl);
  } catch {
    return null;
  }
  const object = await env.ARTWORK.get(
    KEY(userId, albumId, binding.groupId, binding.providerAlbumId)
  );
  if (!object || object.size > 4096) return null;
  try {
    const saved = await object.json<Record<string, unknown>>();
    if (
      saved.version !== 1 ||
      saved.user_id !== userId ||
      saved.album_id !== albumId ||
      saved.groupId !== binding.groupId ||
      saved.providerAlbumId !== binding.providerAlbumId ||
      saved.sourceUrl !== url ||
      saved.sourceSha256 !== binding.sourceSha256 ||
      saved.officialArtwork !== true ||
      typeof saved.reviewEvidence !== 'string' ||
      saved.reviewEvidence.length < 12 ||
      saved.assetKey !== BYTES_KEY(binding.sourceSha256)
    )
      return null;
    const asset = await env.ARTWORK.get(BYTES_KEY(binding.sourceSha256));
    if (
      !asset ||
      asset.size <= 0 ||
      asset.size > 12 * 1024 * 1024 ||
      asset.httpMetadata?.contentType !== 'image/png'
    )
      return null;
    const bytes = new Uint8Array(await asset.arrayBuffer());
    if ((await sha256(bytes)) !== binding.sourceSha256) return null;
    return {
      ...binding,
      officialArtwork: true,
      reviewEvidence: saved.reviewEvidence,
      bytes,
    };
  } catch {
    return null;
  }
}

/** Read the current approved hash so an explicit owner re-review can use CAS. */
export async function readAudioDbReviewHash(
  env: ArtworkEnv,
  userId: number,
  albumId: number,
  groupId: string,
  providerAlbumId: string
): Promise<string | null> {
  if (
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !Number.isSafeInteger(albumId) ||
    albumId <= 0 ||
    !UUID.test(groupId) ||
    !SAFE_ID.test(providerAlbumId)
  )
    return null;
  const object = await env.ARTWORK.get(
    KEY(userId, albumId, groupId, providerAlbumId)
  );
  if (!object || object.size > 4096) return null;
  try {
    const saved = await object.json<Record<string, unknown>>();
    return saved.version === 1 &&
      saved.user_id === userId &&
      saved.album_id === albumId &&
      saved.groupId === groupId &&
      saved.providerAlbumId === providerAlbumId &&
      saved.officialArtwork === true &&
      typeof saved.reviewEvidence === 'string' &&
      saved.reviewEvidence.length >= 12 &&
      typeof saved.sourceUrl === 'string' &&
      HASH.test(String(saved.sourceSha256)) &&
      saved.assetKey === BYTES_KEY(String(saved.sourceSha256))
      ? String(saved.sourceSha256)
      : null;
  } catch {
    return null;
  }
}

export async function findReviewedAudioDbArtwork(
  env: ArtworkEnv,
  userId: number,
  albumId: number,
  album: CatalogAlbum,
  groupId: string
): Promise<ReviewedAudioDbArtwork | null> {
  const match = await exactAlbum(env, album, groupId);
  if (!match) return null;
  const key = KEY(userId, albumId, groupId, match.providerAlbumId);
  const decision = await env.ARTWORK.get(key);
  if (!decision || decision.size > 4096) return null;
  let savedHash: string;
  try {
    savedHash = (await decision.json<{ sourceSha256: string }>()).sourceSha256;
  } catch {
    return null;
  }
  if (!HASH.test(savedHash)) return null;
  const binding = {
    groupId,
    providerAlbumId: match.providerAlbumId,
    sourceUrl: match.sourceUrl,
    sourceSha256: savedHash,
  };
  const reviewed = await readReviewedAudioDbArtwork(
    env,
    userId,
    albumId,
    binding
  );
  if (!reviewed) return null;
  const current = await downloadCdart(match.sourceUrl);
  if ((await sha256(current)) !== savedHash) return null;
  return { ...reviewed, bytes: current };
}
