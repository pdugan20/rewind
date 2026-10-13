import type { ArtworkEnv } from './types.js';
import { sha256 } from './types.js';
import { ArtworkError } from './sources.js';
import { validateCandidate } from './registration.js';
import { createLosslessWebp } from './webp-variant.js';

const MAX_BYTES = 8 * 1024 * 1024;
const BASE = 'https://api.rewind.rest/v1/listening/cd-artwork/fallback/assets/';
const USER_KEY = (userId: number) => `fallback/users/${userId}/descriptor.json`;
const ACCEPTED_KEY = (hash: string) => `fallback/accepted/${hash}.json`;
const PUBLIC_KEY = (hash: string, ext: 'png' | 'webp') =>
  `listening/cd-artwork-fallback/assets/${hash}.${ext}`;
const HASH = /^[a-f0-9]{64}$/;

export type FallbackVariant = {
  image_url: string;
  sha256: string;
  format: 'webp';
  width: 1024;
  height: 1024;
  bytes: number;
};
export type FallbackArtwork = {
  kind: 'generic';
  template: 'sony-cdr';
  image_url: string;
  sha256: string;
  alpha: 'material';
  geometry: {
    canvas: 1024;
    center: 512;
    outer_radius: 480;
    hole_radius: 60;
  };
  variants?: FallbackVariant[];
};
type StoredDescriptor = {
  version: 1;
  user_id: number;
  artwork: FallbackArtwork;
};

function validDescriptor(
  value: unknown,
  userId?: number
): value is StoredDescriptor {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<StoredDescriptor>;
  const a = v.artwork;
  if (
    v.version !== 1 ||
    !Number.isSafeInteger(v.user_id) ||
    (userId !== undefined && v.user_id !== userId) ||
    !a
  )
    return false;
  if (
    a.kind !== 'generic' ||
    a.template !== 'sony-cdr' ||
    a.alpha !== 'material' ||
    !HASH.test(a.sha256) ||
    a.image_url !== `${BASE}${a.sha256}.png`
  )
    return false;
  const g = a.geometry;
  if (
    !g ||
    g.canvas !== 1024 ||
    g.center !== 512 ||
    g.outer_radius !== 480 ||
    g.hole_radius !== 60
  )
    return false;
  if (
    a.variants !== undefined &&
    (!Array.isArray(a.variants) ||
      a.variants.length > 1 ||
      !a.variants.every(
        (x) =>
          x.format === 'webp' &&
          HASH.test(x.sha256) &&
          x.image_url === `${BASE}${x.sha256}.webp` &&
          x.width === 1024 &&
          x.height === 1024 &&
          Number.isInteger(x.bytes) &&
          x.bytes > 0 &&
          x.bytes <= MAX_BYTES
      ))
  )
    return false;
  return true;
}

async function getStored(env: ArtworkEnv, userId: number) {
  const obj = await env.ARTWORK.get(USER_KEY(userId));
  if (!obj || obj.size > 4096 || !obj.etag) return null;
  try {
    const stored: unknown = JSON.parse(await obj.text());
    return validDescriptor(stored, userId) ? { stored, etag: obj.etag } : null;
  } catch {
    return null;
  }
}

export async function readFallbackArtwork(
  env: ArtworkEnv,
  userId: number
): Promise<FallbackArtwork | null> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  return (await getStored(env, userId))?.stored.artwork ?? null;
}

async function authorizePublishedArtwork(
  env: ArtworkEnv,
  artwork: FallbackArtwork
) {
  const hashes = [
    artwork.sha256,
    ...(artwork.variants ?? []).map((v) => v.sha256),
  ];
  for (const hash of hashes)
    await env.ARTWORK.put(
      ACCEPTED_KEY(hash),
      JSON.stringify({ version: 1, sha256: hash }),
      {
        httpMetadata: {
          contentType: 'application/json',
          cacheControl: 'private, no-store',
        },
        onlyIf: { etagDoesNotMatch: '*' },
      }
    );
}

/** Publish a reviewed generic fallback. Descriptor updates use an R2 compare-and-swap. */
export async function seedFallbackArtwork(
  env: ArtworkEnv,
  userId: number,
  png: Uint8Array,
  expectedHash: string | null,
  reviewEvidence: string,
  source?: { bytes: Uint8Array; sha256: string }
): Promise<FallbackArtwork> {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new ArtworkError('fallback_user_invalid', 400);
  if (expectedHash !== null && !HASH.test(expectedHash))
    throw new ArtworkError('fallback_expected_hash_invalid', 400);
  if (!reviewEvidence.trim() || reviewEvidence.length > 2000)
    throw new ArtworkError('fallback_review_evidence_invalid', 400);
  if (!png.length || png.length > MAX_BYTES)
    throw new ArtworkError('fallback_too_large', 413);
  if (
    source &&
    (source.bytes.length > MAX_BYTES ||
      !HASH.test(source.sha256) ||
      (await sha256(source.bytes)) !== source.sha256)
  )
    throw new ArtworkError('fallback_source_hash_invalid', 400);
  let geometry = false;
  try {
    geometry = validateCandidate(png).pass;
  } catch {
    /* malformed PNG */
  }
  if (!geometry) throw new ArtworkError('candidate_geometry_invalid', 400);
  const hash = await sha256(png);
  const current = await getStored(env, userId);
  if ((current?.stored.artwork.sha256 ?? null) !== expectedHash)
    throw new ArtworkError('fallback_stale', 409);
  if (current?.stored.artwork.sha256 === hash) {
    // Recover an interrupted authorization write after a successful descriptor CAS.
    await authorizePublishedArtwork(env, current.stored.artwork);
    return current.stored.artwork;
  }

  const artwork: FallbackArtwork = {
    kind: 'generic',
    template: 'sony-cdr',
    image_url: `${BASE}${hash}.png`,
    sha256: hash,
    alpha: 'material',
    geometry: { canvas: 1024, center: 512, outer_radius: 480, hole_radius: 60 },
  };
  let webp: Uint8Array | undefined;
  try {
    const encoded = await createLosslessWebp(png);
    if (encoded.byteLength < png.byteLength) webp = encoded;
  } catch {
    /* PNG remains canonical. */
  }
  const variantHash = webp ? await sha256(webp) : null;
  if (webp && variantHash)
    artwork.variants = [
      {
        image_url: `${BASE}${variantHash}.webp`,
        sha256: variantHash,
        format: 'webp',
        width: 1024,
        height: 1024,
        bytes: webp.byteLength,
      },
    ];

  const putImmutable = async (key: string, bytes: Uint8Array, mime: string) => {
    const existing = await env.IMAGES.head(key);
    if (existing) {
      const object = await env.IMAGES.get(key);
      if (
        !object ||
        object.size !== bytes.length ||
        (await sha256(new Uint8Array(await object.arrayBuffer()))) !==
          (key.endsWith('.png') ? hash : variantHash)
      )
        throw new ArtworkError('fallback_asset_conflict', 409);
      return;
    }
    await env.IMAGES.put(key, bytes, {
      httpMetadata: {
        contentType: mime,
        cacheControl: 'public, max-age=31536000, immutable',
      },
      onlyIf: { etagDoesNotMatch: '*' },
    });
  };
  await putImmutable(PUBLIC_KEY(hash, 'png'), png, 'image/png');
  if (webp && variantHash)
    await putImmutable(PUBLIC_KEY(variantHash, 'webp'), webp, 'image/webp');

  if (source)
    await env.ARTWORK.put(
      `fallback/users/${userId}/sources/${source.sha256}`,
      source.bytes,
      {
        httpMetadata: { cacheControl: 'private, no-store' },
        onlyIf: { etagDoesNotMatch: '*' },
      }
    );
  await env.ARTWORK.put(
    `fallback/users/${userId}/reviews/${hash}.json`,
    JSON.stringify({
      version: 1,
      user_id: userId,
      candidate_sha256: hash,
      source_sha256: source?.sha256 ?? null,
      review_evidence: reviewEvidence,
    }),
    {
      httpMetadata: {
        contentType: 'application/json',
        cacheControl: 'private, no-store',
      },
      onlyIf: { etagDoesNotMatch: '*' },
    }
  );
  const next: StoredDescriptor = { version: 1, user_id: userId, artwork };
  const result = await env.ARTWORK.put(USER_KEY(userId), JSON.stringify(next), {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'private, no-store',
    },
    onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' },
  });
  if (!result) throw new ArtworkError('fallback_stale', 409);
  // Only a descriptor that won publication may authorize immutable public reads.
  await authorizePublishedArtwork(env, artwork);
  return artwork;
}

export async function readFallbackAsset(env: ArtworkEnv, file: string) {
  const match = /^(\w{64})\.(png|webp)$/.exec(file);
  if (!match) return null;
  const hash = match[1]!;
  const ext = match[2] as 'png' | 'webp';
  if (!HASH.test(hash)) return null;
  const approved = await env.ARTWORK.get(ACCEPTED_KEY(hash));
  if (!approved || approved.size > 256) return null;
  try {
    const record = JSON.parse(await approved.text()) as {
      version?: number;
      sha256?: string;
    };
    if (record.version !== 1 || record.sha256 !== hash) return null;
  } catch {
    return null;
  }
  const object = await env.IMAGES.get(PUBLIC_KEY(hash, ext));
  if (
    !object ||
    object.size <= 0 ||
    object.size > MAX_BYTES ||
    object.httpMetadata?.contentType !==
      (ext === 'png' ? 'image/png' : 'image/webp')
  )
    return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256(bytes)) !== hash) return null;
  return {
    bytes,
    mime: ext === 'png' ? 'image/png' : 'image/webp',
    sha256: hash,
  };
}
