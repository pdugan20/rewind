import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types/env.js';
import type { ArtworkEnv } from './types.js';
import { galleryAuth } from './gallery-auth.js';
import {
  feedbackSchema,
  saveFeedback,
  hideArtwork,
  galleryList,
  galleryQuerySchema,
  feedbackHistory,
} from './feedback.js';
import { getJob } from './store.js';
import { reviewJob } from './review.js';
import { dispatchWebpVariant } from './webp-storage.js';
import { ArtworkError, boundedBytes } from './sources.js';
import page from './gallery/page.html';
import stylesheet from './gallery/style.css';
import script from './gallery/gallery.client.js' with { type: 'text' };

type App = Hono<{ Bindings: Env & ArtworkEnv }>;
const idSchema = z.string().regex(/^[a-f0-9]{64}$/);
async function body(request: Request) {
  return JSON.parse(
    new TextDecoder().decode(
      await boundedBytes(new Response(request.body), 16 * 1024)
    )
  ) as unknown;
}
/** Shared API contract: Bearer-admin clients and authenticated private UI. */
export function registerGalleryData(app: App, base: string) {
  app.get(base, async (c) =>
    c.json(
      {
        ...(await galleryList(
          c.env,
          c.get('userId'),
          galleryQuerySchema.parse(c.req.query())
        )),
        capabilities: { hide_from_player: c.get('galleryHideReady') !== false },
      },
      { headers: { 'Cache-Control': 'private, no-store' } }
    )
  );
  app.get(`${base}/:id/history`, async (c) =>
    c.json(
      await feedbackHistory(
        c.env,
        idSchema.parse(c.req.param('id')),
        c.get('userId')
      ),
      { headers: { 'Cache-Control': 'private, no-store' } }
    )
  );
  app.get(`${base}/:id/image/:kind`, async (c) => {
    const job = await getJob(
      c.env,
      idSchema.parse(c.req.param('id')),
      c.get('userId')
    );
    if (!job) throw new ArtworkError('job_not_found', 404);
    const kind = z
      .enum(['source', 'candidate', 'raw'])
      .parse(c.req.param('kind'));
    const key =
      kind === 'source'
        ? job.source_key
        : kind === 'candidate'
          ? job.candidate_key
          : job.raw_key;
    if (!key) return c.notFound();
    const object = await c.env.ARTWORK.get(key);
    if (!object) return c.notFound();
    return new Response(object.body, {
      headers: {
        'Content-Type': kind === 'source' ? job.source_mime : 'image/png',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  });
  app.post(`${base}/:id/feedback`, async (c) => {
    await saveFeedback(
      c.env,
      idSchema.parse(c.req.param('id')),
      c.get('userId'),
      feedbackSchema.parse(await body(c.req.raw)),
      'gallery-owner'
    );
    return c.json({ saved: true });
  });
  app.post(`${base}/:id/hide`, async (c) => {
    if (c.get('galleryHideReady') === false)
      throw new ArtworkError('withdrawal_consumer_not_ready', 409);
    z.object({})
      .strict()
      .parse(await body(c.req.raw));
    await hideArtwork(
      c.env,
      idSchema.parse(c.req.param('id')),
      c.get('userId'),
      'gallery-owner'
    );
    return c.json({ hidden: true });
  });
  app.post(`${base}/:id/activate`, async (c) => {
    const request = z
      .object({ expected_active_job: idSchema.nullable().optional() })
      .strict()
      .parse(await body(c.req.raw));
    const job = await reviewJob(
      c.env,
      idSchema.parse(c.req.param('id')),
      c.get('userId'),
      'accepted',
      true,
      'gallery-owner',
      request.expected_active_job
    );
    if (job.candidate_hash)
      await dispatchWebpVariant(c.env, job.candidate_hash, job.user_id);
    return c.json({ activated: true });
  });
}

export const galleryApp: App = new Hono<{ Bindings: Env & ArtworkEnv }>();
galleryApp.use('*', galleryAuth);
galleryApp.use('*', async (c, next) => {
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  await next();
});
galleryApp.get('/', (c) => c.html(page));
galleryApp.get('/style.css', (c) =>
  c.body(stylesheet, 200, { 'Content-Type': 'text/css; charset=utf-8' })
);
galleryApp.get('/gallery.js', (c) =>
  c.body(script, 200, { 'Content-Type': 'text/javascript; charset=utf-8' })
);
registerGalleryData(galleryApp, '/data');
