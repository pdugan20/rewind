import type { ArtworkEnv } from './types.js';
import { sha256 } from './types.js';
import { validateCandidate } from './registration.js';
import {
  createDeliveryWebp,
  isStoredWebpVariant,
  WEBP_VARIANT_DIMENSION,
  type StoredWebpVariant,
} from './webp-variant.js';

const VARIANT_PREFIX = 'listening/cd-artwork-variants/';
/** Variants prepared now; earlier versions' descriptors are still read. */
export const CURRENT_VERSION = 3;
type VariantVersion = StoredWebpVariant['version'];
/** Newest first: the version a manifest advertises when several verify. */
const READ_ORDER = [3, 2, 1] as const satisfies readonly VariantVersion[];
const verifiedVariantEtags = new Map<string, { etag: string; until: number }>();
const VERIFIED_VARIANT_TTL_MS = 60_000;
const VERIFIED_VARIANT_CACHE_SIZE = 64;
const canonicalKey = (hash: string) => `listening/cd-artwork/${hash}.png`;
// Each version keeps its own descriptor for a canonical image, so preparing a
// delivery variant never overwrites (or depends on) an earlier lossless one.
const metadataKey = (hash: string, version: VariantVersion) =>
  version === 1
    ? `${VARIANT_PREFIX}${hash}.json`
    : `${VARIANT_PREFIX}v${version}/${hash}.json`;
// Indexed by the variant's own hash, per version: the delivery encode can be
// byte-identical to an earlier lossless one, and each must stay verifiable.
const variantIndexKey = (hash: string, version: VariantVersion) =>
  version === 1
    ? `${VARIANT_PREFIX}by-hash/${hash}.json`
    : `${VARIANT_PREFIX}by-hash/v${version}/${hash}.json`;
const variantKey = (hash: string) => `${VARIANT_PREFIX}${hash}.webp`;

interface VariantCheck {
  variant_sha256: string;
  etag: string;
  bytes: number;
}
/** Verification records kept per canonical image, newest first. */
const CHECKS_PER_IMAGE = 8;

/**
 * Storage ETags that this canonical image's variants were last hashed under.
 * Keyed by the canonical hash so it can be read alongside the descriptor.
 */
async function variantChecks(
  env: ArtworkEnv,
  canonicalHash: string
): Promise<VariantCheck[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT variant_sha256,etag,bytes FROM cd_artwork_variant_checks WHERE canonical_hash=? ORDER BY verified_at DESC LIMIT ${CHECKS_PER_IMAGE}`
    )
      .bind(canonicalHash)
      .all<VariantCheck>();
    return results ?? [];
  } catch {
    return [];
  }
}

/**
 * The verification records for a whole manifest in one query, so its variant
 * lookups don't each spend a database round trip. Missing images map to none.
 */
export async function variantChecksFor(
  env: ArtworkEnv,
  canonicalHashes: readonly string[]
): Promise<Map<string, VariantCheck[]>> {
  const hashes = [
    ...new Set(canonicalHashes.filter((hash) => /^[a-f0-9]{64}$/.test(hash))),
  ];
  const checks = new Map<string, VariantCheck[]>();
  if (!hashes.length) return checks;
  try {
    const { results } = await env.DB.prepare(
      `SELECT canonical_hash,variant_sha256,etag,bytes FROM cd_artwork_variant_checks WHERE canonical_hash IN (${hashes.map(() => '?').join(',')}) ORDER BY verified_at DESC`
    )
      .bind(...hashes)
      .all<VariantCheck & { canonical_hash: string }>();
    for (const { canonical_hash, ...check } of results ?? []) {
      const list = checks.get(canonical_hash) ?? [];
      if (list.length < CHECKS_PER_IMAGE) list.push(check);
      checks.set(canonical_hash, list);
    }
  } catch {
    // Without records, each variant is verified by downloading it instead.
  }
  return checks;
}

async function recordVerified(
  env: ArtworkEnv,
  descriptor: StoredWebpVariant,
  etag: string
) {
  try {
    await env.DB.prepare(
      'INSERT INTO cd_artwork_variant_checks (variant_sha256,canonical_hash,etag,bytes,verified_at) VALUES (?,?,?,?,?) ON CONFLICT(variant_sha256) DO UPDATE SET canonical_hash=excluded.canonical_hash,etag=excluded.etag,bytes=excluded.bytes,verified_at=excluded.verified_at'
    )
      .bind(
        descriptor.sha256,
        descriptor.canonical_hash,
        etag,
        descriptor.bytes,
        new Date().toISOString()
      )
      .run();
  } catch {
    // The record only saves a later re-download; verification already passed.
  }
}

async function acceptedCandidate(
  env: ArtworkEnv,
  hash: string,
  userId: number
) {
  return env.DB.prepare(
    "SELECT id FROM cd_artwork_jobs WHERE candidate_hash=? AND user_id=? AND state='accepted' LIMIT 1"
  )
    .bind(hash, userId)
    .first<{ id: string }>();
}

export async function prepareAcceptedWebpVariant(
  env: ArtworkEnv,
  canonicalHash: string,
  userId: number
): Promise<StoredWebpVariant | null> {
  if (!/^[a-f0-9]{64}$/.test(canonicalHash)) return null;
  if (!(await acceptedCandidate(env, canonicalHash, userId))) return null;
  const existing = await readStoredWebpVariant(
    env,
    canonicalHash,
    CURRENT_VERSION
  );
  if (existing) return existing;

  const canonical = await env.IMAGES.get(canonicalKey(canonicalHash));
  if (!canonical || canonical.size <= 0 || canonical.size > 8 * 1024 * 1024)
    return null;
  const png = new Uint8Array(await canonical.arrayBuffer());
  if ((await sha256(png)) !== canonicalHash || !validateCandidate(png).pass)
    return null;

  const webp = await createDeliveryWebp(png);
  if (webp.byteLength >= png.byteLength) return null;
  const variantHash = await sha256(webp);
  const stored: StoredWebpVariant = {
    canonical_hash: canonicalHash,
    sha256: variantHash,
    format: 'webp',
    width: WEBP_VARIANT_DIMENSION,
    height: WEBP_VARIANT_DIMENSION,
    bytes: webp.byteLength,
    version: CURRENT_VERSION,
  };

  // A withdrawal/rejection during encoding must not publish new public metadata.
  if (!(await acceptedCandidate(env, canonicalHash, userId))) return null;
  await env.IMAGES.put(variantKey(variantHash), webp, {
    httpMetadata: {
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000, immutable',
    },
    onlyIf: { etagDoesNotMatch: '*' },
  });
  const uploaded = await env.IMAGES.head(variantKey(variantHash));
  if (
    !uploaded ||
    uploaded.size !== webp.byteLength ||
    uploaded.httpMetadata?.contentType !== 'image/webp'
  )
    return null;
  const verifiedUpload = await env.IMAGES.get(variantKey(variantHash));
  if (
    !verifiedUpload ||
    (await sha256(new Uint8Array(await verifiedUpload.arrayBuffer()))) !==
      variantHash
  )
    return null;
  await env.IMAGES.put(
    metadataKey(canonicalHash, CURRENT_VERSION),
    JSON.stringify(stored),
    {
      httpMetadata: {
        contentType: 'application/json',
        cacheControl: 'private, no-store',
      },
      onlyIf: { etagDoesNotMatch: '*' },
    }
  );
  await env.IMAGES.put(
    variantIndexKey(variantHash, CURRENT_VERSION),
    JSON.stringify(stored),
    {
      httpMetadata: {
        contentType: 'application/json',
        cacheControl: 'private, no-store',
      },
      onlyIf: { etagDoesNotMatch: '*' },
    }
  );
  return readStoredWebpVariant(env, canonicalHash, CURRENT_VERSION);
}

/**
 * The verified variant to advertise: the newest prepared delivery variant,
 * else an earlier one. Pass a version to read only that.
 * A manifest passes the image's verification records from variantChecksFor.
 */
export async function readStoredWebpVariant(
  env: ArtworkEnv,
  canonicalHash: string,
  only?: VariantVersion,
  knownChecks?: VariantCheck[]
): Promise<StoredWebpVariant | null> {
  // Two storage rounds: the descriptor (with its verification records), then
  // the index with the object's headers. Older descriptors are read only when
  // no newer variant verifies: a Worker holds at most six storage connections
  // at once, and a manifest's lookups share them, so a read that is usually
  // discarded delays every other disc's lookup.
  const checks = knownChecks
    ? Promise.resolve(knownChecks)
    : variantChecks(env, canonicalHash);
  for (const version of only ? [only] : READ_ORDER) {
    const [records, metadata] = await Promise.all([
      checks,
      env.IMAGES.get(metadataKey(canonicalHash, version)),
    ]);
    const verified = await verifyStoredWebpVariant(
      env,
      canonicalHash,
      version,
      metadata,
      records
    );
    if (verified) return verified;
  }
  return null;
}

/** Releases an R2 body that won't be read, so it doesn't hold a connection. */
function discard(object: R2ObjectBody | null) {
  if (object && !object.bodyUsed) void object.body.cancel().catch(() => {});
}

async function verifyStoredWebpVariant(
  env: ArtworkEnv,
  canonicalHash: string,
  version: VariantVersion,
  metadata: R2ObjectBody | null,
  checks: VariantCheck[]
) {
  if (!metadata || metadata.size > 1024) {
    discard(metadata);
    return null;
  }
  try {
    const descriptor = JSON.parse(await metadata.text()) as unknown;
    if (
      !isStoredWebpVariant(descriptor, canonicalHash) ||
      descriptor.version !== version
    )
      return null;
    const [index, object] = await Promise.all([
      env.IMAGES.get(variantIndexKey(descriptor.sha256, version)),
      env.IMAGES.head(variantKey(descriptor.sha256)),
    ]);
    if (!index || index.size > 1024) {
      discard(index);
      return null;
    }
    const indexed = JSON.parse(await index.text()) as unknown;
    if (
      !isStoredWebpVariant(indexed, canonicalHash) ||
      indexed.sha256 !== descriptor.sha256 ||
      indexed.format !== descriptor.format ||
      indexed.width !== descriptor.width ||
      indexed.height !== descriptor.height ||
      indexed.bytes !== descriptor.bytes ||
      indexed.version !== descriptor.version
    )
      return null;
    if (
      !object ||
      object.size !== descriptor.bytes ||
      object.httpMetadata?.contentType !== 'image/webp' ||
      !object.etag
    )
      return null;
    const cached = verifiedVariantEtags.get(descriptor.sha256);
    const fresh =
      cached !== undefined &&
      cached.until > Date.now() &&
      cached.etag === object.etag;
    // Bytes hashed earlier under this same ETag have not been replaced since.
    const durable =
      !fresh &&
      checks.some(
        (check) =>
          check.variant_sha256 === descriptor.sha256 &&
          check.etag === object.etag &&
          check.bytes === descriptor.bytes
      );
    if (!fresh && !durable) {
      const body = await env.IMAGES.get(variantKey(descriptor.sha256));
      if (
        !body ||
        body.etag !== object.etag ||
        (await sha256(new Uint8Array(await body.arrayBuffer()))) !==
          descriptor.sha256
      ) {
        // eslint-disable-next-line drizzle/enforce-delete-with-where -- This is a Map cache eviction, not a SQL DELETE.
        verifiedVariantEtags.delete(descriptor.sha256);
        return null;
      }
      // eslint-disable-next-line drizzle/enforce-delete-with-where -- Refresh Map insertion order.
      verifiedVariantEtags.delete(descriptor.sha256);
      verifiedVariantEtags.set(descriptor.sha256, {
        etag: object.etag,
        until: Date.now() + VERIFIED_VARIANT_TTL_MS,
      });
      while (verifiedVariantEtags.size > VERIFIED_VARIANT_CACHE_SIZE)
        // eslint-disable-next-line drizzle/enforce-delete-with-where -- Bounded Map cache eviction.
        verifiedVariantEtags.delete(verifiedVariantEtags.keys().next().value!);
      await recordVerified(env, descriptor, object.etag);
    } else if (durable) {
      // eslint-disable-next-line drizzle/enforce-delete-with-where -- Refresh Map insertion order.
      verifiedVariantEtags.delete(descriptor.sha256);
      verifiedVariantEtags.set(descriptor.sha256, {
        etag: object.etag,
        until: Date.now() + VERIFIED_VARIANT_TTL_MS,
      });
      while (verifiedVariantEtags.size > VERIFIED_VARIANT_CACHE_SIZE)
        // eslint-disable-next-line drizzle/enforce-delete-with-where -- Bounded Map cache eviction.
        verifiedVariantEtags.delete(verifiedVariantEtags.keys().next().value!);
    } else {
      // Refresh insertion order for simple bounded LRU eviction.
      // eslint-disable-next-line drizzle/enforce-delete-with-where -- Refresh Map insertion order.
      verifiedVariantEtags.delete(descriptor.sha256);
      verifiedVariantEtags.set(descriptor.sha256, cached!);
    }
    return descriptor;
  } catch {
    return null;
  }
}

export async function readWebpVariantByHash(env: ArtworkEnv, hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  for (const version of READ_ORDER) {
    const found = await readWebpVariantVersion(env, hash, version);
    if (found) return found;
  }
  return null;
}

async function readWebpVariantVersion(
  env: ArtworkEnv,
  hash: string,
  version: VariantVersion
) {
  const index = await env.IMAGES.get(variantIndexKey(hash, version));
  if (!index || index.size > 1024) return null;
  try {
    const descriptor = JSON.parse(await index.text()) as unknown;
    if (
      !isStoredWebpVariant(
        descriptor,
        (descriptor as StoredWebpVariant).canonical_hash
      )
    )
      return null;
    if (descriptor.sha256 !== hash || descriptor.version !== version)
      return null;
    const metadata = await env.IMAGES.get(
      metadataKey(descriptor.canonical_hash, descriptor.version)
    );
    if (!metadata || metadata.size > 1024) return null;
    const canonicalDescriptor = JSON.parse(await metadata.text()) as unknown;
    if (
      !isStoredWebpVariant(canonicalDescriptor, descriptor.canonical_hash) ||
      canonicalDescriptor.sha256 !== descriptor.sha256 ||
      canonicalDescriptor.format !== descriptor.format ||
      canonicalDescriptor.width !== descriptor.width ||
      canonicalDescriptor.height !== descriptor.height ||
      canonicalDescriptor.bytes !== descriptor.bytes ||
      canonicalDescriptor.version !== descriptor.version
    )
      return null;
    const approved = await env.DB.prepare(
      "SELECT id FROM cd_artwork_jobs WHERE candidate_hash=? AND state='accepted' LIMIT 1"
    )
      .bind(descriptor.canonical_hash)
      .first();
    if (!approved) return null;
    const object = await env.IMAGES.get(variantKey(hash));
    if (
      !object ||
      object.size !== descriptor.bytes ||
      object.httpMetadata?.contentType !== 'image/webp'
    )
      return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    if ((await sha256(bytes)) !== hash) return null;
    return { descriptor, bytes };
  } catch {
    return null;
  }
}

export async function dispatchWebpVariant(
  env: ArtworkEnv,
  canonicalHash: string,
  userId: number
): Promise<
  | 'not_accepted'
  | 'created'
  | 'already_active'
  | 'already_complete'
  | 'base_status_unknown'
  | 'recovery_created'
  | 'recovery_exists'
  | 'recovery_status_unknown'
> {
  if (
    !/^[a-f0-9]{64}$/.test(canonicalHash) ||
    !(await acceptedCandidate(env, canonicalHash, userId))
  )
    return 'not_accepted';
  const workflowId = `webp-v${CURRENT_VERSION}-${canonicalHash}`;
  try {
    await env.CD_WORKFLOW.create({
      id: workflowId,
      params: { jobId: canonicalHash, userId, variantOnly: true },
    });
    return 'created';
  } catch {
    // A known active/complete instance deduplicates approvals and lost responses.
    try {
      const existing = await env.CD_WORKFLOW.get(workflowId);
      const status = await existing.status();
      if (status.status === 'complete') return 'already_complete';
      if (status.status !== 'errored') {
        if (['queued', 'running', 'paused', 'pending'].includes(status.status))
          return 'already_active';
        return 'base_status_unknown';
      }
    } catch {
      console.log('[ERROR] CD artwork variant dispatch unavailable');
      return 'base_status_unknown';
    }
  }

  // One deterministic recovery instance is the lifetime retry ceiling per hash.
  const recoveryId = `webp-v${CURRENT_VERSION}-r1-${canonicalHash}`;
  try {
    await env.CD_WORKFLOW.create({
      id: recoveryId,
      params: { jobId: canonicalHash, userId, variantOnly: true },
    });
    return 'recovery_created';
  } catch {
    try {
      const existing = await env.CD_WORKFLOW.get(recoveryId);
      const status = await existing.status();
      if (
        [
          'queued',
          'running',
          'paused',
          'pending',
          'complete',
          'errored',
        ].includes(status.status)
      )
        return 'recovery_exists';
      return 'recovery_status_unknown';
    } catch {
      console.log('[ERROR] CD artwork variant recovery unavailable');
      return 'recovery_status_unknown';
    }
  }
}
