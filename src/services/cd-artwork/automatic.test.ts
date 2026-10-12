import {
  env,
  applyD1Migrations,
  introspectWorkflowInstance,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { ArtworkEnv, Job } from './types.js';
import { now } from './types.js';
import { artworkApp } from '../../cd-artwork-worker.js';
import { createTestApiKey } from '../../test-helpers.js';
import { clearAuthCache } from '../../lib/auth.js';
import {
  ownedAlbum,
  dispatch,
  enqueue,
  claimSubmission,
  getJob,
  approvedArtwork,
} from './store.js';
import { selectAutomaticSource, verifiedCover } from './selection.js';
import { ArtworkError } from './sources.js';
import { checkListeningArtwork } from './discovery.js';
import { generateOnce, processRaw } from './generation.js';
import { publishAutomatic } from './automatic.js';
import { saveFeedback, feedbackSchema } from './feedback.js';
import { png } from '../../../scripts/cd-artwork/pixels.mjs';
const runtime = env as typeof env & ArtworkEnv;
const RELEASE = '11111111-1111-4111-8111-111111111111';
const verdict = {
  confidence: 'high',
  artwork_preserved: true,
  lettering_preserved: true,
  no_invented_content: true,
  no_visible_defects: true,
  material_confident: true,
  material_inner: 64,
  material_outer: 108,
  material_opacity: 0.45,
};
function disc() {
  const data = new Uint8Array(1024 * 1024 * 4).fill(255);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512);
      if (r >= 60 && r <= 480) data.set([75, 90, 105, 255], (y * 1024 + x) * 4);
    }
  return png({ width: 1024, height: 1024, data });
}
const bytes = disc();
const lookup = {
  results: [
    {
      wrapperType: 'collection',
      collectionId: 123,
      collectionName: 'Synthetic album',
      artistName: 'Synthetic artist',
      artworkUrl100: 'https://is1-ssl.mzstatic.com/synthetic/100x100bb.jpg',
    },
    {
      wrapperType: 'track',
      collectionId: 123,
      artistName: 'Synthetic artist',
      trackName: 'Synthetic song',
    },
  ],
};
const appleAlbum = {
  id: '123',
  attributes: {
    name: 'Synthetic album',
    artistName: 'Synthetic artist',
    artwork: { url: 'https://is1-ssl.mzstatic.com/synthetic/{w}x{h}bb.jpg' },
  },
  relationships: {
    tracks: {
      data: [
        {
          id: '456',
          attributes: {
            name: 'Synthetic song',
            artistName: 'Synthetic artist',
          },
        },
      ],
    },
  },
};
function providers({
  retail = false,
  verdictOverride = {},
  failVerifier = false,
  searchAmbiguous = false,
  missingRetail = false,
} = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    // Source tests exercise selection, not wall-clock provider throttling.
    await runtime.DB.prepare(
      'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1'
    ).run();
    const u = String(url);
    if (u.includes('/responses'))
      return failVerifier
        ? new Response('', { status: 503 })
        : Response.json({
            status: 'completed',
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify({ ...verdict, ...verdictOverride }),
                  },
                ],
              },
            ],
          });
    if (u.includes('/images/edits')) {
      let binary = '';
      for (let i = 0; i < bytes.length; i++)
        binary += String.fromCharCode(bytes[i]);
      return Response.json({ data: [{ b64_json: btoa(binary) }] });
    }
    if (missingRetail && u.endsWith('synthetic.png'))
      return new Response('', { status: 404 });
    if (u.includes('mzstatic.com') || u.endsWith('synthetic.png'))
      return new Response(new Uint8Array(bytes), {
        headers: { 'Content-Type': 'image/png' },
      });
    if (u.includes('itunes.apple.com/search'))
      return Response.json({
        results: searchAmbiguous
          ? [
              { ...lookup.results[0] },
              { ...lookup.results[0], collectionId: 124 },
            ]
          : [lookup.results[0]],
      });
    if (u.includes('itunes.apple.com/lookup')) return Response.json(lookup);
    if (u.includes('/release/?'))
      return Response.json({
        releases: retail
          ? [
              {
                id: RELEASE,
                title: 'Synthetic album',
                status: 'Official',
                'artist-credit': [{ name: 'Synthetic artist' }],
              },
            ]
          : [],
      });
    if (u.includes('musicbrainz.org'))
      return Response.json({
        id: RELEASE,
        title: 'Synthetic album',
        media: [{ format: 'CD', position: 1 }],
        'artist-credit': [{ name: 'Synthetic artist' }],
      });
    if (u.includes('coverartarchive.org'))
      return Response.json({
        images: retail
          ? [
              {
                id: 9,
                approved: true,
                types: ['Medium'],
                image: 'https://coverartarchive.org/synthetic.png',
              },
            ]
          : [],
      });
    throw new Error(`Unexpected synthetic provider ${u} ${init?.method}`);
  });
}
beforeAll(async () => applyD1Migrations(runtime.DB, runtime.TEST_MIGRATIONS));
beforeEach(async () => {
  vi.restoreAllMocks();
  clearAuthCache();
  await runtime.DB.exec('DELETE FROM api_keys;');
  for (const bucket of [runtime.ARTWORK, runtime.IMAGES]) {
    const objects = await bucket.list();
    if (objects.objects.length)
      await bucket.delete(objects.objects.map((o) => o.key));
  }
  await runtime.DB.exec(
    'DELETE FROM cd_artwork_events; DELETE FROM cd_artwork_checks; DELETE FROM cd_artwork_albums; DELETE FROM cd_artwork_jobs; DELETE FROM lastfm_scrobbles; DELETE FROM lastfm_tracks; DELETE FROM lastfm_albums; DELETE FROM lastfm_artists;'
  );
  await runtime.DB.prepare(
    "UPDATE cd_artwork_control SET enabled=1,automatic_enabled=1,daily_limit=3,submitted_count=0,budget_day='',provider_next_ms=0,enroll_since='2020-01-01' WHERE id=1"
  ).run();
  await runtime.DB.exec(
    "INSERT INTO lastfm_artists(id,user_id,name,created_at,updated_at) VALUES(1,1,'Synthetic artist','2026-01-01','2026-01-01'); INSERT INTO lastfm_albums(id,user_id,artist_id,name,apple_music_id,created_at,updated_at) VALUES(1,1,1,'Synthetic album','123','2026-01-01','2026-01-01'); INSERT INTO lastfm_tracks(id,user_id,artist_id,album_id,name,created_at,updated_at) VALUES(1,1,1,1,'Synthetic song','2026-01-01','2026-01-01');"
  );
});
afterEach(() => vi.restoreAllMocks());
async function play() {
  await runtime.DB.prepare(
    'INSERT INTO lastfm_scrobbles(user_id,track_id,album_id,album_recorded,scrobbled_at,created_at) VALUES(1,1,1,1,?,?)'
  )
    .bind(now(), now())
    .run();
}
async function selected(retail = false) {
  await play();
  const album = await ownedAlbum(runtime, 1, 1);
  const source = await selectAutomaticSource(
    runtime,
    1,
    1,
    album,
    retail ? RELEASE : '',
    1
  );
  return (
    await enqueue(runtime, source.request, 1, false, {
      source,
      expectedActiveJob: null,
      catalogIdentity: album,
    })
  ).job;
}
const withKey = () =>
  ({ ...runtime, OPENAI_API_KEY: 'synthetic-test-key' }) as ArtworkEnv;
it('admits a new album with no CD identity exactly once and selects its verified cover', async () => {
  providers();
  await play();
  await play();
  const rows = await runtime.DB.prepare('SELECT * FROM cd_artwork_checks').all<{
    id: number;
    release_id: string;
  }>();
  expect(rows.results).toHaveLength(1);
  expect(rows.results[0].release_id).toBe('');
  const target = {
    ...runtime,
    CD_WORKFLOW: { create: vi.fn(async () => ({})) },
  } as unknown as ArtworkEnv;
  expect(await checkListeningArtwork(target, rows.results[0].id)).toEqual({
    outcome: 'generation_queued',
    retryAfter: 0,
  });
  const jobs = await runtime.DB.prepare(
    'SELECT * FROM cd_artwork_jobs'
  ).all<Job>();
  expect(jobs.results).toHaveLength(1);
  expect(JSON.parse(jobs.results[0].input)).toMatchObject({
    release_id: null,
    medium_position: null,
    source_kind: 'cover',
  });
  expect(jobs.results[0].automatic).toBe(1);
});
it.each([false, true])(
  'generates, verifies and publishes the %s retail path without manual approval',
  async (retail) => {
    const fetcher = providers({ retail });
    const job = await selected(retail);
    expect(job.state).toBe('queued');
    const target = withKey();
    expect((await generateOnce(target, job.id, 1)).rawKey).toBeTruthy();
    expect((await processRaw(target, job.id, 1)).state).toBe('pending');
    expect((await publishAutomatic(target, job.id, 1)).state).toBe('accepted');
    expect((await approvedArtwork(target, [1], 1))[0]).toMatchObject({
      source_kind: retail ? 'retail' : 'cover',
      release_id: retail ? RELEASE : null,
      review: 'accepted',
    });
    await publishAutomatic(target, job.id, 1);
    await processRaw(target, job.id, 1);
    expect(
      fetcher.mock.calls.filter(([u]) => String(u).includes('/images/edits'))
    ).toHaveLength(1);
    expect(
      fetcher.mock.calls.filter(([u]) => String(u).includes('/responses'))
    ).toHaveLength(retail ? 2 : 1);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM cd_artwork_events WHERE action='automatically-accepted-and-activated'"
        ).first<{ n: number }>()
      )?.n
    ).toBe(1);
  }
);
it.each([
  { confidence: 'uncertain' },
  { lettering_preserved: false },
  { no_invented_content: false },
  { no_visible_defects: false },
])('holds visual defects or uncertainty: %j', async (verdictOverride) => {
  providers({ verdictOverride });
  const job = await selected();
  const target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  expect((await getJob(target, job.id, 1))?.validation_state).toBe('held');
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('held');
  expect(await approvedArtwork(target, [1], 1)).toEqual([]);
});
it('retail material uncertainty stays private', async () => {
  providers({ retail: true, verdictOverride: { material_confident: false } });
  const job = await selected(true),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('held');
});
it('a lost verifier response cannot pay for repeated verification or generation', async () => {
  const fetcher = providers({ failVerifier: true });
  const job = await selected(),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  await processRaw(target, job.id, 1);
  await generateOnce(target, job.id, 1);
  expect(
    fetcher.mock.calls.filter(([u]) => String(u).includes('/responses'))
  ).toHaveLength(1);
  expect(
    fetcher.mock.calls.filter(([u]) => String(u).includes('/images/edits'))
  ).toHaveLength(1);
});
it.each(['identity', 'pin', 'disable', 'filter', 'active'])(
  'holds publication after a concurrent %s change',
  async (change) => {
    providers();
    const job = await selected(),
      target = withKey();
    await generateOnce(target, job.id, 1);
    await processRaw(target, job.id, 1);
    if (change === 'identity')
      await runtime.DB.exec(
        'UPDATE lastfm_albums SET identity_conflict=1 WHERE id=1;'
      );
    if (change === 'pin')
      await runtime.DB.exec(
        'UPDATE cd_artwork_albums SET pinned=1 WHERE album_id=1;'
      );
    if (change === 'disable')
      await runtime.DB.exec(
        'UPDATE cd_artwork_control SET automatic_enabled=0 WHERE id=1;'
      );
    if (change === 'filter')
      await runtime.DB.exec(
        'UPDATE lastfm_albums SET is_filtered=1 WHERE id=1;'
      );
    if (change === 'active')
      await runtime.DB.prepare(
        "INSERT INTO cd_artwork_jobs(id,user_id,album_id,state,input,source_hash,source_key,source_mime,provenance,updated_at,created_at) SELECT 'replacement',user_id,album_id,'accepted',input,source_hash,source_key,source_mime,provenance,updated_at,created_at FROM cd_artwork_jobs WHERE id=?"
      )
        .bind(job.id)
        .run()
        .then(() =>
          runtime.DB.exec(
            "UPDATE cd_artwork_albums SET active_job='replacement' WHERE album_id=1;"
          )
        );
    expect((await publishAutomatic(target, job.id, 1)).state).toBe('held');
    expect((await getJob(target, job.id, 1))?.state).toBe(
      change === 'disable' ? 'pending' : 'needs_registration'
    );
  }
);
it('budget and duplicate submission are atomic for automatic work', async () => {
  providers();
  const job = await selected();
  expect(
    await Promise.all([
      claimSubmission(runtime, job),
      claimSubmission(runtime, job),
    ])
  ).toEqual([true, false]);
  expect(
    (
      await runtime.DB.prepare(
        'SELECT submitted_count n FROM cd_artwork_control'
      ).first<{ n: number }>()
    )?.n
  ).toBe(1);
});
it('a human revision flag wins during the final publication transaction without stranding the candidate', async () => {
  providers();
  const job = await selected(),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  const batch = runtime.DB.batch.bind(runtime.DB);
  vi.spyOn(runtime.DB, 'batch').mockImplementationOnce(async (statements) => {
    await saveFeedback(
      runtime,
      job.id,
      1,
      feedbackSchema.parse({ status: 'needs_revision', reason: 'lettering' }),
      'test-owner'
    );
    return batch(statements);
  });
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('held');
  expect((await getJob(target, job.id, 1))?.state).toBe('pending');
  expect(await approvedArtwork(target, [1], 1)).toEqual([]);
  await saveFeedback(
    runtime,
    job.id,
    1,
    feedbackSchema.parse({ status: 'good' }),
    'test-owner'
  );
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('accepted');
});
it('a disabled automatic switch blocks generation without changing the budget', async () => {
  providers();
  const job = await selected();
  await runtime.DB.exec(
    'UPDATE cd_artwork_control SET automatic_enabled=0 WHERE id=1;'
  );
  expect(await claimSubmission(runtime, job)).toBe(false);
  expect(await generateOnce(withKey(), job.id, 1)).toEqual({ rawKey: null });
});
it('cross-user cover selection cannot borrow the owner’s observed tracks', async () => {
  providers();
  await play();
  await expect(
    verifiedCover(runtime, 1, 2, await ownedAlbum(runtime, 1, 1))
  ).rejects.toMatchObject({ code: 'cover_identity_unverified' });
});
it('authenticated Apple catalog verifies a cover without requiring a CD edition', async () => {
  await play();
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url, init) => {
      // A mocked fetch otherwise hides unsupported Workers RequestInit values.
      const request = new Request(String(url), init);
      expect(request.redirect).toBe('manual');
      return Response.json({ data: [appleAlbum] });
    });
  const source = await verifiedCover(
    { ...runtime, APPLE_MUSIC_DEVELOPER_TOKEN: 'synthetic-apple-token' },
    1,
    1,
    await ownedAlbum(runtime, 1, 1)
  );
  expect(source.request).toMatchObject({
    release_id: null,
    medium_position: null,
    source_kind: 'cover',
  });
  expect(source.sourceUrl).toContain('1200x1200bb.jpg');
  expect(source.discovery.catalog_provider).toBe('apple_music');
  expect(spy).toHaveBeenCalledWith(
    'https://api.music.apple.com/v1/catalog/us/albums/123?include=tracks',
    expect.objectContaining({
      redirect: 'manual',
      headers: expect.objectContaining({
        Authorization: 'Bearer synthetic-apple-token',
      }),
    })
  );
});
it.each(['artist', 'album', 'track'])(
  'authenticated Apple catalog holds contradictory %s metadata',
  async (field) => {
    await play();
    const album = structuredClone(appleAlbum);
    if (field === 'artist') album.attributes.artistName = 'Different artist';
    if (field === 'album') album.attributes.name = 'Different album';
    if (field === 'track')
      album.relationships.tracks.data[0].attributes.name = 'Different song';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ data: [album] })
    );
    await expect(
      verifiedCover(
        { ...runtime, APPLE_MUSIC_DEVELOPER_TOKEN: 'synthetic-apple-token' },
        1,
        1,
        await ownedAlbum(runtime, 1, 1)
      )
    ).rejects.toBeInstanceOf(ArtworkError);
  }
);
it('authenticated Apple search requires one exact album before checking its observed track', async () => {
  await play();
  await runtime.DB.exec(
    'UPDATE lastfm_albums SET apple_music_id=NULL WHERE id=1;'
  );
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    await runtime.DB.exec(
      'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1;'
    );
    return Response.json(
      String(url).includes('/search?')
        ? { results: { albums: { data: [appleAlbum] } } }
        : { data: [appleAlbum] }
    );
  });
  const source = await verifiedCover(
    { ...runtime, APPLE_MUSIC_DEVELOPER_TOKEN: 'synthetic-apple-token' },
    1,
    1,
    await ownedAlbum(runtime, 1, 1)
  );
  expect(source.discovery.observed_track_verified).toBe(true);
  expect(spy.mock.calls[0][0]).toContain('types=albums');
});
it('authenticated Apple errors remain retryable and never leak the credential to retail providers', async () => {
  await play();
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('', { status: 503 }));
  const env = {
    ...runtime,
    APPLE_MUSIC_DEVELOPER_TOKEN: 'synthetic-apple-token',
  };
  await expect(
    verifiedCover(env, 1, 1, await ownedAlbum(runtime, 1, 1))
  ).rejects.toMatchObject({ code: 'discovery_provider_error', status: 503 });
  await runtime.DB.exec(
    'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1;'
  );
  await expect(
    selectAutomaticSource(
      env,
      1,
      1,
      { name: 'Synthetic album', artist: 'Synthetic artist' },
      '',
      1
    )
  ).rejects.toMatchObject({ status: 503 });
  const retail = spy.mock.calls.find(([url]) =>
    String(url).includes('musicbrainz.org')
  );
  expect(retail?.[1]?.headers).not.toHaveProperty('Authorization');
});
it('wrong album, track or ambiguous search never schedules paid work', async () => {
  providers({ searchAmbiguous: true });
  await play();
  await runtime.DB.exec(
    'UPDATE lastfm_albums SET apple_music_id=NULL WHERE id=1;'
  );
  await expect(
    verifiedCover(runtime, 1, 1, await ownedAlbum(runtime, 1, 1))
  ).rejects.toMatchObject({ code: 'cover_identity_ambiguous' });
});
it('does not fall back to paid cover generation when the retail provider is unavailable', async () => {
  await play();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('', { status: 503 })
  );
  await expect(
    selectAutomaticSource(
      runtime,
      1,
      1,
      await ownedAlbum(runtime, 1, 1),
      RELEASE,
      1
    )
  ).rejects.toMatchObject({ code: 'discovery_provider_error' });
});
it('reclaims an expired verifier claim once and never regenerates paid raw bytes', async () => {
  const fetcher = providers();
  const job = await selected(),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await runtime.DB.prepare(
    "UPDATE cd_artwork_jobs SET validation_state='claimed',validation_attempts=1,validation_lease_until='2000-01-01' WHERE id=?"
  )
    .bind(job.id)
    .run();
  expect((await processRaw(target, job.id, 1)).state).toBe('pending');
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('accepted');
  expect(
    fetcher.mock.calls.filter(([u]) => String(u).includes('/images/edits'))
  ).toHaveLength(1);
  expect(
    (
      await runtime.DB.prepare(
        'SELECT validation_attempts n FROM cd_artwork_jobs WHERE id=?'
      )
        .bind(job.id)
        .first<{ n: number }>()
    )?.n
  ).toBe(2);
});
it('a live verifier claim cannot be stolen by a concurrent recovery', async () => {
  const fetcher = providers();
  const job = await selected(),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await runtime.DB.prepare(
    "UPDATE cd_artwork_jobs SET validation_state='claimed',validation_attempts=1,validation_lease_until=? WHERE id=?"
  )
    .bind(new Date(Date.now() + 120000).toISOString(), job.id)
    .run();
  expect((await processRaw(target, job.id, 1)).state).toBe('held');
  expect(
    fetcher.mock.calls.filter(([u]) => String(u).includes('/responses'))
  ).toHaveLength(0);
});
it('stale source selection cannot acquire a new catalog identity', async () => {
  providers();
  await play();
  const album = await ownedAlbum(runtime, 1, 1);
  const source = await selectAutomaticSource(runtime, 1, 1, album, '', 1);
  await runtime.DB.exec(
    "UPDATE lastfm_albums SET name='Different album' WHERE id=1;"
  );
  await expect(
    enqueue(runtime, source.request, 1, false, {
      source,
      expectedActiveJob: null,
      catalogIdentity: album,
    })
  ).rejects.toMatchObject({ code: 'catalog_identity_changed' });
});
it('an explicit no-album event never falls back to the track default album', async () => {
  await runtime.DB.prepare(
    'INSERT INTO lastfm_scrobbles(user_id,track_id,album_id,album_recorded,scrobbled_at,created_at) VALUES(1,1,NULL,1,?,?)'
  )
    .bind(now(), now())
    .run();
  expect(
    (
      await runtime.DB.prepare(
        'SELECT COUNT(*) n FROM cd_artwork_checks'
      ).first<{ n: number }>()
    )?.n
  ).toBe(0);
});
it('cover artwork retains a seven-day upgrade cooldown', async () => {
  providers();
  const job = await selected();
  const row = await runtime.DB.prepare(
    'SELECT next_check FROM cd_artwork_albums WHERE user_id=1 AND album_id=1'
  ).first<{ next_check: string }>();
  expect(Date.parse(row!.next_check) - Date.now()).toBeLessThan(8 * 86400000);
  expect(job.automatic).toBe(1);
});
it('an actual runtime generation Workflow publishes the cover-only album', async () => {
  const fetcher = providers();
  const job = await selected();
  await using instance = await introspectWorkflowInstance(
    runtime.CD_WORKFLOW,
    job.id
  );
  await dispatch(runtime, job);
  await instance.waitForStatus('complete');
  expect(await instance.getOutput()).toMatchObject({ state: 'accepted' });
  expect((await approvedArtwork(runtime, [1], 1))[0]).toMatchObject({
    identity_type: 'reviewed_source',
    release_id: null,
    medium_position: null,
  });
  expect(
    fetcher.mock.calls.filter(([u]) => String(u).includes('/images/edits'))
  ).toHaveLength(1);
});
it('a missing approved retail file falls back to verified album cover', async () => {
  providers({ retail: true, missingRetail: true });
  await play();
  const source = await selectAutomaticSource(
    runtime,
    1,
    1,
    await ownedAlbum(runtime, 1, 1),
    RELEASE,
    1
  );
  expect(source.sourceKind).toBe('cover');
  expect(source.request.release_id).toBeNull();
});
it('single-album automatic preview requires admin permission and never queues paid work', async () => {
  providers();
  await play();
  const read = await createTestApiKey({ scope: 'read', token: 'rw_auto_read' }),
    admin = await createTestApiKey({ scope: 'admin', token: 'rw_auto_admin' });
  const url = 'https://example.com/v1/admin/cd-artwork/albums/1/automatic';
  const ctx = createExecutionContext();
  expect(
    (
      await artworkApp.request(
        url,
        { method: 'POST', headers: { Authorization: `Bearer ${read}` } },
        runtime
      )
    ).status
  ).toBe(403);
  const response = await artworkApp.request(
    url,
    { method: 'POST', headers: { Authorization: `Bearer ${admin}` } },
    runtime,
    ctx
  );
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    validated: true,
    source_kind: 'cover',
    release_id: null,
  });
  expect(
    (
      await runtime.DB.prepare('SELECT COUNT(*) n FROM cd_artwork_jobs').first<{
        n: number;
      }>()
    )?.n
  ).toBe(0);
});
it('raw exception evidence is private and owned', async () => {
  providers({ verdictOverride: { confidence: 'uncertain' } });
  const job = await selected(),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  const admin = await createTestApiKey({
      scope: 'admin',
      token: 'rw_raw_owner',
    }),
    other = await createTestApiKey({
      scope: 'admin',
      userId: 2,
      token: 'rw_raw_other',
    }),
    read = await createTestApiKey({ scope: 'read', token: 'rw_raw_read' });
  const url = `https://example.com/v1/admin/cd-artwork/jobs/${job.id}/raw`,
    ctx = createExecutionContext();
  expect((await artworkApp.request(url, {}, runtime, ctx)).status).toBe(401);
  expect(
    (
      await artworkApp.request(
        url,
        { headers: { Authorization: `Bearer ${read}` } },
        runtime,
        ctx
      )
    ).status
  ).toBe(403);
  expect(
    (
      await artworkApp.request(
        url,
        { headers: { Authorization: `Bearer ${other}` } },
        runtime,
        ctx
      )
    ).status
  ).toBe(404);
  const response = await artworkApp.request(
    url,
    { headers: { Authorization: `Bearer ${admin}` } },
    runtime,
    ctx
  );
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.arrayBuffer()).toEqual(bytes.buffer);
});
it('dark rollout permits preview but prohibits apply', async () => {
  providers();
  await play();
  await runtime.DB.exec(
    'UPDATE cd_artwork_control SET automatic_enabled=0 WHERE id=1;'
  );
  const admin = await createTestApiKey({
      scope: 'admin',
      token: 'rw_dark_admin',
    }),
    ctx = createExecutionContext();
  const init = {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin}` },
  };
  expect(
    (
      await artworkApp.request(
        'https://example.com/v1/admin/cd-artwork/albums/1/automatic',
        init,
        runtime,
        ctx
      )
    ).status
  ).toBe(200);
  expect(
    (
      await artworkApp.request(
        'https://example.com/v1/admin/cd-artwork/albums/1/automatic?apply=true',
        init,
        runtime,
        ctx
      )
    ).status
  ).toBe(409);
  await waitOnExecutionContext(ctx);
});
it.each(['album', 'artist', 'track'])(
  'rejects a contradictory provider %s before generation',
  async (field) => {
    await play();
    const bad = structuredClone(lookup);
    if (field === 'album') bad.results[0].collectionName = 'Different album';
    if (field === 'artist') bad.results[0].artistName = 'Different artist';
    if (field === 'track') bad.results[1].trackName = 'Different song';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(bad));
    await expect(
      verifiedCover(runtime, 1, 1, await ownedAlbum(runtime, 1, 1))
    ).rejects.toMatchObject({
      code:
        field === 'track'
          ? 'cover_track_mismatch'
          : 'cover_identity_unverified',
    });
    expect(
      (
        await runtime.DB.prepare(
          'SELECT COUNT(*) n FROM cd_artwork_jobs'
        ).first<{ n: number }>()
      )?.n
    ).toBe(0);
  }
);
it('historical replay distinguishes legacy evidence without rewriting any event', async () => {
  providers();
  await runtime.DB.prepare(
    'INSERT INTO lastfm_scrobbles(user_id,track_id,scrobbled_at,created_at) VALUES(1,1,?,?)'
  )
    .bind(now(), now())
    .run();
  const album = await ownedAlbum(runtime, 1, 1);
  await expect(verifiedCover(runtime, 1, 1, album)).rejects.toMatchObject({
    code: 'cover_identity_unverified',
  });
  const source = await verifiedCover(runtime, 1, 1, album, true);
  expect(source.discovery.play_evidence).toBe('legacy_track_association');
  expect(
    await runtime.DB.prepare(
      'SELECT album_recorded,album_id FROM lastfm_scrobbles'
    ).first()
  ).toEqual({ album_recorded: 0, album_id: null });
});
it('a retail disc accepted during source selection blocks even a job expecting that active disc', async () => {
  providers();
  await play();
  const album = await ownedAlbum(runtime, 1, 1),
    source = await selectAutomaticSource(runtime, 1, 1, album, '', 1);
  await runtime.DB.prepare(
    "INSERT INTO cd_artwork_jobs(id,user_id,album_id,state,input,source_hash,source_key,source_mime,provenance,updated_at,created_at) VALUES('late-retail',1,1,'accepted',?, 'hash','key','image/png','{}',?,?)"
  )
    .bind(JSON.stringify({ source_kind: 'retail' }), now(), now())
    .run();
  await runtime.DB.exec(
    "UPDATE cd_artwork_albums SET active_job='late-retail' WHERE user_id=1 AND album_id=1;"
  );
  const job = (
    await enqueue(runtime, source.request, 1, false, {
      source,
      expectedActiveJob: 'late-retail',
      catalogIdentity: album,
    })
  ).job;
  expect(await claimSubmission(runtime, job)).toBe(false);
  expect(await generateOnce(withKey(), job.id, 1)).toEqual({ rawKey: null });
});
it('a retail scan cannot bypass a contradictory stored Apple album binding', async () => {
  await play();
  const bad = structuredClone(lookup);
  bad.results[0].collectionName = 'Different album';
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json(bad));
  await expect(
    selectAutomaticSource(
      runtime,
      1,
      1,
      await ownedAlbum(runtime, 1, 1),
      RELEASE,
      1
    )
  ).rejects.toMatchObject({ code: 'cover_identity_unverified' });
  expect(
    fetcher.mock.calls.some(([u]) => String(u).includes('musicbrainz.org'))
  ).toBe(false);
});
it('an independently verified cover remains usable while retail discovery retries', async () => {
  await play();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    await runtime.DB.prepare(
      'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1'
    ).run();
    return String(url).includes('itunes.apple.com')
      ? Response.json(lookup)
      : new Response('', { status: 503 });
  });
  const source = await selectAutomaticSource(
    runtime,
    1,
    1,
    await ownedAlbum(runtime, 1, 1),
    RELEASE,
    1
  );
  expect(source.sourceKind).toBe('cover');
  expect(source.retailRetryAfter).toBe(3600);
  expect(source.discovery.outcome).toBe('retail_provider_pending');
});
it('a retail upgrade waits for the unfinished fallback job without a second budget claim', async () => {
  providers();
  const cover = await selected();
  const album = await ownedAlbum(runtime, 1, 1);
  vi.restoreAllMocks();
  providers({ retail: true });
  const retail = await selectAutomaticSource(runtime, 1, 1, album, RELEASE, 1);
  const deferred = await enqueue(runtime, retail.request, 1, false, {
    source: retail,
    expectedActiveJob: null,
    catalogIdentity: album,
  });
  expect(deferred.job.id).toBe(cover.id);
  expect('blocked' in deferred && deferred.blocked).toBe(true);
  expect(
    (
      await runtime.DB.prepare(
        'SELECT COUNT(*) n FROM cd_artwork_jobs WHERE automatic=1'
      ).first<{ n: number }>()
    )?.n
  ).toBe(1);
  expect(await claimSubmission(runtime, cover)).toBe(true);
  expect(await claimSubmission(runtime, deferred.job)).toBe(false);
});
it('simultaneous cover and retail enrollment share one unfinished automatic job', async () => {
  providers();
  await play();
  const album = await ownedAlbum(runtime, 1, 1),
    cover = await verifiedCover(runtime, 1, 1, album);
  vi.restoreAllMocks();
  providers({ retail: true });
  const retail = await selectAutomaticSource(runtime, 1, 1, album, RELEASE, 1);
  const jobs = await Promise.all([
    enqueue(runtime, cover.request, 1, false, {
      source: cover,
      expectedActiveJob: null,
      catalogIdentity: album,
    }),
    enqueue(runtime, retail.request, 1, false, {
      source: retail,
      expectedActiveJob: null,
      catalogIdentity: album,
    }),
  ]);
  expect(jobs[0].job.id).toBe(jobs[1].job.id);
  expect(
    (
      await runtime.DB.prepare(
        'SELECT COUNT(*) n FROM cd_artwork_jobs WHERE automatic=1'
      ).first<{ n: number }>()
    )?.n
  ).toBe(1);
});
it('a finished fallback can upgrade to retail with its accepted asset as the expected active job', async () => {
  providers();
  const cover = await selected(),
    target = withKey();
  await generateOnce(target, cover.id, 1);
  await processRaw(target, cover.id, 1);
  await publishAutomatic(target, cover.id, 1);
  vi.restoreAllMocks();
  providers({ retail: true });
  const album = await ownedAlbum(runtime, 1, 1),
    source = await selectAutomaticSource(runtime, 1, 1, album, RELEASE, 1);
  const job = (
    await enqueue(runtime, source.request, 1, false, {
      source,
      expectedActiveJob: cover.id,
      catalogIdentity: album,
    })
  ).job;
  expect(job.id).not.toBe(cover.id);
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('accepted');
  expect(
    await runtime.DB.prepare(
      'SELECT release_id,active_job FROM cd_artwork_albums WHERE user_id=1 AND album_id=1'
    ).first()
  ).toEqual({ release_id: RELEASE, active_job: job.id });
});
it('normal metadata enrichment gets a short retry instead of a seven-day hold', async () => {
  await runtime.DB.exec(
    'UPDATE lastfm_albums SET apple_music_id=NULL WHERE id=1;'
  );
  await play();
  const fetcher = providers(),
    impl = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    const response = await impl(url, init);
    if (String(url).includes('musicbrainz.org'))
      await runtime.DB.exec(
        'UPDATE lastfm_albums SET apple_music_id=123 WHERE id=1;'
      );
    return response;
  });
  const row = await runtime.DB.prepare(
    'SELECT id FROM cd_artwork_checks'
  ).first<{ id: number }>();
  const target = {
    ...runtime,
    CD_WORKFLOW: { create: vi.fn(async () => ({})) },
  } as unknown as ArtworkEnv;
  expect(await checkListeningArtwork(target, row!.id)).toEqual({
    outcome: 'catalog_changed',
    retryAfter: 60,
  });
  expect(
    (
      await runtime.DB.prepare(
        'SELECT completed_at FROM cd_artwork_checks'
      ).first<{ completed_at: null }>()
    )?.completed_at
  ).toBeNull();
  expect(await checkListeningArtwork(target, row!.id)).toEqual({
    outcome: 'generation_queued',
    retryAfter: 0,
  });
});
it('stale queued artwork retires and a new active context gets a fresh immutable job', async () => {
  providers({ retail: true });
  const old = await selected(true);
  await runtime.DB.prepare(
    "INSERT INTO cd_artwork_jobs(id,user_id,album_id,state,input,source_hash,source_key,source_mime,provenance,updated_at,created_at) VALUES('new-cover',1,1,'accepted',?, 'hash','key','image/png','{}',?,?)"
  )
    .bind(JSON.stringify({ source_kind: 'cover' }), now(), now())
    .run();
  await runtime.DB.exec(
    "UPDATE cd_artwork_albums SET active_job='new-cover' WHERE user_id=1 AND album_id=1;"
  );
  expect(await generateOnce(withKey(), old.id, 1)).toEqual({ rawKey: null });
  expect((await getJob(runtime, old.id, 1))?.state).toBe('needs_registration');
  const album = await ownedAlbum(runtime, 1, 1),
    source = await selectAutomaticSource(runtime, 1, 1, album, RELEASE, 1);
  const next = (
    await enqueue(runtime, source.request, 1, false, {
      source,
      expectedActiveJob: 'new-cover',
      catalogIdentity: album,
    })
  ).job;
  expect(next.id).not.toBe(old.id);
  expect(next.expected_active_job).toBe('new-cover');
});

it('authenticated catalog redirects remain a private retryable hold', async () => {
  await play();
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url, init) => {
      expect(new Request(String(url), init).redirect).toBe('manual');
      return new Response('', {
        status: 302,
        headers: { Location: 'https://untrusted.invalid/' },
      });
    });
  await expect(
    verifiedCover(
      { ...runtime, APPLE_MUSIC_DEVELOPER_TOKEN: 'synthetic-apple-token' },
      1,
      1,
      await ownedAlbum(runtime, 1, 1)
    )
  ).rejects.toMatchObject({ code: 'discovery_provider_error', status: 503 });
  expect(spy).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  'retail discovery filters CD editions and revisits a digital cover when needed %s',
  async (revisit) => {
    await play();
    const group = '33333333-3333-4333-8333-333333333333';
    const digital = '22222222-2222-4222-8222-222222222222';
    const spy = providers({ retail: true }),
      original = spy.getMockImplementation();
    spy.mockImplementation(async (url, init) => {
      await runtime.DB.exec(
        'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1;'
      );
      const u = String(url);
      if (u.includes('/release/?')) {
        const query = new URL(u).searchParams.get('query');
        expect(query).toContain('format:(CD OR HDCD)');
        if (revisit) expect(query).toContain('rgid:' + group);
        return Response.json({
          count: 1,
          releases: [
            {
              id: RELEASE,
              title: 'Synthetic album',
              status: 'Official',
              'release-group': { id: group },
              'artist-credit': [{ name: 'Synthetic artist' }],
            },
          ],
        });
      }
      if (u.includes('musicbrainz.org'))
        return Response.json({
          id: u.includes(digital) ? digital : RELEASE,
          title: 'Synthetic album',
          media: [
            {
              format: u.includes(digital) ? 'Digital Media' : 'CD',
              position: 1,
            },
          ],
          'release-group': { id: group },
          'artist-credit': [{ name: 'Synthetic artist' }],
        });
      return original!(url, init);
    });
    const source = await selectAutomaticSource(
      runtime,
      1,
      1,
      await ownedAlbum(runtime, 1, 1),
      revisit ? digital : '',
      revisit ? 2 : 1,
      false,
      revisit
    );
    expect(source.sourceKind).toBe('retail');
    expect(source.request).toMatchObject({
      release_id: RELEASE,
      medium_position: 1,
    });
  }
);
it('a reviewed cover edition never authorizes a different logical CD album', async () => {
  await play();
  const group = '33333333-3333-4333-8333-333333333333';
  const other = '44444444-4444-4444-8444-444444444444';
  const digital = '22222222-2222-4222-8222-222222222222';
  const spy = providers({ retail: true }),
    original = spy.getMockImplementation();
  spy.mockImplementation(async (url, init) => {
    await runtime.DB.exec(
      'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1;'
    );
    const u = String(url);
    if (u.includes('/release/?'))
      return Response.json({
        count: 1,
        releases: [
          {
            id: RELEASE,
            title: 'Synthetic album',
            status: 'Official',
            'release-group': { id: other },
            'artist-credit': [{ name: 'Synthetic artist' }],
          },
        ],
      });
    if (u.includes('musicbrainz.org'))
      return Response.json({
        id: digital,
        title: 'Synthetic album',
        media: [{ format: 'Digital Media', position: 1 }],
        'release-group': { id: group },
        'artist-credit': [{ name: 'Synthetic artist' }],
      });
    return original!(url, init);
  });
  const source = await selectAutomaticSource(
    runtime,
    1,
    1,
    await ownedAlbum(runtime, 1, 1),
    digital,
    1,
    false,
    true
  );
  expect(source.sourceKind).toBe('cover');
  expect(
    spy.mock.calls.some(([url]) => String(url).includes('/release/' + RELEASE))
  ).toBe(false);
});
