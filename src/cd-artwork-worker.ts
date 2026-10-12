import { Hono } from 'hono';
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
} from './services/cd-artwork/sources.js';
import {
  enqueue,
  dispatch,
  getJob,
  ownedAlbum,
  publicJob,
  approvedArtwork,
  materialRevision,
} from './services/cd-artwork/store.js';
import { generateOnce, processRaw } from './services/cd-artwork/generation.js';
import { reviewJob, importCandidate } from './services/cd-artwork/review.js';
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
    release_id: z.uuid(),
    medium_position: z.number().int().min(1).max(10),
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
  .strict();
const app = new Hono<{ Bindings: Env & ArtworkEnv }>();
app.notFound((c) => c.json({ error: 'Not found', status: 404 }, 404));
const read = '/v1/listening/cd-artwork',
  admin = '/v1/admin/cd-artwork';
app.use('*', async (c, next) => cors(c.env)(c, next));
app.use(`${admin}/*`, requireAuth('admin'));
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
app.get(`${read}/albums`, async (c) => {
  const ids = z
    .array(z.coerce.number().int().positive())
    .max(20)
    .parse((c.req.query('ids') ?? '').split(',').filter(Boolean));
  return c.json(
    { data: await approvedArtwork(c.env, ids, c.get('userId')) },
    { headers: { 'Cache-Control': 'private, max-age=60' } }
  );
});
app.get(`${read}/albums/:id`, async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  await ownedAlbum(c.env, id, c.get('userId'));
  const data = await approvedArtwork(c.env, [id], c.get('userId'));
  return c.json(
    { album_id: id, artwork: data[0] ?? null },
    { headers: { 'Cache-Control': 'private, max-age=60' } }
  );
});
app.get(`${read}/assets/:file`, async (c) => {
  const file = c.req.param('file');
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
app.post(`${admin}/albums/:id/resolve`, async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const album = await ownedAlbum(c.env, id, c.get('userId'));
  return c.json(await resolveEditionCandidates(c.env, album));
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
  return c.json(publicJob(job));
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
      'SELECT enabled,daily_limit,budget_day,submitted_count FROM cd_artwork_control WHERE id=1'
    ).first()
  )
);
app.post(`${admin}/control`, async (c) => {
  const body = z
    .object({
      enabled: z.boolean(),
      daily_limit: z.number().int().min(0).max(10),
    })
    .strict()
    .parse(await jsonBody(c.req.raw));
  await c.env.DB.prepare(
    'UPDATE cd_artwork_control SET enabled=?,daily_limit=? WHERE id=1'
  )
    .bind(Number(body.enabled), body.daily_limit)
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
          Math.max(3600 * 2 ** attempt, result.retryAfter) * 1000
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
  { jobId: string; userId: number }
> {
  async run(
    event: WorkflowEvent<{ jobId: string; userId: number }>,
    step: WorkflowStep
  ) {
    const { jobId, userId } = event.payload;
    const result = await step.do(
      'submit-once-and-persist-raw',
      { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' },
      () => generateOnce(this.env, jobId, userId)
    );
    if (!result.rawKey) return { state: 'held_or_budget_limited' };
    return step.do(
      'register-material-and-persist-candidate',
      { retries: { limit: 2, delay: '10 seconds' }, timeout: '3 minutes' },
      () => processRaw(this.env, jobId, userId)
    );
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
