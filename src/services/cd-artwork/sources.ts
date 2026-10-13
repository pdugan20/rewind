import type { ArtworkEnv, JobRequest } from './types.js';
import { albumMatches } from '../images/sources/utils.js';

export class ArtworkError extends Error {
  constructor(
    public code: string,
    public status = 422,
    public retryAfter = 3600
  ) {
    super(code);
  }
}
const normalize = (s: string) => s.normalize('NFKC').trim().toLowerCase();
const publicHost = (host: string) =>
  host === 'coverartarchive.org' ||
  host === 'archive.org' ||
  /(^|\.)archive\.org$/.test(host) ||
  host === 'cdn.rewind.rest' ||
  /(^|\.)mzstatic\.com$/.test(host);
export async function boundedBytes(
  response: Response,
  max = 15 * 1024 * 1024
): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > max)
    throw new ArtworkError('source_too_large');
  if (!response.body) throw new ArtworkError('empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) {
        await reader.cancel();
        throw new ArtworkError('source_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function downloadImage(
  url: string
): Promise<{ bytes: Uint8Array; mime: string }> {
  for (let redirect = 0; redirect < 4; redirect++) {
    const u = new URL(url);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      !publicHost(u.hostname)
    )
      throw new ArtworkError('source_host_not_allowed');
    const r = await fetch(u, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const location = r.headers.get('location');
      if (!location) throw new ArtworkError('source_redirect_invalid');
      url = new URL(location, u).href;
      continue;
    }
    if (!r.ok)
      throw new ArtworkError(
        'source_fetch_failed',
        r.status === 429 || r.status >= 500 ? 503 : 422
      );
    const bytes = await boundedBytes(r);
    const mime =
      bytes[0] === 255 && bytes[1] === 216
        ? 'image/jpeg'
        : bytes[0] === 137 && bytes[1] === 80
          ? 'image/png'
          : null;
    if (!mime) throw new ArtworkError('source_format_unsupported');
    return { bytes, mime };
  }
  throw new ArtworkError('source_redirect_limit');
}
interface Release {
  id?: string;
  title: string;
  'release-group'?: { id: string };
  media: Array<{ format: string; position: number }>;
  'artist-credit': Array<{
    name: string;
    artist?: { id?: string; name: string };
  }>;
}
export interface CatalogAlbum {
  name: string;
  artist: string;
  mbid?: string | null;
  artist_mbid?: string | null;
  apple_music_id?: number | null;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
async function catalogGroup(
  env: ArtworkEnv,
  mbid?: string | null,
  album?: CatalogAlbum
) {
  if (!mbid || !uuid.test(mbid)) return null;
  const release = await providerJson<Release>(
    env,
    `https://musicbrainz.org/ws/2/release/${mbid}?inc=release-groups+artist-credits&fmt=json`
  );
  if (release) {
    if (
      album &&
      ((release.title &&
        !albumMatches(album.name, release.title, album.artist)) ||
        (release['artist-credit'] && !artistIdentityMatches(album, release)))
    )
      throw new ArtworkError('catalog_identity_unresolved');
    if (!release['release-group']?.id)
      throw new ArtworkError('catalog_identity_unresolved');
    return release['release-group'].id;
  }
  const group = await providerJson<Release>(
    env,
    `https://musicbrainz.org/ws/2/release-group/${mbid}?inc=artist-credits&fmt=json`
  );
  if (!group?.id) throw new ArtworkError('catalog_identity_unresolved');
  if (
    album &&
    ((group.title && !albumMatches(album.name, group.title, album.artist)) ||
      (group['artist-credit'] && !artistIdentityMatches(album, group)))
  )
    throw new ArtworkError('catalog_identity_unresolved');
  return group.id;
}
function artistIdentityMatches(album: CatalogAlbum, release: Release) {
  return release['artist-credit']?.some(
    (credit) =>
      normalize(credit.artist?.name ?? credit.name) ===
        normalize(album.artist) &&
      (!album.artist_mbid ||
        !uuid.test(album.artist_mbid) ||
        credit.artist?.id?.toLowerCase() === album.artist_mbid.toLowerCase())
  );
}
interface ArchiveImage {
  id: string | number;
  types: string[];
  image: string;
  approved?: boolean;
  comment?: string;
}
interface Archive {
  images: ArchiveImage[];
}
export async function providerJson<T>(
  env: ArtworkEnv,
  url: string
): Promise<T | null> {
  // Atomic shared spacing across isolates/workflows/manual requests. No parallel
  // provider loop can bypass this reservation by using a separate process.
  const hostname = new URL(url).hostname;
  const spacing =
    hostname === 'itunes.apple.com'
      ? 3100
      : hostname === 'www.theaudiodb.com'
        ? 2100
        : 1100;
  const row = await env.DB.prepare(
    'UPDATE cd_artwork_control SET provider_next_ms=MAX(provider_next_ms,?)+? WHERE id=1 RETURNING provider_next_ms'
  )
    .bind(Date.now(), spacing)
    .first<{ provider_next_ms: number }>();
  if (!row) throw new ArtworkError('control_missing', 503);
  const delay = row.provider_next_ms - spacing - Date.now();
  if (delay > 15000) throw new ArtworkError('discovery_busy', 429);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  const r = await fetch(url, {
    // Cloudflare can forward headers across redirects; never redirect a credential.
    redirect:
      new URL(url).hostname === 'api.music.apple.com' ? 'manual' : 'follow',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Rewind-CD-Artwork/1.0 (https://rewind.rest)',
      ...(new URL(url).hostname === 'api.music.apple.com' &&
      env.APPLE_MUSIC_DEVELOPER_TOKEN
        ? { Authorization: `Bearer ${env.APPLE_MUSIC_DEVELOPER_TOKEN}` }
        : {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    const retry = r.headers.get('retry-after');
    const seconds = retry
      ? Number.isFinite(Number(retry))
        ? Number(retry)
        : (Date.parse(retry) - Date.now()) / 1000
      : 3600;
    throw new ArtworkError(
      'discovery_provider_error',
      503,
      Math.max(3600, seconds || 0)
    );
  }
  return JSON.parse(
    new TextDecoder().decode(await boundedBytes(r, 2 * 1024 * 1024))
  ) as T;
}
export async function resolveSource(
  env: ArtworkEnv,
  input: JobRequest,
  album: CatalogAlbum,
  discoveryOnly = false
) {
  if (!input.release_id) throw new ArtworkError('edition_identity_mismatch');
  const release = await providerJson<Release>(
    env,
    `https://musicbrainz.org/ws/2/release/${input.release_id}?inc=artist-credits+release-groups+media&fmt=json`
  );
  if (
    !release ||
    !albumMatches(album.name, release.title) ||
    !artistIdentityMatches(album, release)
  )
    throw new ArtworkError('edition_identity_mismatch');
  if (
    album.mbid &&
    uuid.test(album.mbid) &&
    album.mbid.toLowerCase() !== input.release_id.toLowerCase()
  ) {
    const group = await catalogGroup(env, album.mbid, album);
    if (group !== release['release-group']?.id)
      throw new ArtworkError('edition_identity_mismatch');
  }
  const cds =
    release.media?.filter((m) => ['CD', 'HDCD'].includes(m.format)) ?? [];
  const archive = await providerJson<Archive>(
    env,
    `https://coverartarchive.org/release/${input.release_id}`
  );
  const media =
    archive?.images?.filter((i) => i.types?.includes('Medium')) ?? [];
  const ambiguous =
    release.media?.length !== 1 ||
    cds.length !== 1 ||
    cds[0]?.position !== input.medium_position;
  const discovery = {
    outcome: media.length ? (ambiguous ? 'ambiguous' : 'found') : 'not_found',
    release_id: input.release_id,
    release_group_id: release['release-group']?.id ?? null,
    medium_verified: !ambiguous,
    covers:
      archive?.images
        ?.filter((i) => i.approved && i.types?.includes('Front'))
        .map((i) => ({
          id: String(i.id),
          url: i.image.replace(/^http:/, 'https:'),
        })) ?? [],
    images: media.map((i) => ({
      id: String(i.id),
      url: i.image.replace(/^http:/, 'https:'),
      approved: !!i.approved,
    })),
    scope: 'representative release; not proof of owned pressing',
  };
  if (discoveryOnly)
    return {
      sourceUrl: '',
      sourceKind: 'cover' as const,
      discovery,
      selectedImageId: null,
      identityType: 'representative_release',
    };
  const sourceKind =
    input.source_kind === 'auto'
      ? media.length
        ? 'retail'
        : 'cover'
      : input.source_kind;
  let selected: ArchiveImage | undefined;
  if (sourceKind === 'retail') {
    if (ambiguous) throw new ArtworkError('edition_medium_ambiguous');
    selected = input.image_id
      ? media.find((i) => String(i.id) === input.image_id)
      : media.length === 1
        ? media[0]
        : undefined;
    if (!selected)
      throw new ArtworkError(
        media.length ? 'source_ambiguous' : 'retail_not_found'
      );
  } else selected = archive?.images?.find((i) => i.types?.includes('Front'));
  const sourceUrl =
    sourceKind === 'cover' && input.cover_url
      ? input.cover_url
      : selected?.image.replace(/^http:/, 'https:');
  if (!sourceUrl) throw new ArtworkError('cover_not_found');
  return {
    sourceUrl,
    sourceKind,
    discovery,
    selectedImageId: selected ? String(selected.id) : null,
    identityType: 'representative_release',
  };
}

/** Exact title/artist candidates; ambiguous editions require a recorded choice. */
export async function resolveEditionCandidates(
  env: ArtworkEnv,
  album: CatalogAlbum,
  cdOnly = false,
  knownRelease?: string
) {
  const escape = (s: string) => s.replace(/["\\]/g, ' ');
  const group = await catalogGroup(
    env,
    album.mbid && uuid.test(album.mbid) ? album.mbid : knownRelease,
    album
  );
  const artist =
    album.artist_mbid && uuid.test(album.artist_mbid)
      ? `arid:${album.artist_mbid}`
      : `artist:"${escape(album.artist)}"`;
  const query = `release:"${escape(album.name)}" AND ${artist}${group ? ` AND rgid:${group}` : ''}${cdOnly ? ' AND format:(CD OR HDCD)' : ''}`;
  const result = await providerJson<{
    count?: number;
    releases: Array<
      Release & {
        id: string;
        status: string;
        country?: string;
        date?: string;
        score?: number;
      }
    >;
  }>(
    env,
    `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(query)}&fmt=json&limit=10`
  );
  const candidates = (result?.releases ?? [])
    .filter(
      (r) =>
        albumMatches(album.name, r.title) &&
        r.status === 'Official' &&
        artistIdentityMatches(album, r) &&
        (!group || r['release-group']?.id === group)
    )
    .map((r) => ({
      release_id: r.id,
      release_group_id: r['release-group']?.id ?? null,
      title: r.title,
      country: r.country ?? null,
      date: r.date ?? null,
      identity_type: 'representative_release',
      requires_medium_verification: true,
    }));
  return {
    group_verified: !!group,
    results_truncated:
      result?.count === undefined ||
      result.count > (result.releases?.length ?? 0),
    outcome: candidates.length
      ? 'edition_choice_required'
      : 'identity_required',
    candidates,
  };
}
