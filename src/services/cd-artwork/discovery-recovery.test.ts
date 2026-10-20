import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ArtworkEnv } from './types.js';
import { recoverDiscoveryFailures } from './discovery-recovery.js';
import { DISCOVERY_POLICY } from './discovery-policy.js';
import { scheduledArtwork } from './scheduler.js';

const runtime = env as typeof env & ArtworkEnv;
beforeAll(async () => applyD1Migrations(runtime.DB, runtime.TEST_MIGRATIONS));
beforeEach(async () => {
  await runtime.DB.exec(
    'DELETE FROM cd_artwork_events; DELETE FROM cd_artwork_checks; DELETE FROM cd_artwork_albums; DELETE FROM cd_artwork_jobs; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists;'
  );
  await runtime.DB.exec(
    "UPDATE cd_artwork_control SET enabled=1,automatic_enabled=1,enroll_since='2000-01-01' WHERE id=1;"
  );
});
async function failure(
  id = 1,
  code = 'catalog_identity_unresolved',
  policy?: string
) {
  await runtime.DB.prepare(
    "INSERT INTO lastfm_artists(id,user_id,name,created_at,updated_at) VALUES(?,1,?,'2026-01-01','2026-01-01')"
  )
    .bind(id, `Synthetic ${id}`)
    .run();
  await runtime.DB.prepare(
    "INSERT INTO lastfm_albums(id,user_id,artist_id,name,created_at,updated_at) VALUES(?,1,?,?,'2026-01-01','2026-01-01')"
  )
    .bind(id, id, `Synthetic ${id}`)
    .run();
  await runtime.DB.prepare(
    "INSERT INTO lastfm_tracks(id,user_id,artist_id,album_id,name,created_at,updated_at) VALUES(?,1,?,?,?,'2026-01-01','2026-01-01')"
  )
    .bind(id, id, id, `Synthetic ${id}`)
    .run();
  // Admit through the real listening trigger, then model a completed old failure.
  await runtime.DB.prepare(
    'INSERT INTO lastfm_scrobbles(user_id,track_id,album_id,album_recorded,scrobbled_at,created_at) VALUES(1,?,?,1,?,?)'
  )
    .bind(id, id, new Date().toISOString(), new Date().toISOString())
    .run();
  await runtime.DB.prepare(
    "UPDATE cd_artwork_checks SET outcome='identity_required',completed_at='2026-01-01' WHERE album_id=?"
  )
    .bind(id)
    .run();
  await runtime.DB.prepare(
    "UPDATE cd_artwork_albums SET discovery_outcome='identity_required',discovery_evidence=?,last_checked_at='2026-01-01',next_check='2099-01-01' WHERE album_id=?"
  )
    .bind(
      JSON.stringify({ code, ...(policy ? { discovery_policy: policy } : {}) }),
      id
    )
    .run();
}
async function pending() {
  return (
    await runtime.DB.prepare(
      'SELECT album_id FROM cd_artwork_checks WHERE completed_at IS NULL ORDER BY album_id'
    ).all<{ album_id: number }>()
  ).results;
}
it('the normal scheduler admits a completed stale failure once without a new play, even during its old cooldown', async () => {
  await failure();
  const create = vi.fn(async () => ({}));
  const target = {
    ...runtime,
    CD_DISCOVERY: {
      create,
      get: vi.fn(async () => ({ status: async () => ({ status: 'running' }) })),
    },
  } as unknown as ArtworkEnv;
  await scheduledArtwork(target);
  expect(await pending()).toEqual([{ album_id: 1 }]);
  expect(create).toHaveBeenCalledTimes(1);
  const event = await runtime.DB.prepare(
    "SELECT details FROM cd_artwork_events WHERE action='discovery-policy-retry'"
  ).first<{ details: string }>();
  expect(JSON.parse(event!.details)).toMatchObject({
    policy: DISCOVERY_POLICY,
  });
  // Completing another failure must not re-admit it on every scheduled tick.
  await runtime.DB.exec(
    "UPDATE cd_artwork_checks SET completed_at='2026-01-02',outcome='identity_required' WHERE completed_at IS NULL;"
  );
  await scheduledArtwork(target);
  expect(await pending()).toEqual([]);
  expect(create).toHaveBeenCalledTimes(1);
});
it('overlapping schedulers produce one check and one policy event', async () => {
  await failure();
  await Promise.all([
    recoverDiscoveryFailures(runtime),
    recoverDiscoveryFailures(runtime),
  ]);
  expect(await pending()).toEqual([{ album_id: 1 }]);
  expect(
    (await runtime.DB.prepare(
      "SELECT COUNT(*) AS n FROM cd_artwork_events WHERE action='discovery-policy-retry'"
    ).first<{ n: number }>())!.n
  ).toBe(1);
});
it('bounds each run and skips already tried policies', async () => {
  for (let id = 1; id <= 4; id++) await failure(id);
  await failure(5, 'catalog_identity_unresolved', DISCOVERY_POLICY);
  await recoverDiscoveryFailures(runtime);
  expect(await pending()).toHaveLength(2);
  await recoverDiscoveryFailures(runtime);
  expect(await pending()).toHaveLength(4);
  expect((await pending()).some((row) => row.album_id === 5)).toBe(false);
});
it.each([
  'disabled',
  'automatic_disabled',
  'pinned',
  'review_hold',
  'hidden',
  'filtered',
  'conflict',
  'other_owner',
  'unattempted',
  'unknown_failure',
  'render_failure',
  'pending_job',
  'accepted',
])('preserves %s boundaries', async (mode) => {
  await failure();
  const changes: Record<string, string> = {
    disabled: 'UPDATE cd_artwork_control SET enabled=0',
    automatic_disabled: 'UPDATE cd_artwork_control SET automatic_enabled=0',
    pinned: 'UPDATE cd_artwork_albums SET pinned=1',
    review_hold: 'UPDATE cd_artwork_albums SET review_hold=1',
    hidden: "UPDATE cd_artwork_albums SET hidden_job='hidden'",
    filtered: 'UPDATE lastfm_artists SET is_filtered=1',
    conflict: 'UPDATE lastfm_albums SET identity_conflict=1',
    other_owner: 'UPDATE cd_artwork_albums SET user_id=2',
    unattempted: 'DELETE FROM cd_artwork_checks',
    unknown_failure:
      'UPDATE cd_artwork_albums SET discovery_evidence=\'{"code":"unknown"}\'',
    render_failure:
      'UPDATE cd_artwork_albums SET discovery_evidence=\'{"code":"automatic_quality_hold"}\'',
  };
  if (changes[mode]) await runtime.DB.exec(changes[mode]);
  else {
    await runtime.DB.prepare(
      "INSERT INTO cd_artwork_jobs(id,user_id,album_id,state,input,source_hash,source_key,source_mime,provenance,automatic,created_at,updated_at) VALUES('job',1,1,?,'{}','hash','key','image/png','{}',1,'2026-01-01','2026-01-01')"
    )
      .bind(mode === 'accepted' ? 'accepted' : 'queued')
      .run();
    if (mode === 'accepted')
      await runtime.DB.exec("UPDATE cd_artwork_albums SET active_job='job';");
  }
  await recoverDiscoveryFailures(runtime);
  expect(await pending()).toEqual([]);
  expect(
    (await runtime.DB.prepare(
      'SELECT COUNT(*) AS n FROM cd_artwork_events'
    ).first<{ n: number }>())!.n
  ).toBe(0);
});
