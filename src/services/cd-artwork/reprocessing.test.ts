import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, it, expect } from 'vitest';
import type { ArtworkEnv } from './types.js';
import {
  queueArtworkReprocessing,
  recoverOutdatedArtwork,
} from './reprocessing.js';
import { PROCESSOR_HASH } from './processor-version.js';
import { VERIFICATION_POLICY } from './automatic.js';
import { HUB_POLICY } from './rendering.js';
const runtime = env as typeof env & ArtworkEnv;
const hash = 'a'.repeat(64),
  jobId = 'b'.repeat(64),
  sourceHash = 'c'.repeat(64);
beforeAll(async () => applyD1Migrations(runtime.DB, runtime.TEST_MIGRATIONS));
beforeEach(async () => {
  await runtime.DB.exec(
    'DELETE FROM cd_artwork_events; DELETE FROM cd_artwork_checks; DELETE FROM cd_artwork_albums; DELETE FROM cd_artwork_jobs; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists;'
  );
  await runtime.DB.exec(
    "UPDATE cd_artwork_control SET enabled=1,automatic_enabled=1,enroll_since='2099-01-01' WHERE id=1; INSERT INTO lastfm_artists(id,user_id,name,created_at,updated_at) VALUES(1,1,'Test artist','2026-01-01','2026-01-01'),(2,2,'Other artist','2026-01-01','2026-01-01'); INSERT INTO lastfm_albums(id,user_id,artist_id,name,created_at,updated_at) VALUES(1,1,1,'Test album','2026-01-01','2026-01-01'),(2,2,2,'Other album','2026-01-01','2026-01-01'); INSERT INTO lastfm_tracks(id,user_id,artist_id,album_id,name,created_at,updated_at) VALUES(1,1,1,1,'Test track','2026-01-01','2026-01-01'); INSERT INTO lastfm_scrobbles(user_id,track_id,album_id,album_recorded,scrobbled_at,created_at) VALUES(1,1,1,1,'2026-01-01','2026-01-01');"
  );
});
async function seed({
  current = false,
  held = false,
  processor = 'old-processor',
} = {}) {
  const p = current
    ? {
        processorHash: processor,
        verificationPolicy: VERIFICATION_POLICY,
        hubPolicy: HUB_POLICY,
        verifiedCandidateHash: hash,
        verifiedMaterialHash: hash,
        verifiedSourceHash: sourceHash,
        normalization: { outerEdge: { width: 10, printRadius: 470 } },
        automaticVerification: {
          confidence: 'high',
          artwork_preserved: true,
          lettering_preserved: true,
          no_invented_content: true,
          no_visible_defects: true,
          concentric_geometry: true,
          material_preserved: true,
          retail_source_supported: true,
          no_added_rim_effects: true,
        },
      }
    : { processorHash: processor };
  await runtime.DB.prepare(
    "INSERT INTO cd_artwork_jobs(id,user_id,album_id,state,input,source_hash,source_key,source_mime,candidate_hash,provenance,automatic,validation_state,error_code,created_at,updated_at) VALUES(?,1,1,?,?,?,?,?,?,?,1,?,?, '2026-01-01','2026-01-01')"
  )
    .bind(
      jobId,
      held ? 'needs_registration' : 'accepted',
      JSON.stringify({ source_kind: 'retail' }),
      sourceHash,
      'private-source',
      'image/png',
      held ? null : hash,
      JSON.stringify(p),
      held ? 'held' : 'passed',
      held ? 'automatic_geometry_hold' : null
    )
    .run();
  await runtime.DB.prepare(
    "INSERT INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check,active_job) VALUES(1,1,'',1,'2099-01-01',?)"
  )
    .bind(held ? null : jobId)
    .run();
}
async function count(table: string) {
  return (await runtime.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{
    n: number;
  }>())!.n;
}
it('replaces only a reset check admitted by an older processor', async () => {
  await seed({ held: true });
  const old = await runtime.DB.prepare(
    "INSERT INTO cd_artwork_checks(user_id,album_id,release_id,medium_position) VALUES(1,1,'',1) RETURNING id"
  ).first<{ id: number }>();
  await runtime.DB.prepare(
    "INSERT INTO cd_artwork_events(user_id,album_id,job_id,action,reviewer,created_at,details) VALUES(1,1,?,'automatic-reprocess-requested','owner-requested-pipeline-reset','2026-01-01',?)"
  )
    .bind(jobId, JSON.stringify({ processorHash: 'older', checkId: old!.id }))
    .run();
  expect((await queueArtworkReprocessing(runtime, 1, [1], true)).items).toEqual(
    [{ album_id: 1, status: 'would_queue' }]
  );
  expect(
    (await queueArtworkReprocessing(runtime, 1, [1], false)).items
  ).toEqual([{ album_id: 1, status: 'queued' }]);
  expect(
    (
      await runtime.DB.prepare(
        'SELECT outcome FROM cd_artwork_checks WHERE id=?'
      )
        .bind(old!.id)
        .first<{ outcome: string }>()
    )?.outcome
  ).toBe('processor_replaced');
  const pending = await runtime.DB.prepare(
    'SELECT id FROM cd_artwork_checks WHERE completed_at IS NULL'
  ).first<{ id: number }>();
  expect(pending?.id).not.toBe(old!.id);
});
it('does not replace an ordinary pending listening check without a processor marker', async () => {
  await seed({ held: true });
  await runtime.DB.exec(
    "INSERT INTO cd_artwork_checks(user_id,album_id,release_id,medium_position) VALUES(1,1,'',1);"
  );
  expect(
    (await queueArtworkReprocessing(runtime, 1, [1], false)).items
  ).toEqual([{ album_id: 1, status: 'already_queued' }]);
  expect(await count('cd_artwork_checks')).toBe(1);
});
it('previews an outdated selected disc without changing selection, history or outbox', async () => {
  await seed();
  const before = await count('lastfm_scrobbles');
  expect(
    (await queueArtworkReprocessing(runtime, 1, [1])).items[0].status
  ).toBe('would_queue');
  expect(
    (await runtime.DB.prepare(
      'SELECT active_job FROM cd_artwork_albums'
    ).first<{ active_job: string }>())!.active_job
  ).toBe(jobId);
  expect(await count('cd_artwork_checks')).toBe(0);
  expect(await count('lastfm_scrobbles')).toBe(before);
});
it('withdraws outdated selection and queues discovery without accepting or deleting any image', async () => {
  await seed();
  await queueArtworkReprocessing(runtime, 1, [1], false);
  const album = await runtime.DB.prepare(
    'SELECT active_job,hidden_job,review_hold FROM cd_artwork_albums'
  ).first();
  expect(album).toMatchObject({
    active_job: null,
    hidden_job: jobId,
    review_hold: 0,
  });
  expect(await count('cd_artwork_checks')).toBe(1);
  expect(await count('lastfm_scrobbles')).toBe(1);
  expect(
    (await runtime.DB.prepare('SELECT state FROM cd_artwork_jobs').first())!
      .state
  ).toBe('accepted');
  expect(await count('cd_artwork_events')).toBe(1);
});
it('concurrent resets and retries admit only one durable check', async () => {
  await seed();
  await Promise.all([
    queueArtworkReprocessing(runtime, 1, [1], false),
    queueArtworkReprocessing(runtime, 1, [1], false),
  ]);
  await queueArtworkReprocessing(runtime, 1, [1], false);
  expect(await count('cd_artwork_checks')).toBe(1);
  expect(await count('cd_artwork_events')).toBe(1);
});
it.each([VERIFICATION_POLICY, 'source-shaped-hub-material-fidelity-v8'])(
  'preserves accepted shared-policy artwork under %s',
  async (policy) => {
    await seed({ current: true });
    await runtime.DB.prepare(
      "UPDATE cd_artwork_jobs SET provenance=json_set(provenance,'$.verificationPolicy',?)"
    )
      .bind(policy)
      .run();
    expect(
      (await queueArtworkReprocessing(runtime, 1, [1], false)).items[0].status
    ).toBe('current_artwork');
    expect(await count('cd_artwork_checks')).toBe(0);
  }
);
it.each(['pinned', 'review_hold'])('preserves %s decisions', async (flag) => {
  await seed();
  await runtime.DB.exec(`UPDATE cd_artwork_albums SET ${flag}=1`);
  expect(
    (await queueArtworkReprocessing(runtime, 1, [1], false)).items[0].status
  ).toBe(flag);
  expect(await count('cd_artwork_checks')).toBe(0);
});
it('preflights the entire batch ownership before clearing earlier entries', async () => {
  await seed();
  await expect(
    queueArtworkReprocessing(runtime, 1, [1, 2], false)
  ).rejects.toThrow('album_not_found');
  expect(
    (await runtime.DB.prepare(
      'SELECT active_job FROM cd_artwork_albums'
    ).first())!.active_job
  ).toBe(jobId);
});
it('requires automatic opt-in and the intended owner', async () => {
  await seed();
  await runtime.DB.exec('UPDATE cd_artwork_control SET automatic_enabled=0');
  await expect(
    queueArtworkReprocessing(runtime, 1, [1], false)
  ).rejects.toThrow('automatic_processing_disabled');
  await expect(
    queueArtworkReprocessing(runtime, 2, [2], false)
  ).rejects.toThrow('automatic_processing_disabled');
  expect(await count('cd_artwork_checks')).toBe(0);
});
it('enrolls only a requested existing historical album, without a synthetic play', async () => {
  await queueArtworkReprocessing(runtime, 1, [1], false);
  expect(await count('cd_artwork_albums')).toBe(1);
  expect(await count('cd_artwork_checks')).toBe(1);
  expect(await count('lastfm_scrobbles')).toBe(1);
});
it('does not admit a requested album without a recorded play', async () => {
  await runtime.DB.exec('DELETE FROM lastfm_scrobbles');
  expect(
    (await queueArtworkReprocessing(runtime, 1, [1], false)).items[0].status
  ).toBe('no_recorded_play');
  expect(await count('cd_artwork_albums')).toBe(0);
});
it('recovers older failed work through discovery once, never loops current-policy failures', async () => {
  await seed({ held: true });
  await recoverOutdatedArtwork(runtime);
  expect(await count('cd_artwork_checks')).toBe(1);
  await runtime.DB.exec('DELETE FROM cd_artwork_checks');
  await runtime.DB.prepare(
    "UPDATE cd_artwork_jobs SET provenance=json_set(provenance,'$.processorHash',?)"
  )
    .bind(PROCESSOR_HASH)
    .run();
  await recoverOutdatedArtwork(runtime);
  expect(await count('cd_artwork_checks')).toBe(0);
});

it('does not withdraw a selection when current processing starts after preflight', async () => {
  await seed();
  let injected = false;
  const target = {
    ...runtime,
    DB: new Proxy(runtime.DB, {
      get(db, key) {
        if (key === 'batch')
          return async (statements: Parameters<typeof db.batch>[0]) => {
            if (!injected) {
              injected = true;
              await db
                .prepare(
                  "INSERT INTO cd_artwork_jobs(id,user_id,album_id,state,input,source_hash,source_key,source_mime,provenance,automatic,created_at,updated_at) VALUES(?,1,1,'queued',?,?,?,?,?,1,'2026-01-01','2026-01-01')"
                )
                .bind(
                  'd'.repeat(64),
                  JSON.stringify({ source_kind: 'retail' }),
                  sourceHash,
                  'source',
                  'image/png',
                  JSON.stringify({ processorHash: PROCESSOR_HASH })
                )
                .run();
            }
            return db.batch(statements);
          };
        const value = Reflect.get(db, key);
        return typeof value === 'function' ? value.bind(db) : value;
      },
    }),
  } as ArtworkEnv;
  expect(
    (await queueArtworkReprocessing(target, 1, [1], false)).items[0].status
  ).toBe('state_changed');
  expect(
    (await runtime.DB.prepare(
      'SELECT active_job FROM cd_artwork_albums'
    ).first())!.active_job
  ).toBe(jobId);
  expect(await count('cd_artwork_checks')).toBe(0);
});

it('preserves the original held decision and admits only one recovery if discovery fails', async () => {
  await seed({ held: true });
  await recoverOutdatedArtwork(runtime);
  expect(
    (await runtime.DB.prepare(
      'SELECT error_code FROM cd_artwork_jobs WHERE id=?'
    )
      .bind(jobId)
      .first())!.error_code
  ).toBe('automatic_geometry_hold');
  await runtime.DB.exec(
    "UPDATE cd_artwork_checks SET completed_at='2026-01-02',outcome='source_unavailable'"
  );
  await recoverOutdatedArtwork(runtime);
  await recoverOutdatedArtwork(runtime);
  expect(await count('cd_artwork_checks')).toBe(1);
});
