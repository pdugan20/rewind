import {
  env,
  applyD1Migrations,
  introspectWorkflowInstance,
} from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtworkEnv } from './types.js';
import { now } from './types.js';
import {
  checkListeningArtwork,
  dispatchListeningChecks,
  recoverListeningChecks,
} from './discovery.js';
import { scheduledArtwork } from './scheduler.js';
import { CdDiscoveryWorkflow } from '../../cd-artwork-worker.js';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { loadFilters } from '../lastfm/filters.js';
import { syncRecentScrobbles } from '../lastfm/sync.js';
import type { LastfmClient } from '../lastfm/client.js';
import { createDb } from '../../db/client.js';
import {
  afterListeningSync,
  notifyArtworkDiscovery,
} from '../../lib/artwork-notify.js';
import type { Env } from '../../types/env.js';
const runtime = env as typeof env & ArtworkEnv;
const RELEASE = 'e9b0f69e-ee3d-36ed-8c12-f8ee65f87e45';
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, runtime.TEST_MIGRATIONS);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await runtime.DB.exec(
    'DELETE FROM sync_runs; DELETE FROM cd_artwork_checks; DELETE FROM cd_artwork_albums; DELETE FROM cd_artwork_jobs; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists;'
  );
  await runtime.DB.exec(
    "UPDATE cd_artwork_control SET enabled=1,enroll_since='2020-01-01T00:00:00Z',provider_next_ms=0 WHERE id=1;"
  );
  await loadFilters(createDb(runtime.DB));
  for (const id of [1, 2]) {
    await runtime.DB.prepare(
      "INSERT INTO lastfm_artists(id,user_id,name,created_at,updated_at) VALUES(?,?, ?,'2026-01-01','2026-01-01')"
    )
      .bind(id, id, id === 1 ? 'Synthetic artist' : 'Other synthetic artist')
      .run();
    await runtime.DB.prepare(
      "INSERT INTO lastfm_albums(id,user_id,artist_id,name,created_at,updated_at) VALUES(?,?,?,'Synthetic album','2026-01-01','2026-01-01')"
    )
      .bind(id, id, id)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO lastfm_tracks(id,user_id,artist_id,album_id,name,created_at,updated_at) VALUES(?,?,?,?,'Synthetic track','2026-01-01','2026-01-01')"
    )
      .bind(id, id, id, id)
      .run();
  }
});
async function identity(id = 1) {
  await runtime.DB.prepare(
    "INSERT INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check) VALUES(?,?,?,1,'2099-01-01T00:00:00Z')"
  )
    .bind(id, id, RELEASE)
    .run();
}
async function play(user = 1, track = user, date = now()) {
  await runtime.DB.prepare(
    "INSERT INTO lastfm_scrobbles(user_id,track_id,scrobbled_at,created_at) VALUES(?,?,?,'2026-01-01')"
  )
    .bind(user, track, date)
    .run();
}
async function checks() {
  return (
    await runtime.DB.prepare(
      'SELECT * FROM cd_artwork_checks ORDER BY id'
    ).all<{
      id: number;
      dispatched_at: string | null;
      completed_at: string | null;
      outcome: string | null;
      recoveries: number;
    }>()
  ).results;
}
function provider(images: unknown[] = []) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
    String(url).includes('musicbrainz.org')
      ? Response.json({
          title: 'Synthetic album',
          media: [{ format: 'CD', position: 1 }],
          'artist-credit': [{ name: 'Synthetic artist' }],
        })
      : Response.json({ images })
  );
}
function dispatcher(
  create = vi.fn(async () => ({})),
  status = vi.fn(async () => ({ status: 'running' })),
  restart = vi.fn(async () => {})
) {
  return {
    ...runtime,
    CD_DISCOVERY: { create, get: vi.fn(async () => ({ status, restart })) },
  } as unknown as ArtworkEnv;
}
describe('play-triggered admission', () => {
  it('admits one known edition atomically with multiple new plays and ignores legacy monthly dates', async () => {
    await identity();
    await play();
    await play();
    expect(await checks()).toHaveLength(1);
    expect(
      (
        await runtime.DB.prepare(
          'SELECT COUNT(*) n FROM lastfm_scrobbles'
        ).first<{ n: number }>()
      )?.n
    ).toBe(2);
    expect(
      (
        await runtime.DB.prepare(
          'SELECT submitted_count FROM cd_artwork_control'
        ).first<{ submitted_count: number }>()
      )?.submitted_count
    ).toBe(0);
  });
  it('cooldown expiry creates no work until another play', async () => {
    await identity();
    await play();
    provider();
    await checkListeningArtwork(runtime, (await checks())[0].id);
    await play();
    expect(await checks()).toHaveLength(1);
    await runtime.DB.prepare(
      "UPDATE cd_artwork_albums SET next_check='2000-01-01T00:00:00Z' WHERE user_id=1 AND album_id=1"
    ).run();
    await scheduledArtwork(dispatcher());
    expect(await checks()).toHaveLength(1);
    await play();
    expect(await checks()).toHaveLength(2);
  });
  it('does not enqueue unknown editions or historical, filtered, mismatched-owner, disabled events', async () => {
    await play();
    expect(await checks()).toHaveLength(0);
    expect(
      (
        await runtime.DB.prepare(
          'SELECT discovery_outcome FROM cd_artwork_albums WHERE user_id=1 AND album_id=1'
        ).first<{ discovery_outcome: string }>()
      )?.discovery_outcome
    ).toBe('identity_required');
    await runtime.DB.prepare(
      'UPDATE cd_artwork_albums SET release_id=? WHERE user_id=1 AND album_id=1'
    )
      .bind(RELEASE)
      .run();
    await play(1, 1, '2019-01-01T00:00:00Z');
    await play(2, 1);
    await runtime.DB.exec(
      'UPDATE lastfm_artists SET is_filtered=1 WHERE id=1;'
    );
    await play();
    await runtime.DB.exec(
      'UPDATE lastfm_artists SET is_filtered=0 WHERE id=1; UPDATE cd_artwork_control SET enabled=0 WHERE id=1;'
    );
    await play();
    expect(await checks()).toHaveLength(0);
  });
  it('handles an explicitly registered second user without reading another user’s edition', async () => {
    await identity(2);
    await play(2);
    const rows = await runtime.DB.prepare(
      'SELECT user_id,album_id FROM cd_artwork_checks'
    ).all();
    expect(rows.results).toEqual([{ user_id: 2, album_id: 2 }]);
  });
  it('suppresses accepted retail art but still checks cover-derived art', async () => {
    await identity();
    await runtime.DB.prepare(
      "INSERT INTO cd_artwork_jobs(id,user_id,album_id,state,input,source_hash,source_key,source_mime,provenance,updated_at,created_at) VALUES('retail',1,1,'accepted',?, 'hash','key','image/png','{}',?,?)"
    )
      .bind(JSON.stringify({ source_kind: 'retail' }), now(), now())
      .run();
    await runtime.DB.exec(
      "UPDATE cd_artwork_albums SET active_job='retail' WHERE album_id=1 AND user_id=1;"
    );
    await play();
    expect(await checks()).toHaveLength(0);
    await runtime.DB.prepare(
      "UPDATE cd_artwork_jobs SET input=? WHERE id='retail'"
    )
      .bind(JSON.stringify({ source_kind: 'cover' }))
      .run();
    await play();
    expect(await checks()).toHaveLength(1);
  });
  it('rolls admission back together with a failed history transaction', async () => {
    await identity();
    await expect(
      runtime.DB.batch([
        runtime.DB.prepare(
          "INSERT INTO lastfm_scrobbles(user_id,track_id,scrobbled_at,created_at) VALUES(1,1,?,'2026-01-01')"
        ).bind(now()),
        runtime.DB.prepare('INSERT INTO definitely_missing_table VALUES(1)'),
      ])
    ).rejects.toThrow();
    expect(await checks()).toHaveLength(0);
    expect(
      (
        await runtime.DB.prepare(
          'SELECT COUNT(*) n FROM lastfm_scrobbles'
        ).first<{ n: number }>()
      )?.n
    ).toBe(0);
  });
});
describe('listening sync integration', () => {
  const client = (failSecondPage = false) => {
    // Repeated fetches represent the same upstream play, even across a second boundary.
    const eventTimestamp = String(Math.floor(Date.now() / 1000));
    return {
      getRecentTracks: async ({ page }: { page: number }) => {
        if (page === 2 && failSecondPage)
          throw new Error('synthetic upstream failure');
        return {
          recenttracks: {
            '@attr': { totalPages: failSecondPage ? '2' : '1' },
            track: [
              {
                artist: { mbid: '', '#text': 'Synthetic artist' },
                name: 'Synthetic track',
                mbid: '',
                album: { mbid: '', '#text': 'Synthetic album' },
                url: 'https://last.fm/synthetic',
                image: [],
                date: {
                  uts: eventTimestamp,
                  '#text': 'Synthetic timestamp',
                },
              },
            ],
          },
        };
      },
    } as unknown as LastfmClient;
  };
  it('real sync inserts one durable check and duplicate sync does not add another', async () => {
    await identity();
    const db = createDb(runtime.DB),
      source = client();
    expect((await syncRecentScrobbles(db, source)).count).toBe(1);
    expect((await syncRecentScrobbles(db, source)).count).toBe(0);
    expect(await checks()).toHaveLength(1);
  });
  it('a partially failed sync preserves the admitted play and pending check', async () => {
    await identity();
    await expect(
      syncRecentScrobbles(createDb(runtime.DB), client(true))
    ).rejects.toThrow('synthetic upstream failure');
    expect(await checks()).toHaveLength(1);
    expect((await checks())[0].dispatched_at).toBeNull();
  });
});
describe('durable discovery and recovery', () => {
  it('records discovery and cooldown without changing history, active artwork, generation or budget', async () => {
    await identity();
    await play();
    provider([
      {
        id: 9,
        types: ['Medium'],
        image: 'https://coverartarchive.org/synthetic.png',
      },
    ]);
    expect(
      (await checkListeningArtwork(runtime, (await checks())[0].id)).outcome
    ).toBe('found');
    const row = await runtime.DB.prepare(
      'SELECT active_job,next_check,last_checked_at FROM cd_artwork_albums WHERE user_id=1 AND album_id=1'
    ).first<{
      active_job: null;
      next_check: string;
      last_checked_at: string;
    }>();
    expect(row?.active_job).toBeNull();
    expect(
      Date.parse(row!.next_check) - Date.parse(row!.last_checked_at)
    ).toBeGreaterThanOrEqual(7 * 86400000 - 20);
    expect((await checks())[0].completed_at).not.toBeNull();
    expect(
      (
        await runtime.DB.prepare(
          'SELECT COUNT(*) n FROM cd_artwork_jobs'
        ).first<{ n: number }>()
      )?.n
    ).toBe(0);
    expect(
      (
        await runtime.DB.prepare(
          'SELECT submitted_count FROM cd_artwork_control'
        ).first<{ submitted_count: number }>()
      )?.submitted_count
    ).toBe(0);
  });
  it('honors Retry-After without completing pending work prematurely', async () => {
    await identity();
    await play();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 429, headers: { 'Retry-After': '7200' } })
    );
    expect(
      await checkListeningArtwork(runtime, (await checks())[0].id)
    ).toEqual({ outcome: 'error', retryAfter: 7200 });
    expect((await checks())[0].completed_at).toBeNull();
  });
  it('cancels stale identity, disabled and newly approved retail work before provider calls', async () => {
    await identity();
    await play();
    await runtime.DB.prepare(
      'UPDATE cd_artwork_albums SET release_id=? WHERE user_id=1 AND album_id=1'
    )
      .bind('replacement-edition')
      .run();
    const fetcher = vi.spyOn(globalThis, 'fetch');
    expect(
      (await checkListeningArtwork(runtime, (await checks())[0].id)).outcome
    ).toBe('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('leaves outbox pending after dispatch failure and retries with the same instance ID', async () => {
    await identity();
    await play();
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({});
    const status = vi.fn().mockRejectedValue(new Error('not found'));
    const target = dispatcher(create, status);
    await dispatchListeningChecks(target);
    expect((await checks())[0].dispatched_at).toBeNull();
    await dispatchListeningChecks(target);
    expect((await checks())[0].dispatched_at).not.toBeNull();
    expect(create.mock.calls[0][0]).toEqual(create.mock.calls[1][0]);
  });
  it('recovers a lost create response by verifying the existing instance', async () => {
    await identity();
    await play();
    const create = vi.fn().mockRejectedValue(new Error('response lost'));
    const status = vi.fn(async () => ({ status: 'running' }));
    await dispatchListeningChecks(dispatcher(create, status));
    expect(status).toHaveBeenCalledOnce();
    expect((await checks())[0].dispatched_at).not.toBeNull();
  });
  it('recreates a missing dispatched instance even when get itself rejects', async () => {
    await identity();
    await play();
    const target = dispatcher();
    await dispatchListeningChecks(target);
    const create = vi.fn(async () => ({}));
    const missing = {
      ...runtime,
      CD_DISCOVERY: {
        create,
        get: vi.fn().mockRejectedValue(new Error('instance missing')),
      },
    } as unknown as ArtworkEnv;
    await recoverListeningChecks(missing);
    expect(create).toHaveBeenCalledWith({
      id: `cd-discovery-${(await checks())[0].id}`,
      params: { checkId: (await checks())[0].id },
    });
    expect((await checks())[0].completed_at).toBeNull();
  });
  it('only restarts errored admitted instances, bounded to two recoveries', async () => {
    await identity();
    await play();
    const target = dispatcher(
      vi.fn(async () => ({})),
      vi.fn(async () => ({ status: 'errored' }))
    );
    const restart = (await target.CD_DISCOVERY.get('unused')).restart;
    await recoverListeningChecks(target);
    await recoverListeningChecks(target);
    await recoverListeningChecks(target);
    expect(restart).toHaveBeenCalledTimes(2);
    expect((await checks())[0].recoveries).toBe(2);
    expect((await checks())[0].completed_at).not.toBeNull();
  });
  it('Workflow bounds provider retries with exponential delays and closes exhausted work', async () => {
    await identity();
    await play();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 503 })
    );
    const sleep = vi.fn(async (_name: string, _duration: number) => {});
    const step = {
      do: async (
        _name: string,
        configOrCallback: unknown,
        callback?: () => Promise<unknown>
      ) => (callback ?? (configOrCallback as () => Promise<unknown>))(),
      sleep,
    } as unknown as WorkflowStep;
    await CdDiscoveryWorkflow.prototype.run.call(
      { env: runtime } as unknown as CdDiscoveryWorkflow,
      { payload: { checkId: (await checks())[0].id } } as WorkflowEvent<{
        checkId: number;
      }>,
      step
    );
    expect(sleep.mock.calls.map((c) => c[1])).toEqual([
      3600000, 7200000, 14400000,
    ]);
    expect((await checks())[0].outcome).toBe('error');
    expect((await checks())[0].completed_at).not.toBeNull();
  });
  it('dispatches and completes an actual runtime Workflow with discovery-only provider requests', async () => {
    await identity();
    await play();
    const checkId = (await checks())[0].id;
    const fetcher = provider();
    await using instance = await introspectWorkflowInstance(
      runtime.CD_DISCOVERY,
      `cd-discovery-${checkId}`
    );
    await dispatchListeningChecks(runtime);
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toEqual({
      outcome: 'not_found',
      retryAfter: 0,
    });
    expect((await checks())[0].completed_at).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('empty successful syncs do not poll; new plays and partially failed syncs notify', async () => {
    const pending: Promise<unknown>[] = [];
    const target = {
      CD_ARTWORK: { dispatchPending: vi.fn(async () => {}) },
    } as unknown as Env;
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
    await afterListeningSync(target, ctx, Promise.resolve({ itemsSynced: 0 }));
    expect(target.CD_ARTWORK!.dispatchPending).not.toHaveBeenCalled();
    await afterListeningSync(target, ctx, Promise.resolve({ itemsSynced: 1 }));
    await expect(
      afterListeningSync(
        target,
        ctx,
        Promise.reject(new Error('partial sync failure'))
      )
    ).rejects.toThrow('partial sync failure');
    await Promise.all(pending);
    expect(target.CD_ARTWORK!.dispatchPending).toHaveBeenCalledTimes(2);
  });
  it('notification failure cannot fail listening sync and never runs providers inline', async () => {
    const pending: Promise<unknown>[] = [];
    const target = {
      CD_ARTWORK: {
        dispatchPending: vi.fn().mockRejectedValue(new Error('offline')),
      },
    } as unknown as Env;
    expect(() =>
      notifyArtworkDiscovery(target, { waitUntil: (p) => pending.push(p) })
    ).not.toThrow();
    await expect(Promise.all(pending)).resolves.toEqual([undefined]);
  });
});
