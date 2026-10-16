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
  getJob,
  enqueue,
  materialRevision,
} from './store.js';
import { generateOnce, processRaw } from './generation.js';
import { prepareCandidate } from './registration.js';
import { reviewJob } from './review.js';
import { createLosslessWebp } from './webp-variant.js';
import {
  dispatchWebpVariant,
  prepareAcceptedWebpVariant,
} from './webp-storage.js';
import {
  prepareReviewedMaster,
  persistReviewedMaster,
  reviewedMasterSchema,
} from './reviewed-master.js';
import { checkListeningArtwork } from './discovery.js';
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
function base64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
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
async function candidate(id: string, userId = 1, albumId = 1) {
  await seed(id, userId, 'submitted', albumId);
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
    'DELETE FROM cd_artwork_checks; DELETE FROM cd_artwork_events; DELETE FROM cd_artwork_albums; DELETE FROM cd_artwork_jobs; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists; DELETE FROM api_keys;'
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
const request = async (
  route: string,
  key?: string,
  body?: unknown,
  environment: ArtworkEnv = runtime
) => {
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
    environment,
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

it.each(['lastfm_albums', 'lastfm_artists'])(
  'does not claim a paid submission after a catalog conflict on %s',
  async (table) => {
    const job = await seed('held-conflict', 1, 'queued');
    await runtime.DB.prepare(
      `UPDATE ${table} SET identity_conflict=1 WHERE id=1`
    ).run();
    expect(await claimSubmission(runtime, job)).toBe(false);
    expect((await getJob(runtime, job.id, 1))?.state).toBe('queued');
    expect(
      (
        await runtime.DB.prepare(
          'SELECT submitted_count FROM cd_artwork_control WHERE id=1'
        ).first<{ submitted_count: number }>()
      )?.submitted_count
    ).toBe(0);
  }
);

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
  it('keeps disabled work queued without invoking a provider', async () => {
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
  it('serves published PNG artwork when optional variant and fallback storage stalls or fails', async () => {
    const job = await candidate('7'.repeat(64));
    await reviewJob(runtime, job.id, 1, 'accepted', true, 'synthetic-test');
    const originalGet = runtime.IMAGES.get.bind(runtime.IMAGES);
    const originalFallbackGet = runtime.ARTWORK.get.bind(runtime.ARTWORK);
    const pendingReads: Array<Promise<unknown>> = [];
    let release: (() => void) | undefined;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const get = vi
      .spyOn(runtime.IMAGES, 'get')
      .mockImplementation(async (...args) => {
        if (String(args[0]).startsWith('listening/cd-artwork-variants/')) {
          // Resolve as an absent descriptor after release, so this reader
          // cannot start additional R2 calls during test cleanup.
          const result = stalled.then(() => null);
          pendingReads.push(result);
          return result;
        }
        return originalGet(...args);
      });
    const fallbackGet = vi
      .spyOn(runtime.ARTWORK, 'get')
      .mockImplementation(async (...args) => {
        if (String(args[0]).startsWith('fallback/users/')) {
          const result = stalled.then(() => null);
          pendingReads.push(result);
          return result;
        }
        return originalFallbackGet(...args);
      });
    // The response is bounded well before this fires, so it is still served
    // while storage stalls; releasing later lets the background lookups that
    // the request helper waits on finish instead of deadlocking it.
    const releaseTimer = setTimeout(() => release!(), 1500);
    try {
      const response = await request(`${read}/albums?ids=1`, readKey);
      expect(response.status).toBe(200);
      const snapshot = (await response.json()) as {
        data: Array<{ sha256: string; variants?: unknown }>;
        fallback_artwork?: unknown;
      };
      expect(snapshot.data[0].sha256).toBe(job.candidate_hash);
      expect(snapshot.data[0].variants).toBeUndefined();
      expect(snapshot.fallback_artwork).toBeUndefined();
    } finally {
      clearTimeout(releaseTimer);
      release!();
      // Let the bounded read finish before restoring the R2 mock.
      await stalled;
      await Promise.all(pendingReads);
      get.mockRestore();
      fallbackGet.mockRestore();
    }
    vi.spyOn(runtime.IMAGES, 'get').mockRejectedValue(
      new Error('R2 unavailable')
    );
    vi.spyOn(runtime.ARTWORK, 'get').mockRejectedValue(
      new Error('R2 unavailable')
    );
    const failed = await request(`${read}/albums?ids=1`, readKey);
    expect(failed.status).toBe(200);
    const failedSnapshot = (await failed.json()) as {
      data: Array<{ sha256: string }>;
    };
    expect(failedSnapshot.data[0].sha256).toBe(job.candidate_hash);
  });
  it('advertises a verified WebP without re-downloading it while its object is unchanged', async () => {
    const job = await candidate('6'.repeat(64));
    await reviewJob(runtime, job.id, 1, 'accepted', true, 'synthetic-test');
    const stored = await prepareAcceptedWebpVariant(
      runtime,
      job.candidate_hash!,
      1
    );
    expect(stored).not.toBeNull();
    const row = await runtime.DB.prepare(
      'SELECT canonical_hash,bytes FROM cd_artwork_variant_checks WHERE variant_sha256=?'
    )
      .bind(stored!.sha256)
      .first<{ canonical_hash: string; bytes: number }>();
    expect(row).toEqual({
      canonical_hash: job.candidate_hash,
      bytes: stored!.bytes,
    });
    const variantKey = `listening/cd-artwork-variants/${stored!.sha256}.webp`;
    // Expire the in-memory verification so only the durable record can help.
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
    const original = new Uint8Array(
      await (await runtime.IMAGES.get(variantKey))!.arrayBuffer()
    );
    const get = vi.spyOn(runtime.IMAGES, 'get');
    try {
      const snapshot = (await (
        await request(`${read}/albums?ids=1`, readKey)
      ).json()) as { data: Array<{ variants?: Array<{ sha256: string }> }> };
      expect(snapshot.data[0].variants?.[0]?.sha256).toBe(stored!.sha256);
      expect(get.mock.calls.map(([key]) => key)).not.toContain(variantKey);
      // A replaced object has a new ETag: it is hashed again, and a corrupt
      // body is no longer advertised.
      const bytes = original.slice();
      bytes[bytes.length - 1] ^= 1;
      await runtime.IMAGES.put(variantKey, bytes, {
        httpMetadata: { contentType: 'image/webp' },
      });
      clock.mockReturnValue(now + 240_000);
      const corrupt = (await (
        await request(`${read}/albums?ids=1`, readKey)
      ).json()) as { data: Array<{ variants?: unknown }> };
      expect(corrupt.data[0].variants).toBeUndefined();
    } finally {
      get.mockRestore();
      clock.mockRestore();
      // Synthetic candidates share one variant object; leave it intact.
      await runtime.IMAGES.put(variantKey, original, {
        httpMetadata: {
          contentType: 'image/webp',
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
    }
  });
  it('advertises and serves only the verified optional WebP while preserving PNG identity', async () => {
    const job = await candidate('4'.repeat(64));
    await reviewJob(runtime, job.id, 1, 'accepted', true, 'synthetic-test');
    await runtime.DB.prepare(
      'UPDATE cd_artwork_albums SET visibility_revision=1 WHERE user_id=1 AND album_id=1'
    ).run();
    const revisionOne = await (
      await request(`${read}/albums?ids=1`, readKey)
    ).json();
    const pngKey = `listening/cd-artwork/${job.candidate_hash}.png`;
    const canonicalBefore = new Uint8Array(
      await (await runtime.IMAGES.get(pngKey))!.arrayBuffer()
    );
    const stored = await prepareAcceptedWebpVariant(
      runtime,
      job.candidate_hash!,
      1
    );
    const repeated = await prepareAcceptedWebpVariant(
      runtime,
      job.candidate_hash!,
      1
    );
    expect(repeated).toEqual(stored);
    await runtime.IMAGES.delete(
      `listening/cd-artwork-variants/by-hash/v2/${stored!.sha256}.json`
    );
    const recoveredIndex = await prepareAcceptedWebpVariant(
      runtime,
      job.candidate_hash!,
      1
    );
    expect(recoveredIndex).toEqual(stored);
    const indexKey = `listening/cd-artwork-variants/by-hash/v2/${stored!.sha256}.json`;
    await runtime.IMAGES.put(
      indexKey,
      JSON.stringify({ ...stored, bytes: stored!.bytes + 1 }),
      { httpMetadata: { contentType: 'application/json' } }
    );
    const inconsistentIndex = (await (
      await request(`${read}/albums?ids=1`, readKey)
    ).json()) as { data: Array<Record<string, unknown>> };
    expect(inconsistentIndex.data[0].variants).toBeUndefined();
    expect(
      (await request(`${read}/assets/${stored!.sha256}.webp`, readKey)).status
    ).toBe(404);
    await runtime.IMAGES.put(indexKey, JSON.stringify(stored), {
      httpMetadata: { contentType: 'application/json' },
    });
    const metadataKey = `listening/cd-artwork-variants/v2/${job.candidate_hash}.json`;
    await runtime.IMAGES.put(
      metadataKey,
      JSON.stringify({ ...stored, bytes: stored!.bytes + 1 }),
      { httpMetadata: { contentType: 'application/json' } }
    );
    expect(
      (await request(`${read}/assets/${stored!.sha256}.webp`, readKey)).status
    ).toBe(404);
    await runtime.IMAGES.put(metadataKey, JSON.stringify(stored), {
      httpMetadata: { contentType: 'application/json' },
    });
    await runtime.DB.prepare(
      'UPDATE cd_artwork_albums SET visibility_revision=2 WHERE user_id=1 AND album_id=1'
    ).run();
    const revisionTwo = await (
      await request(`${read}/albums?ids=1`, readKey)
    ).json();
    if (import.meta.env.VITE_CD_ARTWORK_EXPORT_FIXTURE === '1') {
      const pngResponse = await request(
        `${read}/assets/${job.candidate_hash}.png`,
        readKey
      );
      const webpResponse = await request(
        `${read}/assets/${stored!.sha256}.webp`,
        readKey
      );
      console.log(
        `DISC_DELIVERY_FIXTURE:${JSON.stringify({
          revisionOne,
          revisionTwo,
          canonicalPng: base64(new Uint8Array(await pngResponse.arrayBuffer())),
          variantWebp: base64(new Uint8Array(await webpResponse.arrayBuffer())),
        })}`
      );
    }
    expect(stored).toMatchObject({
      canonical_hash: job.candidate_hash,
      format: 'webp',
      width: 1024,
      height: 1024,
      version: 2,
    });
    expect(stored!.bytes).toBeLessThan(canonicalBefore.byteLength);
    const snapshot = (await (
      await request(`${read}/albums?ids=1`, readKey)
    ).json()) as { data: Array<Record<string, unknown>> };
    expect(snapshot.data[0].variants).toEqual([
      {
        image_url: `https://api.rewind.rest/v1/listening/cd-artwork/assets/${stored!.sha256}.webp`,
        sha256: stored!.sha256,
        format: 'webp',
        width: 1024,
        height: 1024,
        bytes: stored!.bytes,
      },
    ]);
    const response = await request(
      `${read}/assets/${stored!.sha256}.webp`,
      readKey
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Cache-Control')).toContain('immutable');
    const originalWebp = new Uint8Array(await response.arrayBuffer());
    expect(originalWebp.byteLength).toBe(stored!.bytes);
    const variantKey = `listening/cd-artwork-variants/${stored!.sha256}.webp`;
    const corruptWebp = originalWebp.slice();
    corruptWebp[corruptWebp.length - 1] ^= 1;
    await runtime.IMAGES.put(variantKey, corruptWebp, {
      httpMetadata: { contentType: 'image/webp' },
    });
    const afterCorruptObject = (await (
      await request(`${read}/albums?ids=1`, readKey)
    ).json()) as { data: Array<Record<string, unknown>> };
    expect(afterCorruptObject.data[0].variants).toBeUndefined();
    expect(
      (await request(`${read}/assets/${stored!.sha256}.webp`, readKey)).status
    ).toBe(404);
    await runtime.IMAGES.put(variantKey, originalWebp, {
      httpMetadata: { contentType: 'image/webp' },
    });
    const canonicalAfter = new Uint8Array(
      await (await runtime.IMAGES.get(pngKey))!.arrayBuffer()
    );
    expect(canonicalAfter).toEqual(canonicalBefore);
    expect(
      (await request(`${read}/assets/${'9'.repeat(64)}.webp`, readKey)).status
    ).toBe(404);
    await runtime.IMAGES.delete(variantKey);
    const afterMissing = (await (
      await request(`${read}/albums?ids=1`, readKey)
    ).json()) as { data: Array<Record<string, unknown>> };
    expect(afterMissing.data[0].variants).toBeUndefined();
    expect(
      (await request(`${read}/assets/${stored!.sha256}.webp`, readKey)).status
    ).toBe(404);
    expect(
      (await request(`${read}/assets/${job.candidate_hash}.png`, readKey))
        .status
    ).toBe(200);
  });
  it('keeps advertising an earlier lossless variant until a delivery variant is prepared', async () => {
    const job = await candidate('b'.repeat(64));
    await reviewJob(runtime, job.id, 1, 'accepted', true, 'synthetic-test');
    const canonicalHash = job.candidate_hash!;
    const png = new Uint8Array(
      await (await runtime.IMAGES.get(
        `listening/cd-artwork/${canonicalHash}.png`
      ))!.arrayBuffer()
    );
    // A version 1 (lossless) variant as the earlier producer stored it.
    const lossless = await createLosslessWebp(png);
    const losslessHash = await sha256(lossless);
    const v1 = {
      canonical_hash: canonicalHash,
      sha256: losslessHash,
      format: 'webp',
      width: 1024,
      height: 1024,
      bytes: lossless.byteLength,
      version: 1,
    };
    const prefix = 'listening/cd-artwork-variants/';
    await Promise.all([
      runtime.IMAGES.delete(`${prefix}v2/${canonicalHash}.json`),
      runtime.IMAGES.put(`${prefix}${losslessHash}.webp`, lossless, {
        httpMetadata: { contentType: 'image/webp' },
      }),
      runtime.IMAGES.put(
        `${prefix}by-hash/${losslessHash}.json`,
        JSON.stringify(v1),
        {
          httpMetadata: { contentType: 'application/json' },
        }
      ),
      runtime.IMAGES.put(`${prefix}${canonicalHash}.json`, JSON.stringify(v1), {
        httpMetadata: { contentType: 'application/json' },
      }),
    ]);
    const advertised = async () =>
      (
        (await (await request(`${read}/albums?ids=1`, readKey)).json()) as {
          data: Array<{ variants?: Array<{ sha256: string }> }>;
        }
      ).data[0].variants?.[0]?.sha256;
    expect(await advertised()).toBe(losslessHash);
    expect(
      (await request(`${read}/assets/${losslessHash}.webp`, readKey)).status
    ).toBe(200);

    const delivery = await prepareAcceptedWebpVariant(
      runtime,
      canonicalHash,
      1
    );
    expect(delivery?.version).toBe(2);
    expect(delivery!.bytes).toBeLessThanOrEqual(lossless.byteLength);
    if (delivery!.sha256 !== losslessHash)
      expect(await advertised()).toBe(delivery!.sha256);
    expect(
      (await request(`${read}/assets/${delivery!.sha256}.webp`, readKey)).status
    ).toBe(200);
  });
  it('does not serve a verified variant after its accepted job is rejected', async () => {
    const job = await candidate('5'.repeat(64));
    await reviewJob(runtime, job.id, 1, 'accepted', false, 'synthetic-test');
    const stored = await prepareAcceptedWebpVariant(
      runtime,
      job.candidate_hash!,
      1
    );
    expect(stored).toBeTruthy();
    await reviewJob(runtime, job.id, 1, 'rejected', false, 'synthetic-test');
    expect(
      (await request(`${read}/assets/${stored!.sha256}.webp`, readKey)).status
    ).toBe(404);
    expect(await approvedArtwork(runtime, [1], 1)).toEqual([]);
  });
  it('recovers only once after a confirmed terminal variant workflow failure', async () => {
    const job = await candidate('6'.repeat(64));
    await reviewJob(runtime, job.id, 1, 'accepted', false, 'synthetic-test');
    const canonicalHash = job.candidate_hash!;
    const baseId = `webp-v2-${canonicalHash}`;
    const recoveryId = `webp-v2-r1-${canonicalHash}`;
    const fakeWorkflow = (
      state: 'running' | 'complete' | 'errored',
      unknown = false
    ) => {
      const existing = new Set([baseId]);
      const attempts: string[] = [];
      return {
        attempts,
        api: {
          create: async ({ id }: { id: string }) => {
            attempts.push(id);
            if (existing.has(id)) throw new Error('duplicate');
            existing.add(id);
            return {};
          },
          get: async (id: string) => {
            if (!existing.has(id) || (unknown && id === baseId))
              throw new Error('status unavailable');
            return {
              status: async () => ({
                status: id === baseId ? state : 'errored',
              }),
            };
          },
        },
      };
    };
    for (const state of ['running', 'complete'] as const) {
      const fake = fakeWorkflow(state);
      await dispatchWebpVariant(
        { ...runtime, CD_WORKFLOW: fake.api } as unknown as ArtworkEnv,
        canonicalHash,
        1
      );
      expect(fake.attempts).toEqual([baseId]);
    }
    const unknown = fakeWorkflow('errored', true);
    await dispatchWebpVariant(
      { ...runtime, CD_WORKFLOW: unknown.api } as unknown as ArtworkEnv,
      canonicalHash,
      1
    );
    expect(unknown.attempts).toEqual([baseId]);

    const failed = fakeWorkflow('errored');
    const envWithFailedWorkflow = {
      ...runtime,
      CD_WORKFLOW: failed.api,
    } as unknown as ArtworkEnv;
    await dispatchWebpVariant(envWithFailedWorkflow, canonicalHash, 1);
    await dispatchWebpVariant(envWithFailedWorkflow, canonicalHash, 1);
    expect(failed.attempts).toEqual([baseId, recoveryId, baseId, recoveryId]);
    expect(new Set(failed.attempts).size).toBe(2);
  });
  it('previews a scoped bounded backfill by default and deduplicates active hashes', async () => {
    await runtime.DB.prepare(
      "INSERT INTO lastfm_albums(id,user_id,artist_id,name,created_at,updated_at) VALUES(3,1,1,'Second synthetic album','2026-01-01','2026-01-01')"
    ).run();
    const first = await candidate('7'.repeat(64), 1, 1);
    const second = await candidate('8'.repeat(64), 1, 3);
    expect(second.candidate_hash).toBe(first.candidate_hash);
    const variantHash = first.candidate_hash!;
    await Promise.all([
      runtime.IMAGES.delete(
        `listening/cd-artwork-variants/v2/${variantHash}.json`
      ),
      runtime.IMAGES.delete(
        `listening/cd-artwork-variants/by-hash/${variantHash}.json`
      ),
      runtime.IMAGES.delete(
        `listening/cd-artwork-variants/${variantHash}.webp`
      ),
    ]);
    await reviewJob(runtime, first.id, 1, 'accepted', true, 'synthetic-test');
    await reviewJob(runtime, second.id, 1, 'accepted', true, 'synthetic-test');

    const starts: string[] = [];
    const existing = new Set<string>();
    const environment = {
      ...runtime,
      CD_WORKFLOW: {
        create: async ({ id }: { id: string }) => {
          if (existing.has(id)) throw new Error('duplicate workflow');
          existing.add(id);
          starts.push(id);
          return {};
        },
        get: async (id: string) => {
          if (!existing.has(id)) throw new Error('missing workflow');
          return { status: async () => ({ status: 'running' }) };
        },
      },
    } as unknown as ArtworkEnv;
    const preview = await request(
      `${admin}/webp-backfill`,
      adminKey,
      { album_ids: [1, 3, 1] },
      environment
    );
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      dry_run: boolean;
      requested_album_count: number;
      eligible_album_count: number;
      unique_hash_count: number;
      items: Array<{ album_ids: number[]; status: string }>;
    };
    expect(previewBody).toMatchObject({
      dry_run: true,
      requested_album_count: 2,
      eligible_album_count: 2,
      unique_hash_count: 1,
      items: [{ album_ids: [1, 3], status: 'would_dispatch' }],
    });
    expect(starts).toEqual([]);

    const applied = await request(
      `${admin}/webp-backfill`,
      adminKey,
      { album_ids: [1, 3], dry_run: false },
      environment
    );
    expect(applied.status).toBe(202);
    expect(
      ((await applied.json()) as { items: Array<{ status: string }> }).items[0]
        .status
    ).toBe('created');
    const repeated = await request(
      `${admin}/webp-backfill`,
      adminKey,
      { album_ids: [1, 3], dry_run: false },
      environment
    );
    expect(
      ((await repeated.json()) as { items: Array<{ status: string }> }).items[0]
        .status
    ).toBe('already_active');
    expect(starts).toEqual([`webp-v2-${first.candidate_hash}`]);
    await prepareAcceptedWebpVariant(runtime, variantHash, 1);
    const prepared = await request(
      `${admin}/webp-backfill`,
      adminKey,
      { album_ids: [1, 3], dry_run: false },
      environment
    );
    expect(
      ((await prepared.json()) as { items: Array<{ status: string }> }).items[0]
        .status
    ).toBe('already_prepared');
    expect(starts).toEqual([`webp-v2-${first.candidate_hash}`]);
  });
  it('requires admin auth and owned IDs, and skips hidden or rejected assets', async () => {
    const hidden = await candidate('9'.repeat(64));
    await reviewJob(runtime, hidden.id, 1, 'accepted', true, 'synthetic-test');
    await runtime.DB.prepare(
      'UPDATE cd_artwork_albums SET active_job=NULL,hidden_job=? WHERE user_id=1 AND album_id=1'
    )
      .bind(hidden.id)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO lastfm_albums(id,user_id,artist_id,name,created_at,updated_at) VALUES(3,1,1,'Rejected synthetic album','2026-01-01','2026-01-01')"
    ).run();
    const rejected = await candidate('a'.repeat(64), 1, 3);
    await reviewJob(
      runtime,
      rejected.id,
      1,
      'rejected',
      false,
      'synthetic-test'
    );
    expect(
      (await request(`${admin}/webp-backfill`, undefined, { album_ids: [1] }))
        .status
    ).toBe(401);
    expect(
      (await request(`${admin}/webp-backfill`, readKey, { album_ids: [1] }))
        .status
    ).toBe(403);
    expect(
      (
        await request(`${admin}/webp-backfill`, otherKey, {
          album_ids: [1],
        })
      ).status
    ).toBe(404);
    expect(
      (
        await request(`${admin}/webp-backfill`, adminKey, {
          album_ids: Array.from({ length: 21 }, (_, index) => index + 1),
        })
      ).status
    ).toBe(400);
    const skipped = await request(`${admin}/webp-backfill`, adminKey, {
      album_ids: [1, 3],
    });
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toMatchObject({
      dry_run: true,
      eligible_album_count: 0,
      skipped_album_ids: [1, 3],
      unique_hash_count: 0,
      items: [],
    });
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
  it('recovery never scans due albums without a play event', async () => {
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
    await runtime.DB.prepare(
      'UPDATE lastfm_artists SET mbid=? WHERE id=1 AND user_id=1'
    )
      .bind('55555555-5555-4555-8555-555555555555')
      .run();
    await expect(enqueue(runtime, input, 1)).rejects.toMatchObject({
      code: 'edition_identity_mismatch',
    });
    expect(fetcher).toHaveBeenCalledTimes(7);
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
        expect(u).toContain('inc=artist-credits+release-groups+media');
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
    const check = await runtime.DB.prepare(
      'INSERT INTO cd_artwork_checks(user_id,album_id,release_id,medium_position) VALUES(1,1,?,1) RETURNING id'
    )
      .bind(input.release_id)
      .first<{ id: number }>();
    await checkListeningArtwork(runtime, check!.id);
    expect(
      (
        await runtime.DB.prepare(
          'SELECT discovery_outcome FROM cd_artwork_albums WHERE album_id=1'
        ).first<{ discovery_outcome: string }>()
      )?.discovery_outcome
    ).toBe('found');
  });
});

describe('reviewed master coverage without generation', () => {
  async function upload(
    key: string,
    apply = false,
    override: Record<string, unknown> = {}
  ) {
    const original = rawDisc();
    const bytes = prepareCandidate(original, input).bytes;
    const data = {
      album_id: 1,
      expected_album: { artist: 'Synthetic artist', title: 'Synthetic album' },
      source_kind: 'cover',
      source_url: 'https://cdn.rewind.rest/listening/albums/1/original.jpg',
      source_sha256: await sha256(original),
      candidate_sha256: await sha256(bytes),
      material: {
        inner: 62,
        outer: 88,
        evidence: 'Reviewed material boundary, existing accepted master',
      },
      review_evidence: 'Owner approved this exact master; synthetic fixture',
      processing: {
        method: 'prepared-composition',
        evidence: 'Source and finished material master independently reviewed',
      },
      ...override,
    };
    const form = new FormData();
    form.set('input', JSON.stringify(data));
    form.set('source', new File([new Uint8Array(original)], 'source.png'));
    form.set('candidate', new File([new Uint8Array(bytes)], 'candidate.png'));
    const ctx = createExecutionContext();
    const response = await artworkApp.request(
      'https://api.rewind.rest' +
        admin +
        '/import-reviewed' +
        (apply ? '?apply=true' : ''),
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key },
        body: form,
      },
      runtime,
      ctx
    );
    await waitOnExecutionContext(ctx);
    return { response, bytes, original, data };
  }
  it('validates without writes and rejects read keys, other users, stale identity and wrong hashes', async () => {
    expect((await upload(readKey)).response.status).toBe(403);
    expect((await upload(otherKey)).response.status).toBe(404);
    expect(
      (
        await upload(adminKey, false, {
          expected_album: { artist: 'Other artist', title: 'Synthetic album' },
        })
      ).response.status
    ).toBe(409);
    expect(
      (await upload(adminKey, false, { candidate_sha256: '0'.repeat(64) }))
        .response.status
    ).toBe(422);
    expect(
      (
        await upload(adminKey, false, {
          source_url: 'https://cdn.rewind.rest/listening/albums/2/original.jpg',
        })
      ).response.status
    ).toBe(422);
    const beforeObjects = (await runtime.ARTWORK.list()).objects.map(
      (o) => o.key
    );
    const beforeAlbums = (
      await runtime.DB.prepare('SELECT * FROM cd_artwork_albums').all()
    ).results;
    const valid = await upload(adminKey);
    expect(valid.response.status).toBe(200);
    expect((await runtime.ARTWORK.list()).objects.map((o) => o.key)).toEqual(
      beforeObjects
    );
    expect(
      (await runtime.DB.prepare('SELECT * FROM cd_artwork_albums').all())
        .results
    ).toEqual(beforeAlbums);
    expect(
      await runtime.DB.prepare(
        'SELECT COUNT(*) AS n FROM cd_artwork_jobs'
      ).first('n')
    ).toBe(0);
  });
  it('imports exact immutable bytes without a release claim or provider request, then explicitly publishes', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const first = await upload(adminKey, true);
    expect(first.response.status).toBe(202);
    const job = await first.response.json<{
      id: string;
      candidate_hash: string;
      state: string;
      submitted_at: string | null;
    }>();
    expect(job.state).toBe('pending');
    expect(job.submitted_at).toBeNull();
    expect(job.candidate_hash).toBe(await sha256(first.bytes));
    expect(
      (await request(read + '/assets/' + job.candidate_hash + '.png')).status
    ).toBe(404);
    const repeat = await upload(adminKey, true);
    expect(repeat.response.status).toBe(200);
    expect((await repeat.response.json<{ id: string }>()).id).toBe(job.id);
    await scheduledArtwork(runtime);
    expect(fetcher).not.toHaveBeenCalled();
    await reviewJob(
      runtime,
      job.id,
      1,
      'accepted',
      true,
      'owner approved original master'
    );
    const art = (await approvedArtwork(runtime, [1], 1))[0];
    expect(art.release_id).toBeNull();
    expect(art.medium_position).toBeNull();
    expect(art.identity_type).toBe('reviewed_source');
    const image = await request(
      read + '/assets/' + job.candidate_hash + '.png'
    );
    expect(await sha256(new Uint8Array(await image.arrayBuffer()))).toBe(
      job.candidate_hash
    );
    expect(
      await runtime.DB.prepare(
        'SELECT submitted_count FROM cd_artwork_control WHERE id=1'
      ).first('submitted_count')
    ).toBe(0);
  });
  it('keeps active pinned artwork and rejects missing processing evidence', async () => {
    const active = await candidate('previous');
    await reviewJob(runtime, active.id, 1, 'accepted', true, 'existing review');
    await runtime.DB.prepare(
      'UPDATE cd_artwork_albums SET pinned=1 WHERE user_id=1 AND album_id=1'
    ).run();
    const imported = await upload(adminKey, true);
    const job = await imported.response.json<{ id: string }>();
    await expect(
      reviewJob(runtime, job.id, 1, 'accepted', true, 'new review')
    ).rejects.toThrow('activation_not_allowed');
    expect((await approvedArtwork(runtime, [1], 1))[0].asset_id).toBe(
      active.id
    );
    const data = reviewedMasterSchema.parse((await upload(adminKey)).data);
    data.processing.evidence_hashes.raw = '0'.repeat(64);
    await expect(
      prepareReviewedMaster(
        runtime,
        data,
        {
          source: rawDisc(),
          candidate: prepareCandidate(rawDisc(), input).bytes,
        },
        1
      )
    ).rejects.toThrow('import_evidence_mismatch');
  });

  it('preserves verified discovery identity when activating source-only artwork', async () => {
    const active = await candidate('previous');
    await reviewJob(runtime, active.id, 1, 'accepted', true, 'existing review');
    const before = await runtime.DB.prepare(
      'SELECT release_id,medium_position FROM cd_artwork_albums WHERE user_id=1 AND album_id=1'
    ).first();
    const imported = await upload(adminKey, true);
    const job = await imported.response.json<{ id: string }>();
    await reviewJob(
      runtime,
      job.id,
      1,
      'accepted',
      true,
      'new reviewed source'
    );
    expect(
      await runtime.DB.prepare(
        'SELECT release_id,medium_position FROM cd_artwork_albums WHERE user_id=1 AND album_id=1'
      ).first()
    ).toEqual(before);
    expect((await approvedArtwork(runtime, [1], 1))[0].identity_type).toBe(
      'reviewed_source'
    );
  });
  it('recovers safely after object storage and transactional database failures', async () => {
    const store = vi
      .spyOn(runtime.ARTWORK, 'put')
      .mockRejectedValueOnce(Error('storage unavailable'));
    expect((await upload(adminKey, true)).response.status).toBe(503);
    store.mockRestore();
    const batch = vi
      .spyOn(runtime.DB, 'batch')
      .mockRejectedValueOnce(Error('database unavailable'));
    expect((await upload(adminKey, true)).response.status).toBe(503);
    batch.mockRestore();
    const sample = await upload(adminKey, true);
    expect(sample.response.status).toBe(202);
    const job = await sample.response.json<{ id: string }>();
    const stored = await getJob(runtime, job.id, 1);
    expect(stored).not.toBeNull();
    const original = await runtime.ARTWORK.get(stored!.source_key);
    expect(await sha256(new Uint8Array(await original!.arrayBuffer()))).toBe(
      sample.data.source_sha256
    );
    const candidate = await runtime.ARTWORK.get(stored!.candidate_key!);
    expect(await sha256(new Uint8Array(await candidate!.arrayBuffer()))).toBe(
      sample.data.candidate_sha256
    );
    expect((await upload(adminKey, true)).response.status).toBe(200);
  });
  it('does not report activation when an album becomes pinned during review', async () => {
    const previous = await candidate('previous');
    await reviewJob(
      runtime,
      previous.id,
      1,
      'accepted',
      true,
      'existing review'
    );
    const next = await upload(adminKey, true);
    const job = await next.response.json<{ id: string }>();
    const batch = runtime.DB.batch.bind(runtime.DB);
    vi.spyOn(runtime.DB, 'batch').mockImplementationOnce(async (statements) => {
      await runtime.DB.prepare(
        'UPDATE cd_artwork_albums SET pinned=1 WHERE user_id=1 AND album_id=1'
      ).run();
      return batch(statements);
    });
    await expect(
      reviewJob(runtime, job.id, 1, 'accepted', true, 'new review')
    ).rejects.toThrow('activation_conflict');
    expect((await approvedArtwork(runtime, [1], 1))[0].asset_id).toBe(
      previous.id
    );
    expect((await getJob(runtime, job.id, 1))?.state).toBe('pending');
  });
  it('retries overlapping import persistence into one pending job', async () => {
    const sample = await upload(adminKey);
    const data = reviewedMasterSchema.parse(sample.data);
    const files = { source: sample.original, candidate: sample.bytes };
    const prepared = await prepareReviewedMaster(runtime, data, files, 1);
    const results = await Promise.all([
      persistReviewedMaster(runtime, data, files, 1, prepared),
      persistReviewedMaster(runtime, data, files, 1, prepared),
    ]);
    expect(results[0].job.id).toBe(results[1].job.id);
    expect(
      await runtime.DB.prepare(
        'SELECT COUNT(*) AS n FROM cd_artwork_jobs'
      ).first('n')
    ).toBe(1);
  });
});

describe('generic fallback API handoff', () => {
  it('requires admin for seeding, validates without writes, and serves metadata independently of albums', async () => {
    const png = prepareCandidate(rawDisc(), input).bytes;
    async function uploadFallback(key: string, apply = false) {
      const form = new FormData();
      form.set(
        'input',
        JSON.stringify({
          expected_sha256: null,
          review_evidence:
            'Reviewed synthetic generic fallback geometry and alpha.',
        })
      );
      form.set('candidate', new File([new Uint8Array(png)], 'fallback.png'));
      return artworkApp.request(
        `https://api.rewind.rest${admin}/fallback${apply ? '?apply=true' : ''}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: form,
        },
        runtime,
        createExecutionContext()
      );
    }
    await runtime.ARTWORK.delete('fallback/users/1/descriptor.json');
    expect((await uploadFallback(readKey)).status).toBe(403);
    expect((await uploadFallback(adminKey)).status).toBe(200);
    expect(
      await runtime.ARTWORK.get('fallback/users/1/descriptor.json')
    ).toBeNull();
    const applied = await uploadFallback(adminKey, true);
    expect(applied.status).toBe(200);
    const descriptor = (await applied.json()) as {
      sha256: string;
      image_url: string;
    };
    expect((await request(`${read}/albums?ids=`, readKey)).status).toBe(200);
    const snapshot = (await (
      await request(`${read}/albums?ids=`, readKey)
    ).json()) as { data: unknown[]; fallback_artwork: unknown };
    expect(snapshot.data).toEqual([]);
    expect(snapshot.fallback_artwork).toEqual(descriptor);
    const other = (await (
      await request(`${read}/albums?ids=`, otherKey)
    ).json()) as { fallback_artwork: unknown };
    expect(other.fallback_artwork).toBeUndefined();
    const asset = await artworkApp.request(descriptor.image_url, {}, runtime);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('Content-Type')).toBe('image/png');
    expect(asset.headers.get('Cache-Control')).toContain('immutable');
    expect(await sha256(new Uint8Array(await asset.arrayBuffer()))).toBe(
      descriptor.sha256
    );
    expect((await uploadFallback(adminKey, true)).status).toBe(409);
  });
});

describe('AudioDB owner review API', () => {
  it('keeps previews private and binds explicit review to the owned album and exact source', async () => {
    const group = '11111111-1111-4111-8111-111111111111';
    const sourceUrl =
      'https://r2.theaudiodb.com/images/media/album/cdart/synthetic.png';
    const png = rawDisc();
    let providerClock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (providerClock += 3000));
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) => {
        const path = String(url);
        if (path.startsWith('https://musicbrainz.org/ws/2/release/'))
          return Response.json({
            id: input.release_id,
            title: 'Synthetic album',
            'artist-credit': [
              {
                name: 'Synthetic artist',
                artist: { name: 'Synthetic artist' },
              },
            ],
            'release-group': { id: group },
            media: [{ format: 'CD', position: 1 }],
          });
        if (path.startsWith('https://coverartarchive.org/'))
          return Response.json({ images: [] });
        if (
          path ===
          `https://www.theaudiodb.com/api/v1/json/123/album-mb.php?i=${group}`
        )
          return Response.json({
            album: [
              {
                idAlbum: '123',
                strAlbum: 'Synthetic album',
                strArtist: 'Synthetic artist',
                strMusicBrainzID: group,
                strAlbumCDart: sourceUrl,
              },
            ],
          });
        if (path === sourceUrl)
          return new Response(new Uint8Array(png), {
            headers: { 'Content-Type': 'image/png' },
          });
        throw new Error('Unexpected upstream request in owner review');
      });
    const endpoint = `${admin}/albums/1/audiodb`;
    const body = { release_id: input.release_id, medium_position: 1 };
    expect((await request(endpoint, readKey, body)).status).toBe(403);
    expect((await request(endpoint, otherKey, body)).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
    const before = (await runtime.ARTWORK.list()).objects.map((o) => o.key);
    const preview = await request(endpoint, adminKey, body);
    expect(preview.status).toBe(200);
    const result = (await preview.json()) as {
      outcome: string;
      candidate: Record<string, unknown>;
    };
    expect(result.outcome).toBe('needs_official_artwork_review');
    expect(result.candidate).not.toHaveProperty('bytes');
    expect((await runtime.ARTWORK.list()).objects.map((o) => o.key)).toEqual(
      before
    );
    const { artist: _artist, album: _album, ...binding } = result.candidate;
    const registered = prepareCandidate(png, input).bytes;
    const masterInput = reviewedMasterSchema.parse({
      album_id: 1,
      expected_album: { artist: 'Synthetic artist', title: 'Synthetic album' },
      source_kind: 'retail',
      source_url: sourceUrl,
      source_sha256: await sha256(png),
      candidate_sha256: await sha256(registered),
      audiodb: { release_group_id: group, provider_album_id: '123' },
      material: {
        inner: 62,
        outer: 90,
        evidence: 'Synthetic photographed hub retained opaque and reviewed.',
      },
      review_evidence:
        'Exact reviewed source registered without any model generation.',
      processing: {
        method: 'deterministic-registration',
        evidence:
          'Source face preserved with canonical geometry and silhouette.',
      },
    });
    const masterFiles = { source: png, candidate: registered };
    await expect(
      prepareReviewedMaster(runtime, masterInput, masterFiles, 1)
    ).rejects.toMatchObject({ code: 'audiodb_official_review_required' });
    const review = {
      ...binding,
      officialArtwork: true,
      evidence: 'Owner compared the exact bytes to official retail CD design.',
    };
    expect(
      (
        await request(`${endpoint}?apply=true`, adminKey, {
          ...body,
          review: { ...review, sourceSha256: '0'.repeat(64) },
        })
      ).status
    ).toBe(409);
    expect(
      (await request(`${endpoint}?apply=true`, adminKey, { ...body, review }))
        .status
    ).toBe(200);
    expect(
      (await prepareReviewedMaster(runtime, masterInput, masterFiles, 1)).id
    ).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      prepareReviewedMaster(
        runtime,
        {
          ...masterInput,
          audiodb: { ...masterInput.audiodb!, provider_album_id: '456' },
        },
        masterFiles,
        1
      )
    ).rejects.toMatchObject({ code: 'audiodb_official_review_required' });
    await expect(
      prepareReviewedMaster(
        runtime,
        { ...masterInput, audiodb: undefined },
        masterFiles,
        1
      )
    ).rejects.toMatchObject({ code: 'source_identity_invalid' });
    expect(
      await runtime.DB.prepare(
        'SELECT COUNT(*) AS n FROM cd_artwork_jobs'
      ).first('n')
    ).toBe(0);
    expect(
      await runtime.DB.prepare(
        'SELECT COUNT(*) AS n FROM cd_artwork_albums'
      ).first('n')
    ).toBe(0);
  });
});

it.each([0, 3, 10])(
  'retired daily_limit=%s does not block submission and duplicate claims still count once',
  async (legacyLimit) => {
    const job = await seed();
    await runtime.DB.prepare(
      'UPDATE cd_artwork_control SET daily_limit=?,budget_day=?,submitted_count=100 WHERE id=1'
    )
      .bind(legacyLimit, new Date().toISOString().slice(0, 10))
      .run();
    const claims = await Promise.all([
      claimSubmission(runtime, job),
      claimSubmission(runtime, job),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      await runtime.DB.prepare(
        'SELECT submitted_count FROM cd_artwork_control WHERE id=1'
      ).first('submitted_count')
    ).toBe(101);
  }
);
it('reports no daily limit and rejects the retired budget control instead of silently applying it', async () => {
  const status = await request(admin + '/control', adminKey);
  expect(
    ((await status.json()) as { daily_limit: null }).daily_limit
  ).toBeNull();
  expect(
    (
      await request(admin + '/control', adminKey, {
        enabled: true,
        daily_limit: 0,
      })
    ).status
  ).toBe(400);
  expect(
    (await request(admin + '/control', adminKey, { enabled: false })).status
  ).toBe(200);
  expect(
    await runtime.DB.prepare(
      'SELECT enabled FROM cd_artwork_control WHERE id=1'
    ).first('enabled')
  ).toBe(0);
});

it('requires admin authorization for an artwork reprocess batch', async () => {
  const response = await request(admin + '/reprocess', readKey, {
    album_ids: [1],
  });
  expect(response.status).toBe(403);
});
it('previews reprocessing by default without creating jobs, selections or checks', async () => {
  await runtime.DB.exec(
    'UPDATE cd_artwork_control SET automatic_enabled=1 WHERE id=1'
  );
  const response = await request(admin + '/reprocess', adminKey, {
    album_ids: [1],
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    dry_run: true,
    items: [{ album_id: 1, status: 'no_recorded_play' }],
  });
  expect(
    (await runtime.DB.prepare(
      'SELECT COUNT(*) n FROM cd_artwork_checks'
    ).first())!.n
  ).toBe(0);
});
it('rejects a reprocessing batch containing another owner album before mutation', async () => {
  await runtime.DB.exec(
    'UPDATE cd_artwork_control SET automatic_enabled=1 WHERE id=1'
  );
  const response = await request(admin + '/reprocess', adminKey, {
    album_ids: [1, 2],
    dry_run: false,
  });
  expect(response.status).toBe(404);
  expect(
    (await runtime.DB.prepare(
      'SELECT COUNT(*) n FROM cd_artwork_albums'
    ).first())!.n
  ).toBe(0);
});
