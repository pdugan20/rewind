import { z } from 'zod';
import type { ArtworkEnv, Job } from './types.js';
import { now, sha256, stable } from './types.js';
import { ArtworkError } from './sources.js';
import { getJob, ownedAlbum } from './store.js';
import { validateCandidate } from './registration.js';
import { artworkMetadata } from './metadata.js';
import { readReviewedAudioDbArtwork } from './audiodb.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewedMasterSchema = z
  .object({
    album_id: z.number().int().positive(),
    expected_album: z
      .object({
        artist: z.string().min(1).max(300),
        title: z.string().min(1).max(300),
      })
      .strict(),
    source_kind: z.enum(['retail', 'cover']),
    source_url: z.url().max(2000),
    source_sha256: hash,
    audiodb: z
      .object({
        release_group_id: z.uuid(),
        provider_album_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      })
      .strict()
      .optional(),
    candidate_sha256: hash,
    release_id: z.uuid().nullable().default(null),
    medium_position: z.number().int().min(1).max(10).nullable().default(null),
    material: z
      .object({
        inner: z.number().min(62).max(185),
        outer: z.number().max(190),
        evidence: z.string().min(12).max(1000),
      })
      .strict()
      .refine((v) => v.outer > v.inner + 6),
    review_evidence: z.string().min(12).max(1000),
    processing: z
      .object({
        model: z.string().min(1).max(150).optional(),
        prompt_sha256: hash.optional(),
        processor_hash: hash.optional(),
        method: z.string().min(1).max(150),
        evidence: z.string().min(12).max(2000),
        evidence_hashes: z
          .object({
            raw: hash.optional(),
            patch: hash.optional(),
            template: hash.optional(),
            master: hash.optional(),
          })
          .strict()
          .default({}),
      })
      .strict(),
  })
  .strict()
  .refine(
    (v) => (v.release_id === null) === (v.medium_position === null),
    'Release and medium must be supplied together'
  );
export type ReviewedMasterInput = z.infer<typeof reviewedMasterSchema>;
export type MasterFiles = {
  source: Uint8Array;
  candidate: Uint8Array;
  raw?: Uint8Array;
  patch?: Uint8Array;
  template?: Uint8Array;
  master?: Uint8Array;
};
const normalize = (s: string) => s.normalize('NFKC').trim().toLowerCase();
function sourceMime(bytes: Uint8Array) {
  if (bytes[0] === 137 && bytes[1] === 80) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216) return 'image/jpeg';
  if (
    new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  throw new ArtworkError('source_format_unsupported');
}
function validateSource(input: ReviewedMasterInput) {
  const url = new URL(input.source_url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw new ArtworkError('source_identity_invalid');
  const mb =
    url.hostname === 'musicbrainz.org' &&
    url.pathname.match(/^\/release\/([a-f0-9-]{36})\/cover-art\/?$/);
  const discogs =
    ['discogs.com', 'www.discogs.com'].includes(url.hostname) &&
    /^\/release\/\d+(?:-[a-zA-Z0-9-]+)?\/?$/.test(url.pathname);
  const cover =
    url.hostname === 'cdn.rewind.rest' &&
    url.pathname.endsWith(`/listening/albums/${input.album_id}/original.jpg`);
  const audioDb =
    url.hostname === 'r2.theaudiodb.com' &&
    /^\/images\/media\/album\/cdart\/[A-Za-z0-9_-]+\.png$/.test(url.pathname);
  if (
    !!input.audiodb !== audioDb ||
    (audioDb && (input.source_kind !== 'retail' || input.release_id !== null))
  )
    throw new ArtworkError('source_identity_invalid');
  if (
    !(mb || discogs || audioDb || (cover && input.source_kind === 'cover')) ||
    (url.search &&
      (!cover || [...url.searchParams.keys()].some((k) => k !== 'v')))
  )
    throw new ArtworkError('source_identity_invalid');
  if ((mb && input.release_id !== mb[1]) || (input.release_id !== null && !mb))
    throw new ArtworkError('source_release_mismatch');
}

/** Fully validates immutable uploads without fetching providers or writing state. */
export async function prepareReviewedMaster(
  env: ArtworkEnv,
  input: ReviewedMasterInput,
  files: MasterFiles,
  userId: number
) {
  const album = await ownedAlbum(env, input.album_id, userId);
  if (
    normalize(album.name) !== normalize(input.expected_album.title) ||
    normalize(album.artist) !== normalize(input.expected_album.artist)
  )
    throw new ArtworkError('album_identity_mismatch', 409);
  validateSource(input);
  if (input.audiodb) {
    const reviewed = await readReviewedAudioDbArtwork(
      env,
      userId,
      input.album_id,
      {
        groupId: input.audiodb.release_group_id,
        providerAlbumId: input.audiodb.provider_album_id,
        sourceUrl: input.source_url,
        sourceSha256: input.source_sha256,
      }
    );
    if (!reviewed)
      throw new ArtworkError('audiodb_official_review_required', 409);
  }
  if (
    files.source.length > 12 * 1024 * 1024 ||
    files.candidate.length > 12 * 1024 * 1024
  )
    throw new ArtworkError('source_too_large');
  const mime = sourceMime(files.source);
  if (
    (await sha256(files.source)) !== input.source_sha256 ||
    (await sha256(files.candidate)) !== input.candidate_sha256
  )
    throw new ArtworkError('import_hash_mismatch');
  let valid = false;
  try {
    valid = validateCandidate(files.candidate).pass;
  } catch {
    /* Malformed PNG is a bounded client error. */
  }
  if (!valid) throw new ArtworkError('candidate_geometry_invalid');
  for (const name of ['raw', 'patch', 'template', 'master'] as const) {
    const bytes = files[name],
      expected = input.processing.evidence_hashes[name];
    if (
      !!bytes !== !!expected ||
      (bytes &&
        (bytes.length > 12 * 1024 * 1024 || (await sha256(bytes)) !== expected))
    )
      throw new ArtworkError('import_evidence_mismatch');
  }
  const id = await sha256(JSON.stringify(stable({ userId, ...input })));
  const existing = await getJob(env, id, userId);
  if (existing && existing.candidate_hash !== input.candidate_sha256)
    throw new ArtworkError('import_state_conflict', 409);
  const active = await env.DB.prepare(
    "SELECT a.pinned,j.candidate_hash FROM cd_artwork_albums a LEFT JOIN cd_artwork_jobs j ON j.id=a.active_job AND j.user_id=a.user_id AND j.album_id=a.album_id AND j.state='accepted' WHERE a.user_id=? AND a.album_id=?"
  )
    .bind(userId, input.album_id)
    .first<{ pinned: number; candidate_hash: string | null }>();
  return {
    id,
    mime,
    existing,
    active,
    metadata: artworkMetadata(files.candidate),
  };
}

/** Import-only jobs can never enter the paid queue. Review and activation stay explicit. */
export async function persistReviewedMaster(
  env: ArtworkEnv,
  input: ReviewedMasterInput,
  files: MasterFiles,
  userId: number,
  prepared: Awaited<ReturnType<typeof prepareReviewedMaster>>
) {
  if (prepared.existing) return { job: prepared.existing, reused: true };
  const sourceKey = `sources/${userId}/${input.source_sha256}`;
  const candidateKey = `candidates/${userId}/${input.candidate_sha256}.png`;
  await env.ARTWORK.put(sourceKey, files.source, {
    httpMetadata: { contentType: prepared.mime },
    onlyIf: { etagDoesNotMatch: '*' },
  });
  await env.ARTWORK.put(candidateKey, files.candidate, {
    httpMetadata: { contentType: 'image/png' },
    onlyIf: { etagDoesNotMatch: '*' },
  });
  const evidenceKeys: Record<string, string> = {};
  for (const name of ['raw', 'patch', 'template', 'master'] as const)
    if (files[name]) {
      const key = `import-evidence/${userId}/${input.processing.evidence_hashes[name]}`;
      await env.ARTWORK.put(key, files[name], {
        onlyIf: { etagDoesNotMatch: '*' },
      });
      evidenceKeys[name] = key;
    }
  const timestamp = now();
  const provenance = {
    imported: true,
    importMethod: 'reviewed-master-v1',
    prepared: true,
    sourceUrl: input.source_url,
    sourceHash: input.source_sha256,
    sourceKind: input.source_kind,
    identityType: input.release_id
      ? 'representative_release'
      : 'reviewed_source',
    releaseId: input.release_id,
    mediumPosition: input.medium_position,
    ...(input.audiodb
      ? {
          sourceIdentityEvidence: {
            provider: 'audiodb',
            release_group_id: input.audiodb.release_group_id,
            provider_album_id: input.audiodb.provider_album_id,
            source_sha256: input.source_sha256,
            officialArtwork: true,
          },
        }
      : {}),
    material: input.material,
    importEvidence: {
      review: input.review_evidence,
      processing: input.processing,
      evidenceKeys,
    },
    metadata: prepared.metadata,
    calculatedUsd: 0,
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO cd_artwork_jobs(id,user_id,album_id,state,input,source_hash,source_key,source_mime,candidate_hash,candidate_key,provenance,updated_at,created_at) VALUES(?,?,?,'pending',?,?,?,?,?,?,?,?,?)"
    ).bind(
      prepared.id,
      userId,
      input.album_id,
      JSON.stringify(input),
      input.source_sha256,
      sourceKey,
      prepared.mime,
      input.candidate_sha256,
      candidateKey,
      JSON.stringify(provenance),
      timestamp,
      timestamp
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check,discovery_outcome,discovery_evidence) VALUES(?,?,?,?,?,'reviewed_master_pending','{}')"
    ).bind(
      userId,
      input.album_id,
      input.release_id ?? '',
      input.medium_position ?? 1,
      new Date(Date.now() + 30 * 86400000).toISOString()
    ),
  ]);
  const job = await getJob(env, prepared.id, userId);
  if (!job || job.candidate_hash !== input.candidate_sha256)
    throw new ArtworkError('import_state_conflict', 409);
  return { job: job as Job, reused: false };
}
