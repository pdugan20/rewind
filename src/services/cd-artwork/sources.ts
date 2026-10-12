import type { ArtworkEnv, JobRequest } from './types.js';

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
    if (!r.ok) throw new ArtworkError('source_fetch_failed', 422);
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
  title: string;
  media: Array<{ format: string; position: number }>;
  'artist-credit': Array<{ name: string; artist?: { name: string } }>;
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
async function providerJson<T>(
  env: ArtworkEnv,
  url: string
): Promise<T | null> {
  // Atomic shared spacing across isolates/workflows/manual requests. No parallel
  // provider loop can bypass this reservation by using a separate process.
  const row = await env.DB.prepare(
    'UPDATE cd_artwork_control SET provider_next_ms=MAX(provider_next_ms,?)+1100 WHERE id=1 RETURNING provider_next_ms'
  )
    .bind(Date.now())
    .first<{ provider_next_ms: number }>();
  if (!row) throw new ArtworkError('control_missing', 503);
  const delay = row.provider_next_ms - 1100 - Date.now();
  if (delay > 15000) throw new ArtworkError('discovery_busy', 429);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  const r = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Rewind-CD-Artwork/1.0 (https://rewind.rest)',
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
  album: { name: string; artist: string },
  discoveryOnly = false
) {
  const release = await providerJson<Release>(
    env,
    `https://musicbrainz.org/ws/2/release/${input.release_id}?inc=artist-credits+media&fmt=json`
  );
  if (
    !release ||
    normalize(release.title) !== normalize(album.name) ||
    !release['artist-credit']?.some(
      (a) => normalize(a.artist?.name ?? a.name) === normalize(album.artist)
    )
  )
    throw new ArtworkError('edition_identity_mismatch');
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
  album: { name: string; artist: string }
) {
  const escape = (s: string) => s.replace(/["\\]/g, ' ');
  const query = `release:"${escape(album.name)}" AND artist:"${escape(album.artist)}"`;
  const result = await providerJson<{
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
        normalize(r.title) === normalize(album.name) &&
        r.status === 'Official' &&
        r['artist-credit']?.some(
          (a) => normalize(a.artist?.name ?? a.name) === normalize(album.artist)
        )
    )
    .map((r) => ({
      release_id: r.id,
      title: r.title,
      country: r.country ?? null,
      date: r.date ?? null,
      identity_type: 'representative_release',
      requires_medium_verification: true,
    }));
  return {
    outcome: candidates.length
      ? 'edition_choice_required'
      : 'identity_required',
    candidates,
  };
}
