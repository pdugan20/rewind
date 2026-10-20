import type { ArtworkEnv, JobRequest } from './types.js';
import { albumMatches } from '../images/sources/utils.js';
import { artworkArtistMatches } from './identity.js';

export class ArtworkError extends Error {
  sourceAttempts?: Array<{ source: string; outcome: string; code?: string }>;
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
    }).catch(() => {
      throw new ArtworkError('source_fetch_failed', 503);
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
    artist?: { id?: string; name: string; aliases?: Array<{ name: string }> };
  }>;
}
/** Resolve title aliases only from a bound catalog entity and its artist.
 * Store labels such as a color-album disambiguator or a live suffix are not
 * guessed from strings. They must agree with MusicBrainz's logical album. */
export async function catalogIdentityProof(
  env: ArtworkEnv,
  album: CatalogAlbum,
  knownRelease?: string
) {
  const id = album.mbid || knownRelease;
  if (!id || !uuid.test(id)) return null;
  type Identity = Release & {
    date?: string;
    'first-release-date'?: string;
    disambiguation?: string;
    'secondary-types'?: string[];
    'release-group'?: {
      id: string;
      title?: string;
      disambiguation?: string;
      'secondary-types'?: string[];
      'first-release-date'?: string;
    };
  };
  let record = await providerJson<Identity>(
    env,
    `https://musicbrainz.org/ws/2/release/${id}?inc=release-groups+artist-credits&fmt=json`
  );
  if (!record)
    record = await providerJson<Identity>(
      env,
      `https://musicbrainz.org/ws/2/release-group/${id}?inc=artist-credits&fmt=json`
    );
  if (!record?.title || !(await artistIdentityMatches(env, album, record)))
    return null;
  const group = record['release-group'] ?? record;
  const title = group.title || record.title;
  const alias = album.name.match(/^(.*?)\s*\(([^()]+)\)$/);
  const sameAlias =
    alias &&
    albumMatches(alias[1], title, album.artist) &&
    group.disambiguation &&
    normalize(alias[2]) === normalize(group.disambiguation);
  if (!albumMatches(album.name, title, album.artist) && !sameAlias) return null;
  return {
    title,
    releaseGroupId: group.id,
    releaseDate: group['first-release-date'] ?? record.date ?? null,
    live: group['secondary-types']?.includes('Live') === true,
    titleAliasVerified: !!sameAlias,
  };
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
      release.title &&
      !albumMatches(album.name, release.title, album.artist)
    )
      throw new ArtworkError('catalog_identity_conflict');
    if (
      album &&
      release['artist-credit'] &&
      !(await artistIdentityMatches(env, album, release))
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
    group.title &&
    !albumMatches(album.name, group.title, album.artist)
  )
    throw new ArtworkError('catalog_identity_conflict');
  if (
    album &&
    group['artist-credit'] &&
    !(await artistIdentityMatches(env, album, group))
  )
    throw new ArtworkError('catalog_identity_unresolved');
  return group.id;
}
async function artistIdentityMatches(
  env: ArtworkEnv,
  album: CatalogAlbum,
  release: Release
) {
  const credits = release['artist-credit'] ?? [];
  if (album.artist_mbid && uuid.test(album.artist_mbid)) {
    // A known identity is authoritative even when a display name changes.
    const matched = credits.some(
      (credit) =>
        credit.artist?.id?.toLowerCase() === album.artist_mbid!.toLowerCase()
    );
    if (!matched && credits.some((credit) => credit.artist?.id))
      throw new ArtworkError('catalog_identity_conflict');
    return matched;
  }
  for (const credit of credits) {
    if (
      [credit.name, credit.artist?.name].some(
        (name) => name && artworkArtistMatches(album.artist, name)
      )
    )
      return true;
    const id = credit.artist?.id;
    if (!id || !uuid.test(id)) continue;
    // Aliases are trusted only on the exact provider entity credited here.
    const artist = await providerJson<{
      id: string;
      aliases?: Array<{ name: string }>;
    }>(env, `https://musicbrainz.org/ws/2/artist/${id}?inc=aliases&fmt=json`);
    if (
      artist?.id?.toLowerCase() === id.toLowerCase() &&
      artist.aliases?.some((alias) =>
        artworkArtistMatches(album.artist, alias.name)
      )
    )
      return true;
  }
  return false;
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
  const stamp = Date.now();
  const row = await env.DB.prepare(
    'UPDATE cd_artwork_control SET provider_next_ms=MAX(provider_next_ms,?)+? WHERE id=1 AND provider_next_ms<=? RETURNING provider_next_ms'
  )
    .bind(stamp, spacing, stamp + 15000)
    .first<{ provider_next_ms: number }>();
  if (!row) {
    const control = await env.DB.prepare(
      'SELECT provider_next_ms FROM cd_artwork_control WHERE id=1'
    ).first<{ provider_next_ms: number }>();
    if (!control) throw new ArtworkError('control_missing', 503);
    // A busy caller must not reserve an unused slot or push everyone else
    // farther into the future. This is local spacing, not a provider outage.
    throw new ArtworkError(
      'discovery_busy',
      429,
      Math.max(1, Math.ceil((control.provider_next_ms - Date.now()) / 1000))
    );
  }
  const delay = row.provider_next_ms - spacing - Date.now();
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
  }).catch(() => {
    throw new ArtworkError('discovery_provider_error', 503);
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
  try {
    return JSON.parse(
      new TextDecoder().decode(await boundedBytes(r, 2 * 1024 * 1024))
    ) as T;
  } catch {
    throw new ArtworkError('discovery_provider_error', 503);
  }
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
    !(await artistIdentityMatches(env, album, release))
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
      comment: i.comment ?? null,
      types: i.types,
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
  const matching: NonNullable<typeof result>['releases'] = [];
  for (const r of result?.releases ?? []) {
    if (
      albumMatches(album.name, r.title) &&
      r.status === 'Official' &&
      (!group || r['release-group']?.id === group)
    ) {
      // Search may include homonymous artists; reject those candidates without
      // discarding a separately matching candidate from the same response.
      try {
        if (await artistIdentityMatches(env, album, r)) matching.push(r);
      } catch (error) {
        if (
          !(error instanceof ArtworkError) ||
          error.code !== 'catalog_identity_conflict'
        )
          throw error;
      }
    }
  }
  const candidates = matching.map((r) => ({
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
