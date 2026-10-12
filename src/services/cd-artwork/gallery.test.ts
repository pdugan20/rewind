import {
  env,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { sign } from 'hono/jwt';
import { clearGalleryCertificateCache } from './gallery-auth.js';
import { artworkApp } from '../../cd-artwork-worker.js';
import type { ArtworkEnv } from './types.js';
import type { Env } from '../../types/env.js';
import { createTestApiKey } from '../../test-helpers.js';
import { clearAuthCache } from '../../lib/auth.js';
import { saveFeedback, feedbackSchema, hideArtwork } from './feedback.js';
import {
  approvedArtwork,
  artworkSnapshot,
  claimSubmission,
  getJob,
} from './store.js';
import { automaticEligible, publishAutomatic } from './automatic.js';
import { png } from '../../../scripts/cd-artwork/pixels.mjs';
import { prepareCandidate } from './registration.js';
import { now, sha256 } from './types.js';

const runtime = env as typeof env & Env & ArtworkEnv;
const admin = '/v1/admin/cd-artwork/reviews',
  gallery = '/v1/admin/cd-artwork/gallery';
const first = 'a'.repeat(64),
  second = 'b'.repeat(64),
  other = 'c'.repeat(64);
const issuer = 'https://synthetic-review.cloudflareaccess.com',
  audience = 'd'.repeat(64);
const access = JSON.stringify({
  issuer,
  audience,
  users: { 'owner@example.test': 1 },
});
let adminKey: string,
  readKey: string,
  otherKey: string,
  privateKey: JsonWebKey & { kid: string },
  publicKey: JsonWebKey & { kid: string };
let bytes: Uint8Array;
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, runtime.TEST_MIGRATIONS);
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  privateKey = {
    ...(await crypto.subtle.exportKey('jwk', pair.privateKey)),
    alg: 'RS256',
    kid: 'synthetic-key',
  };
  publicKey = {
    ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    alg: 'RS256',
    kid: 'synthetic-key',
  };
  const data = new Uint8Array(1024 * 1024 * 4).fill(255);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512);
      if (r >= 60 && r <= 480) data.set([70, 85, 90, 255], (y * 1024 + x) * 4);
    }
  bytes = prepareCandidate(png({ width: 1024, height: 1024, data }), {
    album_id: 1,
    source_kind: 'cover',
    release_id: null,
    medium_position: null,
  }).bytes;
});
beforeEach(async () => {
  vi.restoreAllMocks();
  clearAuthCache();
  clearGalleryCertificateCache();
  await runtime.DB.exec(
    'DELETE FROM cd_artwork_checks; DELETE FROM cd_artwork_events; DELETE FROM cd_artwork_albums; DELETE FROM cd_artwork_jobs; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists; DELETE FROM api_keys;'
  );
  await runtime.DB.exec(
    "INSERT INTO lastfm_artists(id,user_id,name,created_at,updated_at) VALUES(1,1,'Test artist','2026-01-01','2026-01-01'),(2,2,'Other artist','2026-01-01','2026-01-01'); INSERT INTO lastfm_albums(id,user_id,artist_id,name,created_at,updated_at) VALUES(1,1,1,'Test album','2026-01-01','2026-01-01'),(2,2,2,'Other album','2026-01-01','2026-01-01'); UPDATE cd_artwork_control SET enabled=1,automatic_enabled=1,daily_limit=3,submitted_count=0,budget_day='' WHERE id=1;"
  );
  adminKey = await createTestApiKey({
    scope: 'admin',
    token: 'rw_gallery_admin',
  });
  readKey = await createTestApiKey({ scope: 'read', token: 'rw_gallery_read' });
  otherKey = await createTestApiKey({
    scope: 'admin',
    userId: 2,
    token: 'rw_gallery_other',
  });
  await seed(first, 1, 'accepted');
  await seed(second, 1, 'pending');
  await seed(other, 2, 'accepted');
  await runtime.DB.prepare(
    'UPDATE cd_artwork_albums SET active_job=? WHERE user_id=1'
  )
    .bind(first)
    .run();
});
async function seed(id: string, user: number, state: string) {
  const hash = await sha256(bytes),
    source = `test-gallery/${user}/${id}/source`,
    candidate = `test-gallery/${user}/${id}/candidate`;
  await runtime.ARTWORK.put(source, bytes);
  await runtime.ARTWORK.put(candidate, bytes);
  await runtime.DB.prepare(
    'INSERT INTO cd_artwork_jobs(id,user_id,album_id,state,input,source_hash,source_key,source_mime,raw_key,candidate_key,candidate_hash,provenance,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  )
    .bind(
      id,
      user,
      user,
      state,
      JSON.stringify({
        album_id: user,
        release_id: null,
        medium_position: null,
        source_kind: 'cover',
      }),
      hash,
      source,
      'image/png',
      source,
      candidate,
      hash,
      JSON.stringify({
        sourceUrl: 'https://private-source.invalid/token-must-not-leak',
        prompt: 'private prompt',
      }),
      now(),
      '2026-01-01T00:00:00Z'
    )
    .run();
  await runtime.DB.prepare(
    "INSERT OR IGNORE INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check) VALUES(?,?,'',1,'2099-01-01')"
  )
    .bind(user, user)
    .run();
}
async function request(
  path: string,
  options: {
    key?: string;
    token?: string;
    config?: string;
    data?: unknown;
    headers?: Record<string, string>;
  } = {}
) {
  const ctx = createExecutionContext();
  const response = await artworkApp.request(
    'https://api.rewind.rest' + path,
    {
      method: options.data === undefined ? 'GET' : 'POST',
      headers: {
        ...(options.key ? { Authorization: `Bearer ${options.key}` } : {}),
        ...(options.token ? { 'Cf-Access-Jwt-Assertion': options.token } : {}),
        ...(options.data === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      ...(options.data === undefined
        ? {}
        : { body: JSON.stringify(options.data) }),
    },
    { ...runtime, CD_GALLERY_ACCESS: options.config },
    ctx
  );
  const body = await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return new Response(body, {
    status: response.status,
    headers: response.headers,
  });
}
async function jwt(overrides: Record<string, unknown> = {}) {
  return sign(
    {
      iss: issuer,
      aud: [audience],
      email: 'owner@example.test',
      type: 'app',
      exp: Math.floor(Date.now() / 1000) + 300,
      ...overrides,
    },
    privateKey as Parameters<typeof sign>[1],
    'RS256'
  );
}
function keys() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({ keys: [publicKey] })
  );
}

it('requires admin API authorization and scopes every gallery/image/action to the owner', async () => {
  expect((await request(admin)).status).toBe(401);
  expect((await request(admin, { key: readKey })).status).toBe(403);
  const list = await request(admin, { key: adminKey });
  expect(list.headers.get('cache-control')).toBe('private, no-store');
  const text = await list.text();
  expect(text).not.toContain('private-source');
  expect(text).not.toContain('private prompt');
  expect(text).not.toContain(other);
  for (const suffix of [
    'history',
    'image/source',
    'image/candidate',
    'image/raw',
  ])
    expect(
      (await request(`${admin}/${first}/${suffix}`, { key: otherKey })).status
    ).toBe(404);
  for (const [action, data] of [
    ['feedback', { status: 'needs_revision' }],
    ['hide', {}],
    ['activate', {}],
  ] as const)
    expect(
      (await request(`${admin}/${first}/${action}`, { key: otherKey, data }))
        .status
    ).toBe(404);
});
it('paginates deterministically and filters active, held and flagged artwork', async () => {
  const one = (await (
    await request(admin + '?limit=1', { key: adminKey })
  ).json()) as {
    data: { id: string }[];
    pagination: { total: number; total_pages: number };
  };
  const two = (await (
    await request(admin + '?limit=1&page=2', { key: adminKey })
  ).json()) as typeof one;
  expect(one.data[0].id).toBe(second);
  expect(two.data[0].id).toBe(first);
  expect(one.pagination).toMatchObject({ total: 2, total_pages: 2 });
  const active = (await (
    await request(admin + '?filter=published', { key: adminKey })
  ).json()) as typeof one;
  expect(active.data.map((v) => v.id)).toEqual([first]);
  expect(
    (await request(admin + '?limit=100000', { key: adminKey })).status
  ).toBe(400);
});
it('records bounded feedback privately, preserves accepted art, and holds paid submission and publication', async () => {
  const bad = feedbackSchema.parse({
    status: 'needs_revision',
    reason: 'lettering',
    note: '<script>Private review</script>',
  });
  await saveFeedback(runtime, first, 1, bad, 'test-owner');
  expect((await getJob(runtime, first, 1))?.state).toBe('accepted');
  expect((await approvedArtwork(runtime, [1], 1))[0].asset_id).toBe(first);
  await runtime.DB.prepare(
    "UPDATE cd_artwork_jobs SET automatic=1,expected_active_job=?,state='queued',candidate_key=NULL,candidate_hash=NULL,provenance=? WHERE id=?"
  )
    .bind(
      first,
      JSON.stringify({
        catalogIdentity: {
          name: 'Test album',
          mbid: null,
          identity_conflict: 0,
          apple_music_id: null,
          artist: 'Test artist',
          artist_mbid: null,
          artist_identity_conflict: 0,
        },
      }),
      second
    )
    .run();
  const job = (await getJob(runtime, second, 1))!;
  expect(await automaticEligible(runtime, job)).toBe(false);
  expect(await claimSubmission(runtime, job)).toBe(false);
  expect(await publishAutomatic(runtime, second, 1)).toEqual({ state: 'held' });
  const history = await (
    await request(`${admin}/${first}/history`, { key: adminKey })
  ).json();
  expect(history).toMatchObject({ data: [{ feedback: bad }] });
  expect(
    (
      await request(`${admin}/${first}/feedback`, {
        key: adminKey,
        data: { status: 'needs_revision', note: 'x'.repeat(1001) },
      })
    ).status
  ).toBe(400);
  await saveFeedback(
    runtime,
    first,
    1,
    feedbackSchema.parse({ status: 'good' }),
    'test-owner'
  );
  expect(await claimSubmission(runtime, job)).toBe(true);
});
it('clears a hold only after all unresolved flags are cleared', async () => {
  for (const id of [first, second])
    await saveFeedback(
      runtime,
      id,
      1,
      feedbackSchema.parse({ status: 'needs_revision' }),
      'test-owner'
    );
  await saveFeedback(
    runtime,
    first,
    1,
    feedbackSchema.parse({ status: 'good' }),
    'test-owner'
  );
  expect(
    await runtime.DB.prepare(
      'SELECT review_hold FROM cd_artwork_albums WHERE user_id=1'
    ).first()
  ).toEqual({ review_hold: 1 });
  await saveFeedback(
    runtime,
    second,
    1,
    feedbackSchema.parse({ status: 'good' }),
    'test-owner'
  );
  expect(
    await runtime.DB.prepare(
      'SELECT review_hold FROM cd_artwork_albums WHERE user_id=1'
    ).first()
  ).toEqual({ review_hold: 0 });
});
it('admits a new play only after the album review hold is cleared', async () => {
  await runtime.DB.exec(
    "INSERT INTO lastfm_tracks(id,user_id,artist_id,album_id,name,created_at,updated_at) VALUES(1,1,1,1,'Test track','2026-01-01','2026-01-01'); UPDATE cd_artwork_control SET enroll_since='2000-01-01' WHERE id=1;"
  );
  await saveFeedback(
    runtime,
    first,
    1,
    feedbackSchema.parse({ status: 'needs_revision' }),
    'test'
  );
  await runtime.DB.prepare(
    'INSERT INTO lastfm_scrobbles(user_id,track_id,scrobbled_at,created_at) VALUES(1,1,?,?)'
  )
    .bind(now(), now())
    .run();
  expect(
    (
      await runtime.DB.prepare(
        'SELECT id FROM cd_artwork_checks WHERE user_id=1'
      ).all()
    ).results
  ).toHaveLength(0);
  await saveFeedback(
    runtime,
    first,
    1,
    feedbackSchema.parse({ status: 'good' }),
    'test'
  );
  await runtime.DB.prepare(
    'INSERT INTO lastfm_scrobbles(user_id,track_id,scrobbled_at,created_at) VALUES(1,1,?,?)'
  )
    .bind(new Date(Date.now() + 1000).toISOString(), now())
    .run();
  expect(
    (
      await runtime.DB.prepare(
        'SELECT id FROM cd_artwork_checks WHERE user_id=1'
      ).all()
    ).results
  ).toHaveLength(1);
});
it('returns persistent owned withdrawal revisions and never leaks review notes into read responses', async () => {
  const before = await artworkSnapshot(runtime, [1, 2], 1);
  expect(before.data).toHaveLength(1);
  const acceptedRevision = before.data[0].revision;
  await saveFeedback(
    runtime,
    first,
    1,
    feedbackSchema.parse({ status: 'needs_revision', note: 'private note' }),
    'test'
  );
  expect((await artworkSnapshot(runtime, [1], 1)).data[0].revision).toBe(
    acceptedRevision
  );
  await hideArtwork(runtime, first, 1, 'test');
  const hidden = await artworkSnapshot(runtime, [1, 2], 1);
  expect(hidden.data).toEqual([]);
  expect(hidden.withdrawals).toHaveLength(1);
  expect(hidden.withdrawals[0].revision).toBeGreaterThan(acceptedRevision);
  expect(await artworkSnapshot(runtime, [1], 2)).toEqual({
    data: [],
    withdrawals: [],
  });
  const read = await request('/v1/listening/cd-artwork/albums?ids=1', {
    key: readKey,
  });
  const text = await read.text();
  expect(text).not.toContain('private note');
  expect(JSON.parse(text)).toEqual(hidden);
  await request(`${admin}/${second}/activate`, { key: adminKey, data: {} });
  const restored = await artworkSnapshot(runtime, [1], 1);
  expect(restored.withdrawals).toEqual([]);
  expect(restored.data[0].revision).toBeGreaterThan(
    hidden.withdrawals[0].revision
  );
});
it('hides only the selected active version, prevents silent restoration, and approves an immutable replacement', async () => {
  await saveFeedback(
    runtime,
    first,
    1,
    feedbackSchema.parse({ status: 'needs_revision', note: 'Fix lettering' }),
    'test-owner'
  );
  expect(
    (await request(`${admin}/${second}/hide`, { key: adminKey, data: {} }))
      .status
  ).toBe(409);
  await hideArtwork(runtime, first, 1, 'test-owner');
  expect(await approvedArtwork(runtime, [1], 1)).toEqual([]);
  await saveFeedback(
    runtime,
    first,
    1,
    feedbackSchema.parse({ status: 'good' }),
    'test-owner'
  );
  expect(
    await runtime.DB.prepare(
      'SELECT review_hold,hidden_job FROM cd_artwork_albums WHERE user_id=1'
    ).first()
  ).toEqual({ review_hold: 1, hidden_job: first });
  await saveFeedback(
    runtime,
    first,
    1,
    feedbackSchema.parse({ status: 'needs_revision', note: 'Fix lettering' }),
    'test-owner'
  );
  expect(
    (await request(`${admin}/${second}/activate`, { key: adminKey, data: {} }))
      .status
  ).toBe(200);
  expect((await approvedArtwork(runtime, [1], 1))[0].asset_id).toBe(second);
  expect(
    await runtime.DB.prepare(
      'SELECT feedback_status,feedback_note FROM cd_artwork_jobs WHERE id=?'
    )
      .bind(first)
      .first()
  ).toEqual({ feedback_status: 'resolved', feedback_note: 'Fix lettering' });
  expect(
    await runtime.DB.prepare(
      'SELECT review_hold,hidden_job FROM cd_artwork_albums WHERE user_id=1'
    ).first()
  ).toEqual({ review_hold: 0, hidden_job: null });
});
it('fails closed without Access configuration and rejects API keys or spoofed email headers on the browser surface', async () => {
  expect((await request(gallery, { key: adminKey })).status).toBe(503);
  for (const suffix of [
    '',
    '/style.css',
    '/gallery.js',
    '/data',
    `/data/${first}/image/source`,
  ])
    expect(
      (
        await request(gallery + suffix, {
          config: access,
          key: adminKey,
          headers: {
            'Cf-Access-Authenticated-User-Email': 'owner@example.test',
          },
        })
      ).status
    ).toBe(401);
});
it('preserves pins and rejects a stale activation card without publishing or resolving feedback', async () => {
  await saveFeedback(
    runtime,
    first,
    1,
    feedbackSchema.parse({ status: 'needs_revision' }),
    'test'
  );
  const stale = await request(`${admin}/${second}/activate`, {
    key: adminKey,
    data: { expected_active_job: null },
  });
  expect(stale.status).toBe(409);
  expect((await getJob(runtime, second, 1))?.state).toBe('pending');
  await runtime.DB.prepare(
    'UPDATE cd_artwork_albums SET pinned=1 WHERE user_id=1'
  ).run();
  expect(
    (await request(`${admin}/${first}/hide`, { key: adminKey, data: {} }))
      .status
  ).toBe(409);
  expect((await approvedArtwork(runtime, [1], 1))[0].asset_id).toBe(first);
  expect(
    await runtime.DB.prepare(
      'SELECT review_hold,hidden_job FROM cd_artwork_albums WHERE user_id=1'
    ).first()
  ).toEqual({ review_hold: 1, hidden_job: null });
});
it('validates Access signature, issuer, audience, expiry and owner identity, including direct Worker URLs', async () => {
  keys();
  const token = await jwt();
  const good = await request(gallery, { config: access, token });
  expect(good.status).toBe(200);
  expect(await good.text()).toContain('Artwork review');
  expect(good.headers.get('content-security-policy')).toContain(
    "frame-ancestors 'none'"
  );
  for (const overrides of [
    { aud: ['wrong'] },
    { iss: 'https://wrong.cloudflareaccess.com' },
    { exp: 0 },
    { exp: undefined },
    { type: 'service' },
  ])
    expect(
      (
        await request(gallery + '/data', {
          config: access,
          token: await jwt(overrides),
        })
      ).status
    ).toBe(401);
  expect(
    (
      await request(gallery + '/data', {
        config: access,
        token: await jwt({ email: 'another@example.test' }),
      })
    ).status
  ).toBe(403);
  expect(
    (
      await request(gallery + '/data', {
        config: access,
        token: token.slice(0, -5) + 'aaaaa',
      })
    ).status
  ).toBe(401);
});
it('requires exact same-origin JSON mutations with a custom CSRF header', async () => {
  keys();
  const token = await jwt();
  expect(
    (
      await request(gallery + '/data', {
        config: access,
        token,
        headers: { Origin: 'https://docs.rewind.rest' },
      })
    ).status
  ).toBe(403);
  const path = `${gallery}/data/${first}/feedback`,
    data = { status: 'good' };
  const headerCases: Record<string, string>[] = [
    {},
    { Origin: 'https://other.example', 'X-Artwork-Review': '1' },
    { Origin: 'https://api.rewind.rest' },
  ];
  for (const headers of headerCases)
    expect(
      (await request(path, { config: access, token, data, headers })).status
    ).toBe(403);
  expect(
    (
      await request(path, {
        config: access,
        token,
        data,
        headers: { Origin: 'https://api.rewind.rest', 'X-Artwork-Review': '1' },
      })
    ).status
  ).toBe(200);
});
