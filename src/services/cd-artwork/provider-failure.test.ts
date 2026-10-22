import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ArtworkEnv } from './types.js';
import {
  readProviderFailure,
  providerDiagnosticMessage,
  syncGenerationStatus,
  reconcileGenerationStatuses,
} from './provider-failure.js';
const runtime = env as typeof env & ArtworkEnv;
beforeAll(async () => applyD1Migrations(runtime.DB, runtime.TEST_MIGRATIONS));
beforeEach(async () => {
  vi.restoreAllMocks();
  await runtime.DB.exec(
    'DELETE FROM cd_artwork_events; DELETE FROM cd_artwork_checks; DELETE FROM cd_artwork_albums; DELETE FROM cd_artwork_jobs; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists;'
  );
  await runtime.DB.exec(
    "INSERT INTO lastfm_artists(id,user_id,name,created_at,updated_at) VALUES(1,1,'Synthetic artist','2026-01-01','2026-01-01'); INSERT INTO lastfm_albums(id,user_id,artist_id,name,created_at,updated_at) VALUES(1,1,1,'Synthetic album','2026-01-01','2026-01-01'); INSERT INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check,discovery_outcome) VALUES(1,1,'',1,'2099-01-01','generation_queued');"
  );
});
async function job(id: string, state = 'provider_failed', albumId = 1) {
  await runtime.DB.prepare(
    "INSERT INTO cd_artwork_jobs(id,user_id,album_id,state,input,source_hash,source_key,source_mime,provenance,error_code,automatic,created_at,updated_at) VALUES(?,1,?,?,'{}','hash','test/source','image/png','{}','provider_http_400',1,'2026-01-01','2026-01-01')"
  )
    .bind(id, albumId, state)
    .run();
}
async function outcome() {
  return runtime.DB.prepare(
    'SELECT discovery_outcome,next_check FROM cd_artwork_albums WHERE user_id=1 AND album_id=1'
  ).first<{ discovery_outcome: string; next_check: string }>();
}
it.each([
  [400, 'invalid_value'],
  [429, 'insufficient_quota'],
  [500, 'server_error'],
  [408, 'request_timeout'],
])('does not automatically retry HTTP %s / %s', async (status, code) => {
  const result = await readProviderFailure(
    Response.json({ error: { code } }, { status }),
    1
  );
  expect(result.retry_at).toBeNull();
});
it('retains only bounded diagnostic symbols even for malformed error bodies', async () => {
  const response = Response.json(
    {
      error: {
        code: 'invalid_value',
        type: 'invalid_request_error',
        param: 'image[0]',
        message: 'sensitive input',
        extra: 'credential',
      },
    },
    { status: 400, headers: { 'x-request-id': 'req_synthetic' } }
  );
  expect(await readProviderFailure(response, 1)).toEqual({
    status: 400,
    code: 'invalid_value',
    type: 'invalid_request_error',
    param: 'image[0]',
    request_id: 'req_synthetic',
    attempt: 1,
    private_message: 'sensitive input',
    retry_at: null,
  });
  const malformed = await readProviderFailure(
    new Response('not JSON', { status: 400 }),
    1
  );
  expect(malformed.code).toBeNull();
  expect(malformed.status).toBe(400);
  const oversized = await readProviderFailure(
    new Response('x'.repeat(17000), { status: 429 }),
    1
  );
  expect(oversized.retry_at).toBeNull();
});

it('bounds private operator detail and removes credentials, URLs and the input prompt', () => {
  const detail = providerDiagnosticMessage(
    'Invalid size. private-secret public test prompt sk-testkey123 rw_admin123 Bearer private-token https://example.com/?token=secret',
    'private-secret',
    'public test prompt'
  );
  expect(detail).toBe(
    'Invalid size. [redacted] [redacted] [redacted] [redacted] Bearer [redacted] [url]'
  );
  expect(providerDiagnosticMessage('x'.repeat(1000), '', '')?.length).toBe(500);
});
it('honors HTTP-date retry headers and holds excessive delays', async () => {
  const stamp = Date.parse('2026-01-01T00:00:00Z');
  const failure = () => ({ error: { code: 'rate_limit_exceeded' } });
  expect(
    (
      await readProviderFailure(
        Response.json(failure(), {
          status: 429,
          headers: { 'retry-after': 'Thu, 01 Jan 2026 00:05:00 GMT' },
        }),
        1,
        stamp
      )
    ).retry_at
  ).toBe('2026-01-01T00:05:00.000Z');
  expect(
    (
      await readProviderFailure(
        Response.json(failure(), {
          status: 429,
          headers: { 'retry-after': '999999' },
        }),
        1,
        stamp
      )
    ).retry_at
  ).toBeNull();
});
it('repairs legacy queued status without enqueueing generation or waiting a week', async () => {
  await job('old');
  const fetcher = vi.spyOn(globalThis, 'fetch');
  await reconcileGenerationStatuses(runtime);
  expect((await outcome())?.discovery_outcome).toBe('generation_failed');
  expect(Date.parse((await outcome())!.next_check)).toBeLessThan(
    Date.now() + 2 * 3600000
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it('an older job, foreign owner, pin or review hold cannot overwrite current status', async () => {
  await job('old');
  await job('new', 'queued');
  await syncGenerationStatus(runtime, 'old', 1);
  expect((await outcome())?.discovery_outcome).toBe('generation_queued');
  await runtime.DB.prepare(
    "UPDATE cd_artwork_jobs SET state='provider_unknown' WHERE id='new'"
  ).run();
  await syncGenerationStatus(runtime, 'new', 2);
  expect((await outcome())?.discovery_outcome).toBe('generation_queued');
  for (const flag of ['pinned', 'review_hold']) {
    await runtime.DB.prepare(`UPDATE cd_artwork_albums SET ${flag}=1`).run();
    await syncGenerationStatus(runtime, 'new', 1);
    expect((await outcome())?.discovery_outcome).toBe('generation_queued');
    await runtime.DB.prepare(`UPDATE cd_artwork_albums SET ${flag}=0`).run();
  }
  await syncGenerationStatus(runtime, 'new', 1);
  expect((await outcome())?.discovery_outcome).toBe('generation_unknown');
});

it.each(['provider_failed', 'provider_unknown'])(
  'repairs interrupted terminal status %s after rate-limit backoff',
  async (state) => {
    await job('retry', state);
    await runtime.DB.exec(
      "UPDATE cd_artwork_albums SET discovery_outcome='generation_retry_pending';"
    );
    await reconcileGenerationStatuses(runtime);
    expect((await outcome())?.discovery_outcome).toBe(
      state === 'provider_failed' ? 'generation_failed' : 'generation_unknown'
    );
  }
);

it('protected albums do not starve the bounded status repair batch', async () => {
  await job('repairable');
  for (let id = 2; id <= 21; id++) {
    await runtime.DB.prepare(
      "INSERT INTO lastfm_albums(id,user_id,artist_id,name,created_at,updated_at) VALUES(?,1,1,?,'2026-01-01','2026-01-01')"
    )
      .bind(id, `Protected synthetic ${id}`)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check,discovery_outcome,pinned) VALUES(1,?,'',1,'2099-01-01','generation_queued',1)"
    )
      .bind(id)
      .run();
    await job(`protected-${id}`, 'provider_failed', id);
  }
  await runtime.DB.exec(
    "UPDATE cd_artwork_jobs SET created_at='2090-01-01' WHERE id<>'repairable';"
  );
  await reconcileGenerationStatuses(runtime);
  expect((await outcome())?.discovery_outcome).toBe('generation_failed');
  expect(
    (
      await runtime.DB.prepare(
        "SELECT COUNT(*) n FROM cd_artwork_albums WHERE pinned=1 AND discovery_outcome='generation_queued'"
      ).first<{ n: number }>()
    )?.n
  ).toBe(20);
});
