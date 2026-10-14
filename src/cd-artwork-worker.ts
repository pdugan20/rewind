import {
  queueArtworkReprocessing,
  queueRenderRetry,
} from './services/cd-artwork/reprocessing.js';
import {
  galleryApp,
  registerGalleryData,
} from './services/cd-artwork/gallery.js';
import { selectAutomaticSource } from './services/cd-artwork/selection.js';
import { publishAutomatic } from './services/cd-artwork/automatic.js';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import {
  WorkflowEntrypoint,
  WorkerEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { requireAuth } from './lib/auth.js';
import { cors } from './lib/cors.js';
import type { Env } from './types/env.js';
import type { ArtworkEnv, JobInput, Job } from './services/cd-artwork/types.js';
import { now, sha256 } from './services/cd-artwork/types.js';
import {
  ArtworkError,
  boundedBytes,
  resolveEditionCandidates,
  resolveSource,
} from './services/cd-artwork/sources.js';
import {
  enqueue,
  dispatch,
  getJob,
  ownedAlbum,
  publicJob,
  artworkSnapshot,
  materialRevision,
} from './services/cd-artwork/store.js';
import { generateOnce, processRaw } from './services/cd-artwork/generation.js';
import { reviewJob, importCandidate } from './services/cd-artwork/review.js';
import {
  dispatchWebpVariant,
  prepareAcceptedWebpVariant,
  readStoredWebpVariant,
  readWebpVariantByHash,
} from './services/cd-artwork/webp-storage.js';
import {
  reviewedMasterSchema,
  prepareReviewedMaster,
  persistReviewedMaster,
  type MasterFiles,
} from './services/cd-artwork/reviewed-master.js';
import {
  checkListeningArtwork,
  dispatchListeningChecks,
  finishCheck,
} from './services/cd-artwork/discovery.js';
import type { DiscoveryCheck } from './services/cd-artwork/discovery.js';
import { scheduledArtwork } from './services/cd-artwork/scheduler.js';
import {
  readFallbackArtwork,
  readFallbackAsset,
  seedFallbackArtwork,
  type FallbackArtwork,
} from './services/cd-artwork/fallback.js';
import { validateCandidate } from './services/cd-artwork/registration.js';
import {
  prepareAudioDbArtwork,
  reviewAudioDbArtwork,
  readAudioDbReviewHash,
} from './services/cd-artwork/audiodb.js';

const materialSchema = z
  .object({
    inner: z.number().min(62).max(185),
    outer: z.number().max(190),
    opacity: z.number().min(0.15).max(0.9),
    evidence: z.string().min(8).max(1000),
  })
  .strict()
  .refine((v) => v.outer > v.inner + 6, 'Material region too narrow');
export const inputSchema = z
  .object({
    album_id: z.number().int().positive(),
    release_id: z.uuid().nullable(),
    medium_position: z.number().int().min(1).max(10).nullable(),
    source_kind: z.enum(['auto', 'retail', 'cover']).default('auto'),
    image_id: z.string().regex(/^\d+$/).optional(),
    cover_url: z.url().max(2000).optional(),
    material: materialSchema.optional(),
    refresh_source: z.boolean().optional(),
    test_tag: z
      .string()
      .regex(/^[a-z0-9-]{1,80}$/)
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.release_id === null) === (v.medium_position === null) &&
      (v.release_id !== null || v.source_kind === 'cover'),
    'A release and medium are required for retail artwork'
  );
const app = new Hono<{ Bindings: Env & ArtworkEnv }>();
app.notFound((c) => c.json({ error: 'Not found', status: 404 }, 404));
const read = '/v1/listening/cd-artwork',
  admin = '/v1/admin/cd-artwork';
async function artworkSnapshotWithVariants(
  env: ArtworkEnv,
  albumIds: number[],
  userId: number,
  /** Keeps unfinished variant lookups alive after the response is sent. */
  keepAlive?: (work: Promise<unknown>) => void
) {
  let expired = false;
  let fallback: FallbackArtwork | null = null;
  const fallbackRead = readFallbackArtwork(env, userId)
    .catch(() => null)
    .then((value) => {
      if (!expired) fallback = value;
    });
  const snapshot = await artworkSnapshot(env, albumIds, userId);
  // PNG publication is authoritative. Optional WebP reads must not delay the
  // entire manifest beyond a consumer's deadline and hide valid artwork.
  const data = [...snapshot.data];
  let next = 0;
  const projectNext = async () => {
    while (!expired) {
      const index = next++;
      if (index >= snapshot.data.length) return;
      const artwork = snapshot.data[index];
      if (!artwork.sha256) {
        data[index] = artwork;
        continue;
      }
      const variant = await readStoredWebpVariant(env, artwork.sha256).catch(
        () => null
      );
      if (expired) return;
      if (!variant) {
        data[index] = artwork;
        continue;
      }
      data[index] = {
        ...artwork,
        variants: [
          {
            image_url: `https://api.rewind.rest${read}/assets/${variant.sha256}.webp`,
            sha256: variant.sha256,
            format: variant.format,
            width: variant.width,
            height: variant.height,
            bytes: variant.bytes,
          },
        ],
      };
    }
  };
  // At most 20 albums per request; each lookup is a few small metadata reads.
  const variants = Promise.all(
    Array.from({ length: snapshot.data.length }, projectNext)
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([variants, fallbackRead]),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve();
        }, 500);
      }),
    ]);
  } finally {
    expired = true;
    clearTimeout(timer);
  }
  // A slow first verification finishes in the background and records its
  // ETag, so the next manifest can advertise that variant without a download.
  keepAlive?.(variants.catch(() => {}));
  return {
    ...snapshot,
    data,
    ...(fallback ? { fallback_artwork: fallback } : {}),
  };
}
app.use('*', async (c, next) => cors(c.env)(c, next));
app.use(
  `${admin}/*`,
  createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const path = c.req.path;
    if (path === `${admin}/gallery` || path.startsWith(`${admin}/gallery/`))
      return next();
    return requireAuth('admin')(c, next);
  })
);
app.route(`${admin}/gallery`, galleryApp);
registerGalleryData(app, `${admin}/reviews`);
app.use(`${read}/albums`, requireAuth('read'));
app.use(`${read}/albums/*`, requireAuth('read'));
app.onError((error, c) => {
  if (error instanceof ArtworkError)
    return c.json(
      { error: error.code, status: error.status },
      error.status as 400
    );
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return c.json({ error: 'Invalid artwork request', status: 400 }, 400);
  console.log('[ERROR] CD artwork request failed');
  return c.json({ error: 'Artwork service unavailable', status: 503 }, 503);
});
async function jsonBody(request: Request) {
  return JSON.parse(
    new TextDecoder().decode(
      await boundedBytes(new Response(request.body), 16 * 1024)
    )
  );
}
const assetId = z.string().regex(/^[a-f0-9]{64}$/);
/** Background work for this request, when the runtime provides a context. */
const background =
  (c: { executionCtx: { waitUntil(work: Promise<unknown>): void } }) =>
  (work: Promise<unknown>) => {
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      // Without an execution context the lookups simply end with the request.
    }
  };
app.get(`${read}/albums`, async (c) => {
  const ids = z
    .array(z.coerce.number().int().positive())
    .max(20)
    .parse((c.req.query('ids') ?? '').split(',').filter(Boolean));
  return c.json(
    await artworkSnapshotWithVariants(
      c.env,
      ids,
      c.get('userId'),
      background(c)
    ),
    {
      headers: { 'Cache-Control': 'private, max-age=60' },
    }
  );
});
app.get(`${read}/albums/:id`, async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  await ownedAlbum(c.env, id, c.get('userId'));
  const snapshot = await artworkSnapshotWithVariants(
    c.env,
    [id],
    c.get('userId'),
    background(c)
  );
  return c.json(
    {
      album_id: id,
      artwork: snapshot.data[0] ?? null,
      withdrawal: snapshot.withdrawals[0] ?? null,
      ...(snapshot.fallback_artwork
        ? { fallback_artwork: snapshot.fallback_artwork }
        : {}),
    },
    { headers: { 'Cache-Control': 'private, max-age=60' } }
  );
});
app.get(`${read}/fallback/assets/:file`, async (c) => {
  const asset = await readFallbackAsset(c.env, c.req.param('file'));
  if (!asset) return c.notFound();
  return new Response(asset.bytes, {
    headers: {
      'Content-Type': asset.mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      ETag: `"${asset.sha256}"`,
    },
  });
});
app.post(`${admin}/fallback`, async (c) => {
  const bytes = await boundedBytes(
    new Response(c.req.raw.body),
    17 * 1024 * 1024
  );
  const form = await new Response(new Uint8Array(bytes), {
    headers: { 'Content-Type': c.req.header('Content-Type') ?? '' },
  }).formData();
  const input = z
    .object({
      expected_sha256: assetId.nullable(),
      review_evidence: z.string().trim().min(12).max(2000),
      source_sha256: assetId.optional(),
    })
    .strict()
    .parse(JSON.parse(z.string().parse(form.get('input'))));
  const file = form.get('candidate');
  const original = form.get('source');
  if (
    !(file instanceof File) ||
    !file.size ||
    file.size > 8 * 1024 * 1024 ||
    (original !== null &&
      (!(original instanceof File) ||
        !original.size ||
        original.size > 8 * 1024 * 1024)) ||
    (original !== null) !== (input.source_sha256 !== undefined)
  )
    throw new ArtworkError('invalid_fallback_import', 400);
  const png = new Uint8Array(await file.arrayBuffer());
  let valid = false;
  try {
    valid = validateCandidate(png).pass;
  } catch {
    /* Malformed upload. */
  }
  if (!valid) throw new ArtworkError('candidate_geometry_invalid', 400);
  const source =
    original instanceof File
      ? {
          bytes: new Uint8Array(await original.arrayBuffer()),
          sha256: input.source_sha256!,
        }
      : undefined;
  if (source && (await sha256(source.bytes)) !== source.sha256)
    throw new ArtworkError('fallback_source_hash_invalid', 400);
  const current = await readFallbackArtwork(c.env, c.get('userId'));
  if ((current?.sha256 ?? null) !== input.expected_sha256)
    throw new ArtworkError('fallback_stale', 409);
  if (c.req.query('apply') !== 'true')
    return c.json({
      validated: true,
      sha256: await sha256(png),
      current_sha256: current?.sha256 ?? null,
    });
  return c.json(
    await seedFallbackArtwork(
      c.env,
      c.get('userId'),
      png,
      input.expected_sha256,
      input.review_evidence,
      source
    )
  );
});
app.get(`${read}/assets/:file`, async (c) => {
  const file = c.req.param('file');
  if (/^[a-f0-9]{64}\.webp$/.test(file)) {
    const hash = file.slice(0, 64);
    const variant = await readWebpVariantByHash(c.env, hash);
    if (!variant) return c.notFound();
    return new Response(variant.bytes, {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
        ETag: `"${hash}"`,
      },
    });
  }
  if (!/^[a-f0-9]{64}\.png$/.test(file)) return c.notFound();
  const h = file.slice(0, 64);
  const approved = await c.env.DB.prepare(
    "SELECT id FROM cd_artwork_jobs WHERE candidate_hash=? AND state='accepted' LIMIT 1"
  )
    .bind(h)
    .first();
  if (!approved) return c.notFound();
  const object = await c.env.IMAGES.get(`listening/cd-artwork/${file}`);
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      ETag: `"${h}"`,
    },
  });
});
app.get(`${admin}/identities`, async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT album_id,NULLIF(release_id,'') AS release_id,CASE WHEN release_id='' THEN NULL ELSE medium_position END AS medium_position,discovery_outcome,last_checked_at,next_check,active_job,pinned FROM cd_artwork_albums WHERE user_id=? ORDER BY album_id DESC LIMIT 25"
  )
    .bind(c.get('userId'))
    .all();
  return c.json({ data: rows.results });
});
app.post(`${admin}/webp-backfill`, async (c) => {
  const body = z
    .object({
      album_ids: z.array(z.number().int().positive()).min(1).max(20),
      dry_run: z.boolean().default(true),
    })
    .strict()
    .parse(await jsonBody(c.req.raw));
  const userId = c.get('userId');
  const albumIds = [...new Set(body.album_ids)];
  for (const albumId of albumIds) await ownedAlbum(c.env, albumId, userId);

  // The scoped snapshot excludes hidden, withdrawn, rejected, and inactive jobs.
  const snapshot = await artworkSnapshot(c.env, albumIds, userId);
  const byHash = new Map<string, { album_ids: number[] }>();
  for (const artwork of snapshot.data) {
    if (!artwork.sha256) continue;
    const existing = byHash.get(artwork.sha256);
    if (existing) existing.album_ids.push(artwork.album_id);
    else byHash.set(artwork.sha256, { album_ids: [artwork.album_id] });
  }

  const items: Array<{
    album_ids: number[];
    canonical_sha256: string;
    status: string;
  }> = [];
  for (const [canonicalHash, { album_ids }] of byHash) {
    const prepared = await readStoredWebpVariant(c.env, canonicalHash);
    const status = prepared
      ? 'already_prepared'
      : body.dry_run
        ? 'would_dispatch'
        : await dispatchWebpVariant(c.env, canonicalHash, userId);
    items.push({ album_ids, canonical_sha256: canonicalHash, status });
  }
  const status_counts = items.reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
  const eligibleAlbumIds = new Set(snapshot.data.map((item) => item.album_id));
  return c.json(
    {
      dry_run: body.dry_run,
      requested_album_count: albumIds.length,
      eligible_album_count: eligibleAlbumIds.size,
      skipped_album_ids: albumIds.filter((id) => !eligibleAlbumIds.has(id)),
      unique_hash_count: items.length,
      status_counts,
      items,
    },
    body.dry_run ? 200 : 202
  );
});
app.post(`${admin}/albums/:id/resolve`, async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const album = await ownedAlbum(c.env, id, c.get('userId'));
  return c.json(await resolveEditionCandidates(c.env, album));
});
app.post(`${admin}/albums/:id/audiodb`, async (c) => {
  const albumId = z.coerce.number().int().positive().parse(c.req.param('id'));
  const userId = c.get('userId');
  const album = await ownedAlbum(c.env, albumId, userId);
  const body = z
    .object({
      release_id: z.uuid(),
      medium_position: z.number().int().min(1).max(10),
      review: z
        .object({
          groupId: z.uuid(),
          providerAlbumId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
          sourceUrl: z.url().max(2000),
          sourceSha256: assetId,
          expectedPreviousSha256: assetId.nullable().optional(),
          officialArtwork: z.literal(true),
          evidence: z.string().trim().min(12).max(2000),
        })
        .strict()
        .optional(),
    })
    .strict()
    .parse(await jsonBody(c.req.raw));
  const source = await resolveSource(
    c.env,
    {
      album_id: albumId,
      release_id: body.release_id,
      medium_position: body.medium_position,
      source_kind: 'retail',
    },
    album,
    true
  );
  if (!source.discovery.medium_verified || !source.discovery.release_group_id)
    throw new ArtworkError('edition_medium_ambiguous', 422);
  const prepared = await prepareAudioDbArtwork(
    c.env,
    album,
    source.discovery.release_group_id
  );
  if (!prepared) return c.json({ outcome: 'not_found' });
  const { bytes: _bytes, ...candidate } = prepared;
  if (c.req.query('apply') !== 'true')
    return c.json({
      outcome: 'needs_official_artwork_review',
      candidate,
      previous_review_sha256: await readAudioDbReviewHash(
        c.env,
        userId,
        albumId,
        prepared.groupId,
        prepared.providerAlbumId
      ),
    });
  if (!body.review) throw new ArtworkError('audiodb_review_required', 400);
  for (const field of [
    'groupId',
    'providerAlbumId',
    'sourceUrl',
    'sourceSha256',
  ] as const)
    if (body.review[field] !== prepared[field])
      throw new ArtworkError('audiodb_review_binding_changed', 409);
  return c.json({
    outcome: 'reviewed',
    source: await reviewAudioDbArtwork(
      c.env,
      userId,
      albumId,
      album,
      prepared,
      true,
      body.review.evidence,
      body.review.expectedPreviousSha256
    ),
  });
});
app.get(`${read}/health`, requireAuth('read'), async (c) =>
  c.json({
    status: (await c.env.DB.prepare(
      'SELECT id FROM cd_artwork_control WHERE id=1'
    ).first())
      ? 'ok'
      : 'unavailable',
  })
);
app.post(`${admin}/jobs`, async (c) => {
  const input = inputSchema.parse(await jsonBody(c.req.raw));
  const result = await enqueue(c.env, input, c.get('userId'));
  await dispatch(c.env, result.job);
  return c.json(
    { ...publicJob(result.job), reused: result.reused },
    result.reused ? 200 : 202
  );
});
// Owner-authorized reset enters the existing automatic discovery outbox.
app.post(`${admin}/reprocess`, async (c) => {
  const body = z
    .object({
      album_ids: z.array(z.number().int().positive()).min(1).max(20),
      dry_run: z.boolean().default(true),
    })
    .strict()
    .parse(await jsonBody(c.req.raw));
  const result = await queueArtworkReprocessing(
    c.env,
    c.get('userId'),
    [...new Set(body.album_ids)],
    body.dry_run
  );
  if (!body.dry_run) c.executionCtx.waitUntil(dispatchListeningChecks(c.env));
  return c.json(result, body.dry_run ? 200 : 202);
});

// Replay the automatic policy for one owned album with real recorded history.
// Preview is the default; apply never fabricates a listening event.
app.post(`${admin}/albums/:id/automatic`, async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const userId = c.get('userId');
  const album = await ownedAlbum(c.env, id, userId);
  const control = await c.env.DB.prepare(
    'SELECT enabled,automatic_enabled FROM cd_artwork_control WHERE id=1'
  ).first<{ enabled: number; automatic_enabled: number }>();
  if (
    userId !== 1 ||
    !control?.enabled ||
    (c.req.query('apply') === 'true' && !control.automatic_enabled)
  )
    throw new ArtworkError('automatic_processing_disabled', 409);
  const recorded = await c.env.DB.prepare(
    'SELECT id FROM lastfm_scrobbles WHERE user_id=? AND album_recorded=1 AND album_id=? UNION ALL SELECT s.id FROM lastfm_tracks t INDEXED BY idx_lastfm_tracks_user_album JOIN lastfm_scrobbles s INDEXED BY idx_lastfm_scrobbles_user_track_date ON s.track_id=t.id AND s.user_id=t.user_id WHERE t.user_id=? AND t.album_id=? AND s.album_recorded=0 LIMIT 1'
  )
    .bind(userId, id, userId, id)
    .first();
  if (!recorded) throw new ArtworkError('recorded_album_play_required');
  const filtered = await c.env.DB.prepare(
    'SELECT a.id FROM lastfm_albums a JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id WHERE a.id=? AND a.user_id=? AND a.is_filtered=0 AND r.is_filtered=0'
  )
    .bind(id, userId)
    .first();
  if (!filtered) throw new ArtworkError('album_not_eligible');
  const active = await c.env.DB.prepare(
    "SELECT c.release_id,c.medium_position,c.active_job,c.pinned,c.review_hold,json_extract(j.input,'$.source_kind') AS source_kind,j.state FROM cd_artwork_albums c LEFT JOIN cd_artwork_jobs j ON j.id=c.active_job AND j.user_id=c.user_id AND j.album_id=c.album_id WHERE c.user_id=? AND c.album_id=?"
  )
    .bind(userId, id)
    .first<{
      release_id: string;
      medium_position: number;
      active_job: string | null;
      pinned: number;
      review_hold: number;
      source_kind: string | null;
      state: string | null;
    }>();
  if (
    active?.pinned ||
    active?.review_hold ||
    (active?.state === 'accepted' && active.source_kind === 'retail')
  )
    throw new ArtworkError('active_artwork_preserved', 409);
  const source = await selectAutomaticSource(
    c.env,
    id,
    userId,
    album,
    active?.release_id ?? '',
    active?.medium_position ?? 1,
    true,
    active?.source_kind === 'cover'
  );
  if (active?.state === 'accepted' && source.sourceKind === 'cover')
    return c.json({ reused: true, album_id: id, source_kind: 'cover' });
  if (c.req.query('apply') !== 'true')
    return c.json({
      validated: true,
      album_id: id,
      source_kind: source.sourceKind,
      identity_type: source.identityType,
      release_id: source.request.release_id,
      medium_position: source.request.medium_position,
    });
  const result = await enqueue(c.env, source.request, userId, false, {
    source,
    expectedActiveJob: active?.active_job ?? null,
    catalogIdentity: album,
  });
  await dispatch(c.env, result.job);
  return c.json(
    { ...publicJob(result.job), reused: result.reused },
    result.reused ? 200 : 202
  );
});
app.get(`${admin}/jobs`, async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM cd_artwork_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 25'
  )
    .bind(c.get('userId'))
    .all<Job>();
  return c.json({ data: rows.results.map(publicJob) });
});
app.get(`${admin}/jobs/:id`, async (c) => {
  const id = assetId.parse(c.req.param('id'));
  const job = await getJob(c.env, id, c.get('userId'));
  if (!job) return c.json({ error: 'job_not_found', status: 404 }, 404);
  return c.json(publicJob(job), { headers: { 'Cache-Control': 'no-store' } });
});
app.get(`${admin}/jobs/:id/candidate`, async (c) => {
  const job = await getJob(
    c.env,
    assetId.parse(c.req.param('id')),
    c.get('userId')
  );
  if (!job?.candidate_key) return c.notFound();
  const object = await c.env.ARTWORK.get(job.candidate_key);
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
app.post(`${admin}/jobs/:id/review`, async (c) => {
  const body = z
    .object({
      decision: z.enum(['accepted', 'rejected']),
      activate: z.boolean().default(false),
      reviewer: z.string().min(1).max(80),
    })
    .strict()
    .parse(await jsonBody(c.req.raw));
  const job = await reviewJob(
    c.env,
    assetId.parse(c.req.param('id')),
    c.get('userId'),
    body.decision,
    body.activate,
    body.reviewer
  );
  if (body.decision === 'accepted' && job.candidate_hash)
    await dispatchWebpVariant(c.env, job.candidate_hash, job.user_id);
  return c.json(publicJob(job));
});
app.get(`${admin}/jobs/:id/raw`, async (c) => {
  const job = await getJob(
    c.env,
    assetId.parse(c.req.param('id')),
    c.get('userId')
  );
  if (!job) return c.notFound();
  const object = await c.env.ARTWORK.get(
    job.raw_key ?? `jobs/${job.user_id}/${job.id}/raw.png`
  );
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
app.post(`${admin}/jobs/:id/raw`, async (c) => {
  const id = assetId.parse(c.req.param('id')),
    userId = c.get('userId'),
    job = await getJob(c.env, id, userId);
  if (!job) return c.notFound();
  if (
    !['submitted', 'provider_unknown', 'needs_registration'].includes(
      job.state
    ) ||
    job.candidate_hash
  )
    throw new ArtworkError('recovery_state_conflict', 409);
  const bytes = await boundedBytes(
    new Response(c.req.raw.body),
    12 * 1024 * 1024
  );
  if (bytes.length < 24 || bytes[0] !== 137 || bytes[1] !== 80)
    throw new ArtworkError('raw_png_required', 400);
  const key = `jobs/${userId}/${id}/raw.png`,
    existing = await c.env.ARTWORK.get(key);
  if (
    existing &&
    (await sha256(new Uint8Array(await existing.arrayBuffer()))) !==
      (await sha256(bytes))
  )
    throw new ArtworkError('immutable_raw_conflict', 409);
  await c.env.ARTWORK.put(key, bytes, {
    httpMetadata: { contentType: 'image/png' },
    onlyIf: { etagDoesNotMatch: '*' },
  });
  const provenance = JSON.parse(job.provenance);
  provenance.recoveryMethod = 'admin-uploaded-provider-output';
  provenance.rawHash = await sha256(bytes);
  await c.env.DB.prepare(
    'UPDATE cd_artwork_jobs SET raw_key=?,provenance=?,updated_at=? WHERE id=? AND user_id=? AND candidate_hash IS NULL'
  )
    .bind(key, JSON.stringify(provenance), now(), id, userId)
    .run();
  return c.json(await processRaw(c.env, id, userId));
});
app.post(`${admin}/jobs/:id/recover`, async (c) => {
  const id = assetId.parse(c.req.param('id'));
  const job = await getJob(c.env, id, c.get('userId'));
  if (!job) return c.notFound();
  if (
    ![
      'submitted',
      'provider_unknown',
      'needs_registration',
      'needs_material_review',
    ].includes(job.state)
  )
    throw new ArtworkError('recovery_state_conflict', 409);
  const result = await processRaw(c.env, id, c.get('userId'));
  return c.json(result);
});
app.post(`${admin}/jobs/:id/material`, async (c) => {
  const id = assetId.parse(c.req.param('id')),
    material = materialSchema.parse(await jsonBody(c.req.raw)),
    job = await getJob(c.env, id, c.get('userId'));
  if (!job) return c.notFound();
  if (!['needs_material_review', 'needs_registration'].includes(job.state))
    throw new ArtworkError('material_state_conflict', 409);
  const input = JSON.parse(job.input) as JobInput;
  if (input.source_kind !== 'retail')
    throw new ArtworkError('retail_material_required', 409);
  const revision = await materialRevision(c.env, job, material);
  if (revision.raw_key)
    return c.json({
      ...(await processRaw(c.env, revision.id, c.get('userId'))),
      id: revision.id,
    });
  await dispatch(c.env, revision);
  return c.json({ ...publicJob(revision), replaces: job.id }, 202);
});
app.post(`${admin}/import-reviewed`, async (c) => {
  const multipart = await boundedBytes(
    new Response(c.req.raw.body),
    48 * 1024 * 1024
  );
  const form = await new Response(new Uint8Array(multipart), {
    headers: { 'Content-Type': c.req.header('Content-Type') ?? '' },
  }).formData();
  if (typeof form.get('input') !== 'string')
    throw new ArtworkError('invalid_import', 400);
  const input = reviewedMasterSchema.parse(
    JSON.parse(form.get('input') as string)
  );
  const files: Partial<MasterFiles> = {};
  for (const name of [
    'source',
    'candidate',
    'raw',
    'patch',
    'template',
    'master',
  ] as const) {
    const file = form.get(name);
    if (file !== null) {
      if (!(file instanceof File) || file.size > 12 * 1024 * 1024)
        throw new ArtworkError('invalid_import', 400);
      files[name] = new Uint8Array(await file.arrayBuffer());
    }
  }
  if (!files.source || !files.candidate)
    throw new ArtworkError('invalid_import', 400);
  const prepared = await prepareReviewedMaster(
    c.env,
    input,
    files as MasterFiles,
    c.get('userId')
  );
  if (c.req.query('apply') !== 'true')
    return c.json({
      validated: true,
      id: prepared.id,
      candidate_hash: input.candidate_sha256,
      reused: !!prepared.existing,
      existing_state: prepared.existing?.state ?? null,
      active_candidate_hash: prepared.active?.candidate_hash ?? null,
      activation_allowed: !prepared.active?.pinned,
    });
  const result = await persistReviewedMaster(
    c.env,
    input,
    files as MasterFiles,
    c.get('userId'),
    prepared
  );
  return c.json(
    { ...publicJob(result.job), reused: result.reused },
    result.reused ? 200 : 202
  );
});
app.post(`${admin}/import`, async (c) => {
  const multipart = await boundedBytes(
    new Response(c.req.raw.body),
    16 * 1024 * 1024
  );
  const form = await new Response(new Uint8Array(multipart), {
    headers: { 'Content-Type': c.req.header('Content-Type') ?? '' },
  }).formData();
  const body = Object.fromEntries(form.entries());
  if (
    !(body.candidate instanceof File) ||
    typeof body.input !== 'string' ||
    body.candidate.size > 12 * 1024 * 1024
  )
    throw new ArtworkError('invalid_import', 400);
  const input = inputSchema.parse(JSON.parse(body.input)),
    result = await enqueue(c.env, input, c.get('userId'), true);
  const job = await importCandidate(
    c.env,
    result.job,
    new Uint8Array(await body.candidate.arrayBuffer()),
    { reviewedMaster: true }
  );
  if (!job) throw new ArtworkError('import_failed', 503);
  return c.json(publicJob(job), 202);
});
app.use(`${admin}/control`, async (c, next) =>
  c.get('userId') === 1
    ? next()
    : c.json({ error: 'Forbidden', status: 403 }, 403)
);
app.use(`${admin}/recheck`, async (c, next) =>
  c.get('userId') === 1
    ? next()
    : c.json({ error: 'Forbidden', status: 403 }, 403)
);
app.get(`${admin}/control`, async (c) =>
  c.json(
    await c.env.DB.prepare(
      'SELECT enabled,automatic_enabled,NULL AS daily_limit,budget_day,submitted_count FROM cd_artwork_control WHERE id=1'
    ).first()
  )
);
app.post(`${admin}/control`, async (c) => {
  const body = z
    .object({
      enabled: z.boolean(),
      automatic_enabled: z.boolean().optional(),
    })
    .strict()
    .parse(await jsonBody(c.req.raw));
  await c.env.DB.prepare(
    'UPDATE cd_artwork_control SET enabled=?,automatic_enabled=COALESCE(?,automatic_enabled) WHERE id=1'
  )
    .bind(
      Number(body.enabled),
      body.automatic_enabled === undefined
        ? null
        : Number(body.automatic_enabled)
    )
    .run();
  return c.json(body);
});
app.post(`${admin}/recheck`, async (c) => {
  await scheduledArtwork(c.env);
  return c.json({ completed: true });
});

// Reachable only through an explicitly bound internal service capability.
export class ArtworkDiscoveryService extends WorkerEntrypoint<ArtworkEnv> {
  async dispatchPending() {
    await dispatchListeningChecks(this.env);
  }
}
export class CdDiscoveryWorkflow extends WorkflowEntrypoint<
  ArtworkEnv,
  { checkId: number }
> {
  async run(event: WorkflowEvent<{ checkId: number }>, step: WorkflowStep) {
    const { checkId } = event.payload;
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await step.do(
        `discover-${attempt}`,
        {
          retries: { limit: 2, delay: '10 seconds' },
          timeout: '2 minutes',
        },
        () => checkListeningArtwork(this.env, checkId)
      );
      if (!result.retryAfter) return result;
      if (attempt < 3)
        await step.sleep(
          `provider-backoff-${attempt}`,
          (result.outcome === 'catalog_changed' || result.capacityRetry
            ? result.retryAfter
            : Math.max(3600 * 2 ** attempt, result.retryAfter)) * 1000
        );
    }
    await step.do('finish-exhausted-check', async () => {
      const row = await this.env.DB.prepare(
        'SELECT id,user_id,album_id FROM cd_artwork_checks WHERE id=?'
      )
        .bind(checkId)
        .first<DiscoveryCheck>();
      if (row) await finishCheck(this.env, row, 'error');
    });
    return { outcome: 'error' };
  }
}
export class CdArtworkWorkflow extends WorkflowEntrypoint<
  ArtworkEnv,
  { jobId: string; userId: number; variantOnly?: true }
> {
  async run(
    event: WorkflowEvent<{
      jobId: string;
      userId: number;
      variantOnly?: true;
    }>,
    step: WorkflowStep
  ) {
    const { jobId, userId } = event.payload;
    if (event.payload.variantOnly) {
      return step.do(
        'prepare-accepted-lossless-webp-v1',
        { retries: { limit: 1, delay: '10 seconds' }, timeout: '2 minutes' },
        () => prepareAcceptedWebpVariant(this.env, jobId, userId)
      );
    }
    const result = await step.do(
      'submit-once-and-persist-raw',
      { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' },
      () => generateOnce(this.env, jobId, userId)
    );
    if (!result.rawKey) return { state: 'held_or_unavailable' };
    const registered = await step.do(
      'register-material-and-persist-candidate',
      { retries: { limit: 2, delay: '10 seconds' }, timeout: '4 minutes' },
      () => processRaw(this.env, jobId, userId)
    );
    const job = await getJob(this.env, jobId, userId);
    if (job?.automatic && !registered.candidateHash) {
      await step.do(
        'admit-automatic-render-recovery',
        { retries: { limit: 2, delay: '10 seconds' }, timeout: '1 minute' },
        async () => {
          await queueRenderRetry(this.env, jobId, userId);
          await dispatchListeningChecks(this.env);
        }
      );
    }
    if (job?.automatic && registered.candidateHash) {
      const published = await step.do(
        'publish-verified-candidate',
        { retries: { limit: 2, delay: '10 seconds' }, timeout: '1 minute' },
        () => publishAutomatic(this.env, jobId, userId)
      );
      if (published.candidateHash) {
        try {
          await step.do(
            'prepare-accepted-lossless-webp-v1',
            {
              retries: { limit: 1, delay: '10 seconds' },
              timeout: '2 minutes',
            },
            () =>
              prepareAcceptedWebpVariant(
                this.env,
                published.candidateHash!,
                userId
              )
          );
        } catch {
          console.log('[ERROR] CD artwork optional WebP preparation failed');
        }
      }
      return published;
    }
    return registered;
  }
}
export { app as artworkApp };
export default {
  fetch: app.fetch,
  scheduled: (
    _event: ScheduledEvent,
    env: ArtworkEnv,
    ctx: ExecutionContext
  ) => {
    ctx.waitUntil(
      scheduledArtwork(env).catch(() =>
        console.log('[ERROR] CD artwork scheduled work failed')
      )
    );
  },
};
