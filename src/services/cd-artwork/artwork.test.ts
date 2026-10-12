import {
  env,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  png,
  readPixels,
  checkGeometry,
} from '../../../scripts/cd-artwork/pixels.mjs';
import { artworkApp } from '../../cd-artwork-worker.js';
import { createTestApiKey } from '../../test-helpers.js';
import type { ArtworkEnv, Job, JobInput } from './types.js';
import { MODEL, now, sha256 } from './types.js';
import {
  claimSubmission,
  approvedArtwork,
  enqueue,
  materialRevision,
} from './store.js';
import { generateOnce, processRaw } from './generation.js';
import { prepareCandidate } from './registration.js';
import { reviewJob } from './review.js';
import { scheduledArtwork } from './scheduler.js';
import { clearAuthCache } from '../../lib/auth.js';

const runtime = env as typeof env &
  import('../../types/env.js').Env &
  ArtworkEnv;
const input: JobInput = {
  album_id: 1,
  release_id: 'e9b0f69e-ee3d-36ed-8c12-f8ee65f87e45',
  medium_position: 1,
  source_kind: 'cover',
};
function rawDisc() {
  const data = new Uint8Array(1024 * 1024 * 4).fill(255);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512),
        i = (y * 1024 + x) * 4;
      if (r >= 60 && r <= 480) data.set([70, 85, 90, 255], i);
    }
  return png({ width: 1024, height: 1024, data });
}
async function seed(
  id = 'a'.repeat(64),
  userId = 1,
  state = 'queued',
  albumId = 1
): Promise<Job> {
  const source = rawDisc(),
    sourceHash = await sha256(source),
    sourceKey = `test/${userId}/${id}/source.png`;
  await runtime.ARTWORK.put(sourceKey, source);
  const record = { ...input, album_id: albumId };
  await runtime.DB.prepare(
    'INSERT INTO cd_artwork_jobs(id,user_id,album_id,state,input,source_hash,source_key,source_mime,provenance,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
  )
    .bind(
      id,
      userId,
      albumId,
      state,
      JSON.stringify(record),
      sourceHash,
      sourceKey,
      'image/png',
      JSON.stringify({
        prompt: 'public test disc',
        settings: {
          model: MODEL,
          quality: 'high',
          size: '1024x1024',
          background: 'opaque',
          output_format: 'png',
          n: 1,
        },
      }),
      now(),
      now()
    )
    .run();
  await runtime.DB.prepare(
    'INSERT OR IGNORE INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check) VALUES(?,?,?,?,?)'
  )
    .bind(userId, albumId, input.release_id, 1, '2099-01-01T00:00:00Z')
    .run();
  return (await runtime.DB.prepare('SELECT * FROM cd_artwork_jobs WHERE id=?')
    .bind(id)
    .first<Job>())!;
}
async function candidate(id: string, userId = 1) {
  await seed(id, userId, 'submitted');
  await runtime.ARTWORK.put(`jobs/${userId}/${id}/raw.png`, rawDisc());
  const result = await processRaw(runtime, id, userId);
  expect(result.state).toBe('pending');
  return (await runtime.DB.prepare('SELECT * FROM cd_artwork_jobs WHERE id=?')
    .bind(id)
    .first<Job>())!;
}
let readKey: string, adminKey: string, otherKey: string;
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, runtime.TEST_MIGRATIONS);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  clearAuthCache();
  await runtime.DB.exec(
    'DELETE FROM cd_artwork_events; DELETE FROM cd_artwork_albums; DELETE FROM cd_artwork_jobs; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists; DELETE FROM api_keys;'
  );
  await runtime.DB.prepare(
    "UPDATE cd_artwork_control SET enabled=1,daily_limit=3,budget_day='',submitted_count=0,provider_next_ms=0,discovery_lease_until=NULL WHERE id=1"
  ).run();
  await runtime.DB.exec(
    "INSERT INTO lastfm_artists(id,user_id,name,created_at,updated_at) VALUES(1,1,'Synthetic artist','2026-01-01','2026-01-01'),(2,2,'Other test artist','2026-01-01','2026-01-01'); INSERT INTO lastfm_albums(id,user_id,artist_id,name,created_at,updated_at) VALUES(1,1,1,'Synthetic album','2026-01-01','2026-01-01'),(2,2,2,'Other album','2026-01-01','2026-01-01');"
  );
  readKey = await createTestApiKey({ scope: 'read', token: 'rw_cd_read' });
  adminKey = await createTestApiKey({ scope: 'admin', token: 'rw_cd_admin' });
  otherKey = await createTestApiKey({
    scope: 'admin',
    userId: 2,
    token: 'rw_cd_other',
  });
});
const request = async (route: string, key?: string, body?: unknown) => {
  const ctx = createExecutionContext();
  const response = await artworkApp.request(
    'https://api.rewind.rest' + route,
    {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(key ? { Authorization: 'Bearer ' + key } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    runtime,
    ctx
  );
  const bytes = await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return new Response(bytes, {
    status: response.status,
    headers: response.headers,
  });
};
const admin = '/v1/admin/cd-artwork',
  read = '/v1/listening/cd-artwork';

describe('CD registration and material contract', () => {
  it('normalizes physical geometry and preserves protected print during cover material processing', () => {
    const result = prepareCandidate(rawDisc(), input);
    expect(checkGeometry(readPixels(result.bytes)).pass).toBe(true);
    expect(result.verification.material.protectedChanges).toBe(0);
    expect(result.verification.material.partialHubPixels).toBeGreaterThan(1000);
  });
  it('gates uncertain retail material and rejects malformed geometry', () => {
    expect(() =>
      prepareCandidate(rawDisc(), { ...input, source_kind: 'retail' })
    ).toThrow('material_review_required');
    expect(() =>
      prepareCandidate(
        png({ width: 20, height: 20, data: new Uint8Array(1600) }),
        input
      )
    ).toThrow('output_dimensions_invalid');
  });
});
describe('durable jobs and paid request safety', () => {
  it('claims one paid submission under overlapping attempts', async () => {
    const job = await seed();
    const claims = await Promise.all([
      claimSubmission(runtime, job),
      claimSubmission(runtime, job),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      (
        await runtime.DB.prepare(
          'SELECT submitted_count FROM cd_artwork_control'
        ).first<{ submitted_count: number }>()
      )?.submitted_count
    ).toBe(1);
  });
  it('keeps disabled or budget-exhausted work queued without invoking a provider', async () => {
    const job = await seed();
    await runtime.DB.prepare(
      'UPDATE cd_artwork_control SET enabled=0 WHERE id=1'
    ).run();
    expect(await claimSubmission(runtime, job)).toBe(false);
    expect(
      (
        await runtime.DB.prepare('SELECT state FROM cd_artwork_jobs WHERE id=?')
          .bind(job.id)
          .first<{ state: string }>()
      )?.state
    ).toBe('queued');
  });
  it('does not resubmit an uncertain paid outcome', async () => {
    const job = await seed('c'.repeat(64), 1, 'submitted');
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const result = await generateOnce(
      { ...runtime, OPENAI_API_KEY: 'synthetic-not-a-credential' },
      job.id,
      1
    );
    expect(result.rawKey).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (
        await runtime.DB.prepare('SELECT state FROM cd_artwork_jobs WHERE id=?')
          .bind(job.id)
          .first<{ state: string }>()
      )?.state
    ).toBe('provider_unknown');
  });
  it('recovers raw evidence through registration without another paid request', async () => {
    const job = await seed('d'.repeat(64), 1, 'provider_unknown');
    await runtime.ARTWORK.put(`jobs/1/${job.id}/raw.png`, rawDisc());
    const fetcher = vi.spyOn(globalThis, 'fetch');
    expect((await generateOnce(runtime, job.id, 1)).rawKey).toBeTruthy();
    const first = await processRaw(runtime, job.id, 1),
      repeat = await processRaw(runtime, job.id, 1);
    expect(first.state).toBe('pending');
    expect(repeat.candidateHash).toBe(first.candidateHash);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe('authorization, publication and accepted-state preservation', () => {
  it('requires authentication and admin privileges', async () => {
    expect((await request(read + '/albums?ids=1')).status).toBe(401);
    expect((await request(admin + '/jobs', readKey, input)).status).toBe(403);
  });
  it('isolates jobs, album metadata, recovery and review by key user', async () => {
    const job = await seed();
    expect((await request(admin + '/jobs/' + job.id, otherKey)).status).toBe(
      404
    );
    expect(
      (await request(admin + '/jobs/' + job.id + '/recover', otherKey, {}))
        .status
    ).toBe(404);
    expect((await request(read + '/albums/1', otherKey)).status).toBe(404);
    expect(
      (
        await request(admin + '/jobs/' + job.id + '/review', otherKey, {
          decision: 'accepted',
          activate: true,
          reviewer: 'test',
        })
      ).status
    ).toBe(404);
  });
  it('does not publish a pending texture, and activates only an accepted valid candidate', async () => {
    const job = await candidate('e'.repeat(64));
    expect(
      (await request(read + '/assets/' + job.candidate_hash + '.png')).status
    ).toBe(404);
    expect(await approvedArtwork(runtime, [1], 1)).toEqual([]);
    await reviewJob(runtime, job.id, 1, 'accepted', true, 'synthetic-test');
    const attachment = await approvedArtwork(runtime, [1], 1);
    expect(attachment).toHaveLength(1);
    expect(attachment[0].sha256).toBe(job.candidate_hash);
    expect(
      (
        await request(read + '/assets/' + job.candidate_hash + '.png')
      ).headers.get('Content-Type')
    ).toBe('image/png');
    expect(await approvedArtwork(runtime, [1], 2)).toEqual([]);
  });
  it('pins and failures cannot replace accepted art or reject the active asset', async () => {
    const first = await candidate('f'.repeat(64));
    await reviewJob(runtime, first.id, 1, 'accepted', true, 'synthetic-test');
    await runtime.DB.prepare(
      'UPDATE cd_artwork_albums SET pinned=1 WHERE user_id=1 AND album_id=1'
    ).run();
    const second = await candidate('1'.repeat(64));
    await expect(
      reviewJob(runtime, second.id, 1, 'accepted', true, 'synthetic-test')
    ).rejects.toThrow('activation_not_allowed');
    await expect(
      reviewJob(runtime, first.id, 1, 'rejected', false, 'synthetic-test')
    ).rejects.toThrow('active_asset_requires_replacement');
    expect((await approvedArtwork(runtime, [1], 1))[0].asset_id).toBe(first.id);
  });
  it('an existing discovery lease prevents overlapping public lookup runs', async () => {
    await runtime.DB.prepare(
      'UPDATE cd_artwork_control SET discovery_lease_until=? WHERE id=1'
    )
      .bind('2099-01-01T00:00:00Z')
      .run();
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await scheduledArtwork(runtime);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('preflight, provider persistence and immutable revisions', () => {
  it('keeps known missing-source failure unsubmitted and uncharged', async () => {
    const job = await seed('2'.repeat(64));
    await runtime.ARTWORK.delete(job.source_key);
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(
      generateOnce({ ...runtime, OPENAI_API_KEY: 'synthetic' }, job.id, 1)
    ).rejects.toThrow('source_missing');
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (
        await runtime.DB.prepare('SELECT state FROM cd_artwork_jobs WHERE id=?')
          .bind(job.id)
          .first<{ state: string }>()
      )?.state
    ).toBe('queued');
    expect(
      (
        await runtime.DB.prepare(
          'SELECT submitted_count FROM cd_artwork_control'
        ).first<{ submitted_count: number }>()
      )?.submitted_count
    ).toBe(0);
  });
  it('persists a single provider response and never submits it again', async () => {
    const job = await seed('3'.repeat(64));
    const bytes = rawDisc();
    let encoded = '';
    for (const byte of bytes) encoded += String.fromCharCode(byte);
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url, options) => {
        expect(String(url)).toBe('https://api.openai.com/v1/images/edits');
        const form = options?.body as FormData;
        expect(form.getAll('image[]')).toHaveLength(2);
        expect(form.get('model')).toBe(MODEL);
        return Response.json(
          {
            data: [{ b64_json: btoa(encoded) }],
            usage: {
              output_tokens: 10,
              input_tokens_details: { text_tokens: 10, image_tokens: 10 },
            },
          },
          { headers: { 'x-request-id': 'synthetic-provider-request' } }
        );
      });
    const first = await generateOnce(
      { ...runtime, OPENAI_API_KEY: 'synthetic' },
      job.id,
      1
    );
    const repeat = await generateOnce(
      { ...runtime, OPENAI_API_KEY: 'synthetic' },
      job.id,
      1
    );
    expect(first.rawKey).toBe(repeat.rawKey);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const row = await runtime.DB.prepare(
      'SELECT provenance FROM cd_artwork_jobs WHERE id=?'
    )
      .bind(job.id)
      .first<{ provenance: string }>();
    expect(JSON.parse(row!.provenance).calculatedUsd).toBeGreaterThan(0);
  });
  it('gives malformed JSON a client error and protects shared controls from another user', async () => {
    const ctx = createExecutionContext();
    const response = await artworkApp.request(
      'https://api.rewind.rest' + admin + '/jobs',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + adminKey,
          'Content-Type': 'application/json',
        },
        body: '{',
      },
      runtime,
      ctx
    );
    expect(response.status).toBe(400);
    await response.arrayBuffer();
    await waitOnExecutionContext(ctx);
    expect(
      (
        await request(admin + '/control', otherKey, {
          enabled: false,
          daily_limit: 0,
        })
      ).status
    ).toBe(403);
  });
});

describe('source freshness and material revisions', () => {
  it('reuses identical inputs and explicitly detects changed source bytes behind the same URL', async () => {
    let bytes = rawDisc();
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) => {
        const u = String(url);
        if (u.includes('musicbrainz.org'))
          return Response.json({
            title: 'Synthetic album',
            media: [{ format: 'CD', position: 1 }],
            'artist-credit': [{ name: 'Synthetic artist' }],
          });
        if (u === 'https://coverartarchive.org/release/' + input.release_id)
          return Response.json({
            images: [
              {
                id: 7,
                types: ['Front'],
                image:
                  'https://coverartarchive.org/release/' +
                  input.release_id +
                  '/7.png',
              },
            ],
          });
        return new Response(new Uint8Array(bytes), {
          headers: { 'Content-Type': 'image/png' },
        });
      });
    const first = await enqueue(runtime, input, 1),
      repeat = await enqueue(runtime, input, 1);
    expect(repeat.reused).toBe(true);
    expect(repeat.job.id).toBe(first.job.id);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const altered = readPixels(bytes);
    altered.data[(400 * 1024 + 400) * 4] = 100;
    bytes = png(altered);
    const refreshed = await enqueue(
      runtime,
      { ...input, refresh_source: true },
      1
    );
    expect(refreshed.job.id).not.toBe(first.job.id);
    expect(refreshed.job.source_hash).not.toBe(first.job.source_hash);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it('creates an immutable material revision while reusing previously paid raw bytes', async () => {
    const old = await seed('4'.repeat(64), 1, 'needs_registration');
    const oldInput = { ...input, source_kind: 'retail' as const };
    const key = `jobs/1/${old.id}/raw.png`;
    await runtime.ARTWORK.put(key, rawDisc());
    await runtime.DB.prepare(
      'UPDATE cd_artwork_jobs SET input=?,raw_key=? WHERE id=?'
    )
      .bind(JSON.stringify(oldInput), key, old.id)
      .run();
    const original = (await runtime.DB.prepare(
      'SELECT * FROM cd_artwork_jobs WHERE id=?'
    )
      .bind(old.id)
      .first<Job>())!;
    const revision = await materialRevision(runtime, original, {
      inner: 62,
      outer: 80,
      opacity: 0.62,
      evidence: 'synthetic narrow source-specific hub',
    });
    expect(revision.id).not.toBe(original.id);
    expect(revision.raw_key).toBe(original.raw_key);
    const processed = await processRaw(runtime, revision.id, 1);
    expect(processed.state).toBe('pending');
    expect(
      (
        await runtime.DB.prepare('SELECT input FROM cd_artwork_jobs WHERE id=?')
          .bind(original.id)
          .first<{ input: string }>()
      )?.input
    ).toBe(original.input);
  });
});

describe('normal listening enrollment', () => {
  it('registers only new owner scrobbles into a non-paid identity hold', async () => {
    const timestamp = now();
    await runtime.DB.prepare(
      'UPDATE cd_artwork_control SET enroll_since=? WHERE id=1'
    )
      .bind(timestamp)
      .run();
    await runtime.DB.exec(
      "INSERT INTO lastfm_tracks(id,user_id,artist_id,album_id,name,created_at,updated_at) VALUES(1,1,1,1,'Synthetic track','2026-01-01','2026-01-01'),(2,2,2,2,'Other track','2026-01-01','2026-01-01');"
    );
    await runtime.DB.batch([
      runtime.DB.prepare(
        'INSERT INTO lastfm_scrobbles(user_id,track_id,scrobbled_at,created_at) VALUES(1,1,?,?)'
      ).bind(timestamp, timestamp),
      runtime.DB.prepare(
        'INSERT INTO lastfm_scrobbles(user_id,track_id,scrobbled_at,created_at) VALUES(2,2,?,?)'
      ).bind(timestamp, timestamp),
    ]);
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await scheduledArtwork(runtime);
    const rows = await runtime.DB.prepare(
      'SELECT user_id,album_id,discovery_outcome FROM cd_artwork_albums'
    ).all();
    expect(rows.results).toEqual([
      { user_id: 1, album_id: 1, discovery_outcome: 'identity_required' },
    ]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (
        await runtime.DB.prepare(
          'SELECT COUNT(*) AS n FROM cd_artwork_jobs'
        ).first<{ n: number }>()
      )?.n
    ).toBe(0);
  });
});

describe('retail-first selection', () => {
  it('uses a retail face when available and gates unreviewed material before payment', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('musicbrainz.org')) {
        expect(u).toContain('inc=artist-credits+media');
        return Response.json({
          title: 'Synthetic album',
          media: [{ format: 'HDCD', position: 1 }],
          'artist-credit': [{ name: 'Synthetic artist' }],
        });
      }
      if (u === 'https://coverartarchive.org/release/' + input.release_id)
        return Response.json({
          images: [
            {
              id: 9,
              types: ['Medium'],
              image:
                'https://coverartarchive.org/release/' +
                input.release_id +
                '/9.png',
            },
            {
              id: 7,
              types: ['Front'],
              image:
                'https://coverartarchive.org/release/' +
                input.release_id +
                '/7.png',
            },
          ],
        });
      return new Response(new Uint8Array(rawDisc()));
    });
    const result = await enqueue(runtime, { ...input, source_kind: 'auto' }, 1);
    expect(result.job.state).toBe('needs_material_review');
    expect(JSON.parse(result.job.input).source_kind).toBe('retail');
    expect(JSON.parse(result.job.provenance).selectedImageId).toBe('9');
    expect(
      (
        await runtime.DB.prepare(
          'SELECT submitted_count FROM cd_artwork_control'
        ).first<{ submitted_count: number }>()
      )?.submitted_count
    ).toBe(0);
  });
});

describe('discovery-only recheck', () => {
  it('records a found retail face even when the archive has no Front image', async () => {
    await seed('8'.repeat(64), 1, 'accepted');
    // Older unresolved identities must not occupy every bounded recheck slot.
    for (const id of [3, 4, 5]) {
      await runtime.DB.prepare(
        "INSERT INTO lastfm_albums(id,user_id,artist_id,name,created_at,updated_at) VALUES(?,1,1,?,'2026-01-01','2026-01-01')"
      )
        .bind(id, `Unresolved test album ${id}`)
        .run();
      await runtime.DB.prepare(
        "INSERT INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check) VALUES(1,?,'',1,'2019-01-01T00:00:00Z')"
      )
        .bind(id)
        .run();
    }

    await runtime.DB.prepare(
      'UPDATE cd_artwork_albums SET next_check=? WHERE album_id=1'
    )
      .bind('2020-01-01T00:00:00Z')
      .run();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('musicbrainz.org')
        ? Response.json({
            title: 'Synthetic album',
            media: [{ format: 'CD', position: 1 }],
            'artist-credit': [{ name: 'Synthetic artist' }],
          })
        : Response.json({
            images: [
              {
                id: 9,
                types: ['Medium'],
                image: 'https://coverartarchive.org/example.png',
              },
            ],
          })
    );
    await scheduledArtwork(runtime);
    expect(
      (
        await runtime.DB.prepare(
          'SELECT discovery_outcome FROM cd_artwork_albums WHERE album_id=1'
        ).first<{ discovery_outcome: string }>()
      )?.discovery_outcome
    ).toBe('found');
  });
});
