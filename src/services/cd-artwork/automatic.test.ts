import {
  env,
  applyD1Migrations,
  introspectWorkflowInstance,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { ArtworkEnv, Job } from './types.js';
import { now, sha256 } from './types.js';
import { artworkApp, CdArtworkWorkflow } from '../../cd-artwork-worker.js';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
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
import { queueArtworkReprocessing, queueRenderRetry } from './reprocessing.js';
import { saveFeedback, feedbackSchema } from './feedback.js';
import { materialInspectionView } from './rendering.js';
import { png, readPixels } from '../../../scripts/cd-artwork/pixels.mjs';
const runtime = env as typeof env & ArtworkEnv;
function isFinalVerification([url, init]: Parameters<typeof fetch>) {
  return (
    String(url).includes('/responses') &&
    JSON.parse(String(init?.body)).text.format.name !== 'retail_hub_material'
  );
}
const RELEASE = '11111111-1111-4111-8111-111111111111';
const GROUP = '33333333-3333-4333-8333-333333333333';
const verdict = {
  confidence: 'high',
  artwork_preserved: true,
  lettering_preserved: true,
  no_invented_content: true,
  no_visible_defects: true,
  no_added_rim_effects: true,
  concentric_geometry: true,
  retail_source_supported: true,
  material_confident: true,
  material_preserved: true,
  material_inner: 64,
  material_outer: 108,
  material_opacity: 0.45,
};
function disc(includeRing = true) {
  const data = new Uint8Array(1024 * 1024 * 4).fill(255);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512);
      if (r >= 60 && r <= 480)
        data.set(
          includeRing && r < 100 ? [170, 180, 190, 255] : [75, 90, 105, 255],
          (y * 1024 + x) * 4
        );
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
  audioDb = false,
  verdictOverride = {},
  failVerifier = false,
  searchAmbiguous = false,
  missingRetail = false,
  retailSource = bytes,
  hubDecision = {
    kind: 'opaque',
    confidence: 'high',
    region_id: null as number | null,
    unprinted: false,
    non_metallic: false,
  },
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
                    text: JSON.stringify(
                      JSON.parse(String(init?.body)).text.format.name ===
                        'retail_hub_material'
                        ? hubDecision
                        : { ...verdict, ...verdictOverride }
                    ),
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
    if (u.includes('theaudiodb.com/api/'))
      return Response.json({
        album: [
          {
            idAlbum: '123',
            strAlbum: 'Synthetic album',
            strArtist: 'Synthetic artist',
            strMusicBrainzReleaseGroupID: GROUP,
            strAlbumCDart:
              'https://r2.theaudiodb.com/images/media/album/cdart/123.png',
          },
        ],
      });
    if (u.includes('theaudiodb.com/images/')) {
      const pixels = readPixels(bytes);
      pixels.data[(512 * 1024 + 800) * 4] = 120;
      return new Response(new Uint8Array(png(pixels)), {
        headers: { 'Content-Type': 'image/png' },
      });
    }
    if (u.includes('mzstatic.com') || u.endsWith('synthetic.png'))
      return new Response(
        new Uint8Array(u.endsWith('synthetic.png') ? retailSource : bytes),
        {
          headers: { 'Content-Type': 'image/png' },
        }
      );
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
        ...(audioDb ? { 'release-group': { id: GROUP } } : {}),
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
it.each(['proven', 'unbound', 'ambiguous', 'version'])(
  'allows a small track typo only with unique independent album proof %s',
  async (mode) => {
    await play();
    await runtime.DB.exec(
      "UPDATE lastfm_tracks SET name='Synthetic in the water' WHERE id=1;"
    );
    if (mode !== 'unbound')
      await runtime.DB.prepare('UPDATE lastfm_albums SET mbid=? WHERE id=1')
        .bind(RELEASE)
        .run();
    const collection = structuredClone(appleAlbum);
    collection.relationships.tracks.data[0].attributes.name =
      'Synthetic into the water';
    if (mode === 'ambiguous')
      collection.relationships.tracks.data.push({
        id: '457',
        attributes: {
          name: 'Synthetic in the waters',
          artistName: 'Synthetic artist',
        },
      });
    if (mode === 'version')
      collection.relationships.tracks.data[0].attributes.name += ' (Live)';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      await runtime.DB.exec(
        'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1;'
      );
      if (String(url).includes('musicbrainz.org'))
        return Response.json({
          id: RELEASE,
          title: 'Synthetic album',
          'artist-credit': [{ name: 'Synthetic artist' }],
          'release-group': { id: GROUP, title: 'Synthetic album' },
        });
      return Response.json(
        String(url).includes('/search?')
          ? { results: { albums: { data: [collection] } } }
          : { data: [collection] }
      );
    });
    const promise = verifiedCover(
      { ...runtime, APPLE_MUSIC_DEVELOPER_TOKEN: 'synthetic-apple-token' },
      1,
      1,
      await ownedAlbum(runtime, 1, 1)
    );
    if (mode === 'proven')
      expect((await promise).discovery.observed_track_proof).toBe(
        'catalog_anchored_title_variance'
      );
    else
      await expect(promise).rejects.toMatchObject({
        code: 'cover_track_mismatch',
      });
  }
);
it('a failed background restoration keeps the existing accepted cover visible during recovery', async () => {
  providers({ retail: true, verdictOverride: { no_added_rim_effects: false } });
  await play();
  await runtime.DB.prepare(
    "INSERT INTO cd_artwork_jobs(id,user_id,album_id,state,input,source_hash,source_key,source_mime,candidate_hash,provenance,updated_at,created_at) VALUES('old-cover',1,1,'accepted',?,'old-source','old-key','image/png',?,'{}',?,?)"
  )
    .bind(
      JSON.stringify({ source_kind: 'cover' }),
      'f'.repeat(64),
      now(),
      now()
    )
    .run();
  await runtime.DB.exec(
    "UPDATE cd_artwork_albums SET active_job='old-cover' WHERE user_id=1 AND album_id=1; UPDATE cd_artwork_checks SET completed_at='2026-01-01' WHERE user_id=1 AND album_id=1;"
  );
  const album = await ownedAlbum(runtime, 1, 1);
  const source = await selectAutomaticSource(runtime, 1, 1, album, RELEASE, 1);
  const job = (
    await enqueue(runtime, source.request, 1, false, {
      source,
      expectedActiveJob: 'old-cover',
      catalogIdentity: album,
    })
  ).job;
  await generateOnce(withKey(), job.id, 1);
  await processRaw(withKey(), job.id, 1);
  expect(await queueRenderRetry(runtime, job.id, 1)).toBe(true);
  expect(
    await runtime.DB.prepare(
      'SELECT active_job,hidden_job FROM cd_artwork_albums WHERE user_id=1 AND album_id=1'
    ).first()
  ).toMatchObject({ active_job: 'old-cover', hidden_job: null });
});
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
it.each(['valid', 'changed', 'foreign', 'new-image'])(
  'rechecks a remembered CD source before searching again %s',
  async (mode) => {
    await play();
    const spy = providers({ retail: true });
    const original = spy.getMockImplementation()!;
    const album = await ownedAlbum(runtime, 1, 1);
    const previousSource = await selectAutomaticSource(
      runtime,
      1,
      1,
      album,
      RELEASE,
      1
    );
    const previous = (
      await enqueue(runtime, previousSource.request, 1, false, {
        source: previousSource,
        expectedActiveJob: null,
        catalogIdentity: album,
      })
    ).job;
    await runtime.DB.prepare(
      "UPDATE cd_artwork_jobs SET state='needs_registration',validation_state='held',error_code='automatic_geometry_hold',provenance=json_set(provenance,'$.processorHash','prior-processor'),user_id=? WHERE id=?"
    )
      .bind(mode === 'foreign' ? 2 : 1, previous.id)
      .run();
    let searches = 0;
    spy.mockImplementation(async (url, init) => {
      await runtime.DB.exec(
        'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1;'
      );
      const u = String(url);
      if (u.includes('/release/?')) {
        searches++;
        return Response.json({ count: 0, releases: [] });
      }
      if (
        mode === 'new-image' &&
        u.includes('coverartarchive.org') &&
        !u.endsWith('synthetic.png')
      )
        return Response.json({
          images: [
            {
              id: 10,
              approved: true,
              types: ['Medium'],
              image: 'https://coverartarchive.org/synthetic.png',
            },
          ],
        });
      if (
        mode === 'changed' &&
        u.includes('musicbrainz.org/ws/2/release/' + RELEASE)
      )
        return Response.json({
          id: RELEASE,
          title: 'Different album',
          media: [{ format: 'CD', position: 1 }],
          'artist-credit': [{ name: 'Synthetic artist' }],
        });
      return original(url, init);
    });
    const source = await selectAutomaticSource(
      runtime,
      1,
      1,
      album,
      '',
      1,
      false,
      true
    );
    const usable = mode === 'valid' || mode === 'new-image';
    expect(source.sourceKind).toBe(usable ? 'retail' : 'cover');
    if (usable) {
      expect(source.request).toMatchObject({
        release_id: RELEASE,
        medium_position: 1,
        image_id: mode === 'new-image' ? '10' : '9',
      });
      expect(searches).toBe(0);
    } else expect(searches).toBe(1);
  }
);

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
    ).toHaveLength(retail ? 0 : 1);
    expect(fetcher.mock.calls.filter(isFinalVerification)).toHaveLength(1);
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
  { no_added_rim_effects: false },
  { concentric_geometry: false },
  { material_preserved: false },
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
it('material confidence is advisory when source appearance remains intact', async () => {
  providers({ retail: true, verdictOverride: { material_confident: false } });
  const job = await selected(true),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('accepted');
});
it('a lost verifier response cannot pay for repeated verification or generation', async () => {
  const fetcher = providers({ failVerifier: true });
  const job = await selected(),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  await processRaw(target, job.id, 1);
  await generateOnce(target, job.id, 1);
  expect(fetcher.mock.calls.filter(isFinalVerification)).toHaveLength(1);
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
it('recovers a stale stored catalog ID through a unique album, artist and track proof', async () => {
  await play();
  const corrected = structuredClone(appleAlbum);
  corrected.id = '789';
  const stale = structuredClone(appleAlbum);
  stale.attributes.name = 'Unrelated album';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    await runtime.DB.exec(
      'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1;'
    );
    const u = String(url);
    return Response.json(
      u.includes('/search?')
        ? { results: { albums: { data: [corrected] } } }
        : { data: [u.includes('/albums/789?') ? corrected : stale] }
    );
  });
  const result = await verifiedCover(
    { ...runtime, APPLE_MUSIC_DEVELOPER_TOKEN: 'synthetic-apple-token' },
    1,
    1,
    await ownedAlbum(runtime, 1, 1)
  );
  expect(result.discovery.collection_id).toBe('789');
  expect(result.discovery.observed_track_verified).toBe(true);
  expect((await ownedAlbum(runtime, 1, 1)).apple_music_id).toBe(123);
});
it('accepts featured song credits while keeping collection artist and track membership checks', async () => {
  await play();
  const collection = structuredClone(appleAlbum);
  collection.relationships.tracks.data[0].attributes.name =
    'Synthetic song (feat. Guest)';
  collection.relationships.tracks.data[0].attributes.artistName =
    'Synthetic artist & Guest';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({ data: [collection] })
  );
  const result = await verifiedCover(
    { ...runtime, APPLE_MUSIC_DEVELOPER_TOKEN: 'synthetic-apple-token' },
    1,
    1,
    await ownedAlbum(runtime, 1, 1)
  );
  expect(result.discovery.observed_track_verified).toBe(true);
});
it.each([false, true])(
  'accepts omitted leading song articles only for a unique album member %s',
  async (ambiguous) => {
    await play();
    const collection = structuredClone(appleAlbum);
    collection.relationships.tracks.data[0].attributes.name =
      'A Synthetic song';
    if (ambiguous)
      collection.relationships.tracks.data.push({
        id: '457',
        attributes: {
          name: 'The Synthetic song',
          artistName: 'Synthetic artist',
        },
      });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      await runtime.DB.exec(
        'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1;'
      );
      return Response.json(
        String(url).includes('/search?')
          ? { results: { albums: { data: [collection] } } }
          : { data: [collection] }
      );
    });
    const promise = verifiedCover(
      { ...runtime, APPLE_MUSIC_DEVELOPER_TOKEN: 'synthetic-apple-token' },
      1,
      1,
      await ownedAlbum(runtime, 1, 1)
    );
    if (ambiguous)
      await expect(promise).rejects.toMatchObject({
        code: 'cover_track_mismatch',
      });
    else expect((await promise).discovery.observed_track_verified).toBe(true);
  }
);
it.each([true, false])(
  'requires catalog evidence before treating a bare title as an inherently live album %s',
  async (live) => {
    await play();
    await runtime.DB.prepare('UPDATE lastfm_albums SET mbid=? WHERE id=1')
      .bind(RELEASE)
      .run();
    const collection = structuredClone(appleAlbum);
    collection.attributes.name += ' (Live)';
    collection.relationships.tracks.data[0].attributes.name += ' (Live)';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      await runtime.DB.exec(
        'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1;'
      );
      if (String(url).includes('musicbrainz.org'))
        return Response.json({
          id: RELEASE,
          title: 'Synthetic album',
          'artist-credit': [{ name: 'Synthetic artist' }],
          'release-group': {
            id: GROUP,
            title: 'Synthetic album',
            'secondary-types': live ? ['Live'] : [],
          },
        });
      return Response.json(
        String(url).includes('/search?')
          ? { results: { albums: { data: [collection] } } }
          : { data: [collection] }
      );
    });
    const promise = verifiedCover(
      { ...runtime, APPLE_MUSIC_DEVELOPER_TOKEN: 'synthetic-apple-token' },
      1,
      1,
      await ownedAlbum(runtime, 1, 1)
    );
    if (live)
      expect((await promise).discovery.catalog_alias_proof).toMatchObject({
        live: true,
      });
    else
      await expect(promise).rejects.toMatchObject({
        code: 'cover_identity_unverified',
      });
  }
);
it.each(['Amber Album', 'Other Album'])(
  'uses bound catalog disambiguation rather than guessing self-title aliases %s',
  async (disambiguation) => {
    await play();
    await runtime.DB.prepare(
      "UPDATE lastfm_albums SET name='Synthetic album (Amber Album)',mbid=? WHERE id=1"
    )
      .bind(RELEASE)
      .run();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      await runtime.DB.exec(
        'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1;'
      );
      if (String(url).includes('musicbrainz.org'))
        return Response.json({
          id: RELEASE,
          title: 'Synthetic album',
          'artist-credit': [{ name: 'Synthetic artist' }],
          'release-group': {
            id: GROUP,
            title: 'Synthetic album',
            disambiguation,
          },
        });
      return Response.json(
        String(url).includes('/search?')
          ? { results: { albums: { data: [appleAlbum] } } }
          : { data: [appleAlbum] }
      );
    });
    const promise = verifiedCover(
      { ...runtime, APPLE_MUSIC_DEVELOPER_TOKEN: 'synthetic-apple-token' },
      1,
      1,
      await ownedAlbum(runtime, 1, 1)
    );
    if (disambiguation === 'Amber Album')
      expect((await promise).discovery.catalog_alias_proof).toMatchObject({
        titleAliasVerified: true,
      });
    else
      await expect(promise).rejects.toMatchObject({
        code: 'cover_identity_unverified',
      });
  }
);
it.each(['artist', 'album', 'track'])(
  'authenticated Apple catalog holds contradictory %s metadata',
  async (field) => {
    await play();
    const album = structuredClone(appleAlbum);
    if (field === 'artist') album.attributes.artistName = 'Different artist';
    if (field === 'album') album.attributes.name = 'Different album';
    if (field === 'track')
      album.relationships.tracks.data[0].attributes.name = 'Different song';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
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
  expect(fetcher.mock.calls.filter(isFinalVerification)).toHaveLength(0);
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
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json(bad)
    );
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
    .mockImplementation(async () => Response.json(bad));
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
    fetcher.mock.calls.some(([u]) => String(u).includes('coverartarchive.org'))
  ).toBe(false);
});
it('an independently verified cover remains usable while retail discovery retries', async () => {
  await play();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    await runtime.DB.prepare(
      'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1'
    ).run();
    if (String(url).includes('mzstatic.com'))
      return new Response(new Uint8Array(bytes), {
        headers: { 'Content-Type': 'image/png' },
      });
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

it('rejects unsupported retail source designs without requesting owner approval', async () => {
  providers({
    retail: true,
    verdictOverride: { retail_source_supported: false },
  });
  const job = await selected(true),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  expect((await getJob(target, job.id, 1))?.error_code).toBe(
    'automatic_quality_hold'
  );
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('held');
});
it('preserves an opaque retail hub instead of requiring invented transparency', async () => {
  providers({ retail: true, verdictOverride: { material_opacity: 1 } });
  const job = await selected(true),
    target = withKey();
  await generateOnce(target, job.id, 1);
  expect((await processRaw(target, job.id, 1)).state).toBe('pending');
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('accepted');
  const saved = await getJob(target, job.id, 1);
  expect(
    JSON.parse(saved!.provenance).verification.material.treatment.mode
  ).toBe('preserve');
});
it('does not publish a candidate verified under an older geometry policy', async () => {
  providers();
  const job = await selected(),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  await runtime.DB.prepare(
    "UPDATE cd_artwork_jobs SET provenance=json_remove(provenance,'$.verificationPolicy') WHERE id=?"
  )
    .bind(job.id)
    .run();
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('held');
  expect(await approvedArtwork(target, [1], 1)).toEqual([]);
});
it('judges the exact final candidate on both backgrounds without a later opacity patch', async () => {
  const fetcher = providers({ retail: true });
  const job = await selected(true),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  const saved = (await getJob(target, job.id, 1))!;
  const object = (await runtime.ARTWORK.get(saved.candidate_key!))!;
  const candidate = new Uint8Array(await object.arrayBuffer());
  const calls = fetcher.mock.calls.filter(isFinalVerification);
  expect(calls).toHaveLength(1);
  const body = JSON.parse(String(calls[0][1]!.body));
  const images = body.input[0].content.filter(
    (part: { type: string }) => part.type === 'input_image'
  );
  expect(images).toHaveLength(4);
  const rimImage = readPixels(
    Uint8Array.from(atob(images[3].image_url.split(',')[1]), (c) =>
      c.charCodeAt(0)
    )
  );
  expect([rimImage.width, rimImage.height]).toEqual([1024, 256]);
  for (const [index, color] of [
    [1, [248, 248, 244]],
    [2, [32, 35, 32]],
  ] as const) {
    const binary = atob(images[index].image_url.split(',')[1]);
    const submitted = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    expect(await sha256(submitted)).toBe(
      await sha256(materialInspectionView(candidate, color))
    );
  }
  expect(JSON.parse(saved.provenance).verifiedCandidateHash).toBe(
    await sha256(candidate)
  );
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('accepted');
});
it('retries the same source once with a distinct prompt, then stops spending', async () => {
  providers({ verdictOverride: { concentric_geometry: false } });
  const job = await selected(),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  const album = await ownedAlbum(runtime, 1, 1);
  const retrySource = await selectAutomaticSource(runtime, 1, 1, album, '', 1);
  expect(retrySource.renderRetry).toEqual({ attempt: 1, reason: 'quality' });
  const { job: retry } = await enqueue(runtime, retrySource.request, 1, false, {
    source: retrySource,
    expectedActiveJob: null,
    catalogIdentity: album,
  });
  expect(retry.source_hash).toBe(job.source_hash);
  expect(JSON.parse(retry.provenance).generationKey).not.toBe(
    JSON.parse(job.provenance).generationKey
  );
  expect(
    (
      await enqueue(runtime, retrySource.request, 1, false, {
        source: retrySource,
        expectedActiveJob: null,
        catalogIdentity: album,
      })
    ).job.id
  ).toBe(retry.id);
  await generateOnce(target, retry.id, 1);
  await processRaw(target, retry.id, 1);
  await expect(
    selectAutomaticSource(runtime, 1, 1, album, '', 1)
  ).rejects.toMatchObject({ code: 'artwork_sources_exhausted' });
  // A different processor can retry: this is not a permanent album blacklist.
  await runtime.DB.prepare(
    "UPDATE cd_artwork_jobs SET provenance=json_set(provenance,'$.processorHash','old-processor') WHERE id IN (?,?)"
  )
    .bind(job.id, retry.id)
    .run();
  expect(
    (
      await selectAutomaticSource(
        runtime,
        1,
        1,
        await ownedAlbum(runtime, 1, 1),
        '',
        1
      )
    ).sourceKind
  ).toBe('cover');
});
it('new listening automatically retries a failed render once and stops when that source is exhausted', async () => {
  const fetcher = providers({
    verdictOverride: { no_added_rim_effects: false },
  });
  await play();
  const create = vi.fn(async () => ({}));
  const target = {
    ...withKey(),
    CD_WORKFLOW: { create },
    CD_DISCOVERY: { create },
  } as unknown as ArtworkEnv;
  const firstCheck = (await runtime.DB.prepare(
    'SELECT id FROM cd_artwork_checks WHERE completed_at IS NULL'
  ).first<{ id: number }>())!;
  await checkListeningArtwork(target, firstCheck.id);
  const first = (await runtime.DB.prepare(
    'SELECT id FROM cd_artwork_jobs ORDER BY created_at DESC LIMIT 1'
  ).first<{ id: string }>())!;
  const step = {
    do: vi.fn(
      async (
        _name: string,
        _options: unknown,
        action: () => Promise<unknown>
      ) => action()
    ),
  } as unknown as WorkflowStep;
  const run = (id: string) =>
    CdArtworkWorkflow.prototype.run.call(
      { env: target } as unknown as CdArtworkWorkflow,
      { payload: { jobId: id, userId: 1 } } as WorkflowEvent<{
        jobId: string;
        userId: number;
      }>,
      step
    );
  await run(first.id);
  expect((await getJob(target, first.id, 1))?.error_code).toBe(
    'automatic_quality_hold'
  );
  expect(await queueRenderRetry(target, first.id, 1)).toBe(false);
  const retryCheck = (await runtime.DB.prepare(
    'SELECT id FROM cd_artwork_checks WHERE completed_at IS NULL'
  ).first<{ id: number }>())!;
  expect(retryCheck.id).not.toBe(firstCheck.id);
  await checkListeningArtwork(target, retryCheck.id);
  const retry = (await runtime.DB.prepare(
    'SELECT id FROM cd_artwork_jobs WHERE id<>?'
  )
    .bind(first.id)
    .first<{ id: string }>())!;
  expect(
    JSON.parse((await getJob(target, retry.id, 1))!.provenance).renderRetry
  ).toEqual({ attempt: 1, reason: 'quality' });
  await run(retry.id);
  const exhaustedCheck = (await runtime.DB.prepare(
    'SELECT id FROM cd_artwork_checks WHERE completed_at IS NULL'
  ).first<{ id: number }>())!;
  expect((await checkListeningArtwork(target, exhaustedCheck.id)).outcome).toBe(
    'source_unavailable'
  );
  expect(
    (
      await runtime.DB.prepare(
        'SELECT COUNT(*) n FROM cd_artwork_checks WHERE completed_at IS NULL'
      ).first<{ n: number }>()
    )?.n
  ).toBe(0);
  expect(
    (
      await runtime.DB.prepare(
        "SELECT COUNT(*) n FROM cd_artwork_events WHERE action='automatic-reprocess-requested'"
      ).first<{ n: number }>()
    )?.n
  ).toBe(0);
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).includes('/images/edits'))
  ).toHaveLength(2);
  expect(await approvedArtwork(target, [1], 1)).toEqual([]);
});
it.each(['pinned', 'review_hold', 'automatic_verification_unavailable'])(
  'does not automate an owner hold or unrelated interruption %s',
  async (blocked) => {
    providers({ verdictOverride: { no_visible_defects: false } });
    const job = await selected();
    await generateOnce(withKey(), job.id, 1);
    await processRaw(withKey(), job.id, 1);
    if (blocked === 'automatic_verification_unavailable')
      await runtime.DB.prepare(
        'UPDATE cd_artwork_jobs SET error_code=? WHERE id=?'
      )
        .bind(blocked, job.id)
        .run();
    else
      await runtime.DB.exec(
        `UPDATE cd_artwork_albums SET ${blocked}=1 WHERE user_id=1 AND album_id=1;`
      );
    expect(await queueRenderRetry(runtime, job.id, 1)).toBe(false);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM cd_artwork_events WHERE action='automatic-render-retry-requested'"
        ).first<{ n: number }>()
      )?.n
    ).toBe(0);
  }
);
it('a verifier outage does not blacklist otherwise usable source artwork', async () => {
  providers({ failVerifier: true });
  const job = await selected(),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  expect(
    (
      await selectAutomaticSource(
        runtime,
        1,
        1,
        await ownedAlbum(runtime, 1, 1),
        '',
        1
      )
    ).sourceKind
  ).toBe('cover');
});
it('changed automatic source bytes create a fresh job while identical bytes reuse it', async () => {
  providers();
  const job = await selected();
  await runtime.DB.prepare(
    "UPDATE cd_artwork_jobs SET state='needs_registration',validation_state='held',error_code='automatic_quality_hold' WHERE id=?"
  )
    .bind(job.id)
    .run();
  const album = await ownedAlbum(runtime, 1, 1);
  const source = await verifiedCover(runtime, 1, 1, album);
  const pixels = readPixels(bytes);
  pixels.data[(512 * 1024 + 800) * 4] = 120;
  source.preparedBytes = png(pixels);
  source.preparedMime = 'image/png';
  const enqueueChanged = () =>
    enqueue(runtime, source.request, 1, false, {
      source,
      expectedActiveJob: null,
      catalogIdentity: album,
    });
  const changed = await enqueueChanged();
  expect(changed.job.id).not.toBe(job.id);
  expect((await enqueueChanged()).job.id).toBe(changed.job.id);
});

it('automatically publishes identity-matched AudioDB artwork without a saved human review', async () => {
  providers({ audioDb: true });
  const job = await selected(true),
    target = withKey();
  expect(
    JSON.parse(job.provenance).sourceIdentityEvidence.audiodb.outcome
  ).toBe('identity_matched_candidate');
  expect(
    (await runtime.ARTWORK.list({ prefix: 'audiodb/reviews/' })).objects
  ).toHaveLength(0);
  await generateOnce(target, job.id, 1);
  expect((await processRaw(target, job.id, 1)).state).toBe('pending');
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('accepted');
});
it('tries AudioDB after the bounded CAA render retry is exhausted', async () => {
  providers({
    retail: true,
    audioDb: true,
    verdictOverride: { concentric_geometry: false },
  });
  const job = await selected(true),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  const album = await ownedAlbum(runtime, 1, 1);
  const retrySource = await selectAutomaticSource(
    runtime,
    1,
    1,
    album,
    RELEASE,
    1
  );
  const { job: retry } = await enqueue(runtime, retrySource.request, 1, false, {
    source: retrySource,
    expectedActiveJob: null,
    catalogIdentity: album,
  });
  expect(retry.source_hash).toBe(job.source_hash);
  await generateOnce(target, retry.id, 1);
  await processRaw(target, retry.id, 1);
  const source = await selectAutomaticSource(
    runtime,
    1,
    1,
    await ownedAlbum(runtime, 1, 1),
    RELEASE,
    1
  );
  expect(source.sourceKind).toBe('retail');
  expect(source.discovery.audiodb).toMatchObject({
    outcome: 'identity_matched_candidate',
  });
  const next = await enqueue(runtime, source.request, 1, false, {
    source,
    expectedActiveJob: null,
    catalogIdentity: await ownedAlbum(runtime, 1, 1),
  });
  expect(next.job.id).not.toBe(job.id);
  expect(next.job.source_hash).not.toBe(job.source_hash);
});

it('the controlled render retry works beyond the retired daily cap without duplicating submission', async () => {
  const fetcher = providers({
    verdictOverride: { concentric_geometry: false },
  });
  const job = await selected(),
    target = withKey();
  await runtime.DB.prepare(
    'UPDATE cd_artwork_control SET daily_limit=1 WHERE id=1'
  ).run();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  const album = await ownedAlbum(runtime, 1, 1);
  const source = await selectAutomaticSource(runtime, 1, 1, album, '', 1);
  const { job: retry } = await enqueue(runtime, source.request, 1, false, {
    source,
    expectedActiveJob: null,
    catalogIdentity: album,
  });
  expect((await generateOnce(target, retry.id, 1)).rawKey).toBeTruthy();
  await generateOnce(target, retry.id, 1);
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).includes('/images/edits'))
  ).toHaveLength(2);
  expect((await getJob(runtime, retry.id, 1))?.state).toBe('submitted');
});
it('persists numeric geometry failures without a verifier call or publication', async () => {
  const fetcher = providers();
  const job = await selected(),
    target = withKey();
  const pixels = readPixels(bytes);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++)
      if (Math.hypot(x + 0.5 - 512, y + 0.5 - 512) < 130)
        pixels.data.set([255, 255, 255, 255], (y * 1024 + x) * 4);
  await runtime.ARTWORK.put(`jobs/1/${job.id}/raw.png`, png(pixels));
  await processRaw(target, job.id, 1);
  const saved = await getJob(runtime, job.id, 1);
  expect(saved?.error_code).toBe('automatic_geometry_hold');
  const inspection = JSON.parse(saved!.provenance).geometryInspection;
  expect(inspection.failures).toContain('scan_normalization_uncertain');
  expect(inspection.rawHash).toMatch(/^[a-f0-9]{64}$/);
  expect(
    fetcher.mock.calls.filter(
      ([url, init]) =>
        String(url).includes('/responses') &&
        JSON.parse(String(init?.body)).text.format.name !==
          'retail_hub_material'
    )
  ).toHaveLength(0);
  expect(await approvedArtwork(target, [1], 1)).toEqual([]);
});

it('allows full-face retail print without imposing a visible hub ring', async () => {
  const fetcher = providers({ retail: true });
  const job = await selected(true),
    target = withKey();
  await runtime.ARTWORK.put(`jobs/1/${job.id}/raw.png`, disc(false));
  expect((await processRaw(target, job.id, 1)).state).toBe('pending');
  expect(
    fetcher.mock.calls.filter(
      ([url, init]) =>
        String(url).includes('/responses') &&
        JSON.parse(String(init?.body)).text.format.name !==
          'retail_hub_material'
    )
  ).toHaveLength(1);
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('accepted');
  const saved = (await getJob(target, job.id, 1))!;
  const object = (await runtime.ARTWORK.get(saved.candidate_key!))!;
  const pixels = readPixels(new Uint8Array(await object.arrayBuffer()));
  expect(pixels.data[(512 * 1024 + 590) * 4 + 3]).toBe(255);
});

it.each([true, false])(
  'the automatic %s-retail candidate contains the shared finish before inspection',
  async (retail) => {
    const fetcher = providers({ retail });
    const job = await selected(retail),
      target = withKey();
    await runtime.ARTWORK.put(`jobs/1/${job.id}/raw.png`, disc(false));
    expect((await processRaw(target, job.id, 1)).state).toBe('pending');
    const saved = (await getJob(target, job.id, 1))!;
    expect(JSON.parse(saved.provenance).normalization.outerEdge).toMatchObject({
      printRadius: 470,
      width: 10,
      color: '#c1c1c1',
    });
    const object = (await runtime.ARTWORK.get(saved.candidate_key!))!;
    const pixels = readPixels(new Uint8Array(await object.arrayBuffer()));
    expect([
      ...pixels.data.slice((512 * 1024 + 987) * 4, (512 * 1024 + 987) * 4 + 4),
    ]).toEqual([193, 193, 193, 255]);
    expect([
      ...pixels.data.slice((512 * 1024 + 750) * 4, (512 * 1024 + 750) * 4 + 4),
    ]).toEqual([75, 90, 105, 255]);
    const calls = fetcher.mock.calls.filter(isFinalVerification);
    expect(calls).toHaveLength(1);
    expect(
      JSON.parse(String(calls[0][1]!.body)).input[0].content[0].text
    ).toContain(
      'shared renderer intentionally replaces only canonical radius 470–480'
    );
  }
);

it('normalizes usable retail art without an image key or incrementing submission usage', async () => {
  const fetcher = providers({ retail: true });
  const job = await selected(true);
  await runtime.DB.prepare(
    'UPDATE cd_artwork_control SET budget_day=?,submitted_count=3 WHERE id=1'
  )
    .bind(now().slice(0, 10))
    .run();
  const target = { ...runtime, OPENAI_API_KEY: undefined } as ArtworkEnv;
  expect((await generateOnce(target, job.id, 1)).rawKey).toBeTruthy();
  const saved = (await getJob(target, job.id, 1))!;
  expect(saved.state).toBe('queued');
  expect(JSON.parse(saved.provenance)).toMatchObject({
    calculatedUsd: 0,
    model: null,
    nativeRendering: { sourceHash: job.source_hash },
  });
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).includes('/images/edits'))
  ).toHaveLength(0);
  expect(
    (
      await runtime.DB.prepare(
        'SELECT submitted_count FROM cd_artwork_control WHERE id=1'
      ).first<{ submitted_count: number }>()
    )?.submitted_count
  ).toBe(3);
});

it('recovers native bytes after an interrupted storage response without double normalization', async () => {
  const fetcher = providers({ retail: true });
  const job = await selected(true),
    target = withKey();
  const rawKey = `jobs/1/${job.id}/raw.png`;
  const put = runtime.ARTWORK.put.bind(runtime.ARTWORK);
  const putter = vi
    .spyOn(runtime.ARTWORK, 'put')
    .mockImplementation(async (...args) => {
      const result = await put(...args);
      if (args[0] === rawKey) throw Error('synthetic_lost_storage_response');
      return result;
    });
  await expect(generateOnce(target, job.id, 1)).rejects.toThrow(
    'synthetic_lost_storage_response'
  );
  putter.mockRestore();
  const interrupted = (await getJob(target, job.id, 1))!;
  expect(interrupted.raw_key).toBeNull();
  const bytes = new Uint8Array(
    await (await runtime.ARTWORK.get(rawKey))!.arrayBuffer()
  );
  expect(JSON.parse(interrupted.provenance).nativeRendering.rawHash).toBe(
    await sha256(bytes)
  );
  expect((await generateOnce(target, job.id, 1)).rawKey).toBe(rawKey);
  expect((await processRaw(target, job.id, 1)).state).toBe('pending');
  const saved = (await getJob(target, job.id, 1))!;
  expect(saved.candidate_hash).toBe(await sha256(bytes));
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('accepted');
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).includes('/images/edits'))
  ).toHaveLength(0);
});

it.each(['proof', 'bytes'])(
  'holds tampered native %s before visual grading or publication',
  async (mode) => {
    const fetcher = providers({ retail: true });
    const job = await selected(true),
      target = withKey();
    await generateOnce(target, job.id, 1);
    if (mode === 'proof')
      await runtime.DB.prepare(
        "UPDATE cd_artwork_jobs SET provenance=json_set(provenance,'$.nativeRendering.sourceHash','wrong') WHERE id=?"
      )
        .bind(job.id)
        .run();
    else {
      const saved = (await getJob(target, job.id, 1))!;
      const raw = readPixels(
        new Uint8Array(
          await (await runtime.ARTWORK.get(saved.raw_key!))!.arrayBuffer()
        )
      );
      raw.data[(512 * 1024 + 800) * 4] = 255;
      await runtime.ARTWORK.put(saved.raw_key!, png(raw));
    }
    expect((await processRaw(target, job.id, 1)).state).toBe(
      'needs_registration'
    );
    expect((await getJob(target, job.id, 1))?.error_code).toBe(
      'automatic_geometry_hold'
    );
    expect(
      fetcher.mock.calls.filter(
        ([url, init]) =>
          String(url).includes('/responses') &&
          JSON.parse(String(init?.body)).text.format.name !==
            'retail_hub_material'
      )
    ).toHaveLength(0);
    expect((await publishAutomatic(target, job.id, 1)).state).toBe('held');
  }
);

it('a failed native material check gets one bounded image restoration instead of the same native result', async () => {
  const fetcher = providers({
    retail: true,
    verdictOverride: { material_preserved: false },
  });
  const job = await selected(true),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  expect((await getJob(target, job.id, 1))?.error_code).toBe(
    'automatic_quality_hold'
  );
  const album = await ownedAlbum(runtime, 1, 1);
  const source = await selectAutomaticSource(runtime, 1, 1, album, RELEASE, 1);
  expect(source.renderRetry).toEqual({ attempt: 1, reason: 'quality' });
  const { job: retry } = await enqueue(runtime, source.request, 1, false, {
    source,
    expectedActiveJob: null,
    catalogIdentity: album,
  });
  await generateOnce(target, retry.id, 1);
  const calls = fetcher.mock.calls.filter(([url]) =>
    String(url).includes('/images/edits')
  );
  expect(calls).toHaveLength(1);
  const form = calls[0][1]!.body as FormData;
  expect(form.get('background')).toBe('transparent');
  expect(form.get('prompt')).toContain(
    'Material identification and clear-plastic alpha are handled separately by the renderer'
  );
  expect(
    JSON.parse((await getJob(target, retry.id, 1))!.provenance).nativeRendering
  ).toBeUndefined();
  await processRaw(target, retry.id, 1);
  expect((await publishAutomatic(target, retry.id, 1)).state).toBe('held');
  // This fixture serves identical bytes as the cover too. The exhausted hash
  // must not gain another paid attempt just by appearing at a different URL.
  await expect(
    selectAutomaticSource(runtime, 1, 1, album, RELEASE, 1)
  ).rejects.toMatchObject({ code: 'artwork_sources_exhausted' });
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).includes('/images/edits'))
  ).toHaveLength(1);
});

it.each([false, true])(
  'uncertain native geometry falls back to the provider while respecting processing disabled=%s',
  async (disabled) => {
    const pixels = readPixels(bytes);
    for (let y = 0; y < 1024; y++)
      for (let x = 0; x < 1024; x++)
        if (Math.hypot(x + 0.5 - 512, y + 0.5 - 512) < 130)
          pixels.data.set([255, 255, 255, 255], (y * 1024 + x) * 4);
    const fetcher = providers({ retail: true, retailSource: png(pixels) });
    const job = await selected(true),
      target = withKey();
    if (disabled)
      await runtime.DB.prepare(
        'UPDATE cd_artwork_control SET enabled=0 WHERE id=1'
      ).run();
    const result = await generateOnce(target, job.id, 1);
    expect(!!result.rawKey).toBe(!disabled);
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).includes('/images/edits')
      )
    ).toHaveLength(disabled ? 0 : 1);
    const saved = (await getJob(target, job.id, 1))!;
    expect(JSON.parse(saved.provenance).nativeRendering).toBeUndefined();
    if (disabled) expect(saved.state).toBe('queued');
  }
);

it('material identification precedes grading and the cover hub is checked in the exact published bytes', async () => {
  const fetcher = providers();
  const job = await selected(),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  const saved = (await getJob(target, job.id, 1))!;
  const p = JSON.parse(saved.provenance);
  expect(p.hubVerification.treatment).toEqual({ mode: 'cover' });
  const object = (await runtime.ARTWORK.get(saved.candidate_key!))!;
  const bytes = new Uint8Array(await object.arrayBuffer()),
    image = readPixels(bytes);
  expect(image.data[(512 * 1024 + 588) * 4 + 3]).toBe(117);
  expect(image.data[(512 * 1024 + 750) * 4 + 3]).toBe(255);
  expect(p.verifiedMaterialHash).toBe(await sha256(bytes));
  expect(
    fetcher.mock.calls.filter(
      ([url, init]) =>
        String(url).includes('/responses') &&
        JSON.parse(String(init?.body)).text.format.name ===
          'retail_hub_material'
    )
  ).toHaveLength(0);
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('accepted');
});
it('native source alpha is retained without asking a model to identify its material', async () => {
  const source = readPixels(disc());
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512);
      if (r > 64 && r < 96) source.data[(y * 1024 + x) * 4 + 3] = 117;
    }
  const fetcher = providers({ retail: true, retailSource: png(source) });
  const job = await selected(true),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  const saved = (await getJob(target, job.id, 1))!;
  expect(saved.state).toBe('pending');
  expect(JSON.parse(saved.provenance).hubVerification.treatment.mode).toBe(
    'preserve'
  );
  expect(
    fetcher.mock.calls.filter(
      ([url, init]) =>
        String(url).includes('/responses') &&
        JSON.parse(String(init?.body)).text.format.name ===
          'retail_hub_material'
    )
  ).toHaveLength(0);
  const object = (await runtime.ARTWORK.get(saved.candidate_key!))!;
  expect(
    readPixels(new Uint8Array(await object.arrayBuffer())).data[
      (512 * 1024 + 588) * 4 + 3
    ]
  ).toBe(117);
});
it('keeps uncertain center pixels unchanged and still runs final artwork grading', async () => {
  const fetcher = providers({
    retail: true,
    hubDecision: {
      kind: 'uncertain',
      confidence: 'uncertain',
      region_id: null,
      unprinted: false,
      non_metallic: false,
    },
  });
  const job = await selected(true),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  const saved = (await getJob(target, job.id, 1))!;
  expect(saved.error_code).toBeNull();
  expect(saved.candidate_key).not.toBeNull();
  expect(JSON.parse(saved.provenance).hubVerification.treatment.mode).toBe(
    'preserve'
  );
  expect(fetcher.mock.calls.filter(isFinalVerification)).toHaveLength(1);
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('accepted');
  const count = fetcher.mock.calls.length;
  await processRaw(target, job.id, 1);
  expect(fetcher.mock.calls.length).toBe(count);
});
it('rejects a publication proof whose material hash no longer matches the candidate', async () => {
  providers();
  const job = await selected(),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  await runtime.DB.prepare(
    "UPDATE cd_artwork_jobs SET provenance=json_set(provenance,'$.verifiedMaterialHash','wrong') WHERE id=?"
  )
    .bind(job.id)
    .run();
  expect((await publishAutomatic(target, job.id, 1)).state).toBe('held');
  expect(await approvedArtwork(target, [1], 1)).toEqual([]);
});

it('recovers a transient material classifier outage once using the same saved raw bytes', async () => {
  const fetcher = providers({ retail: true, failVerifier: true });
  const job = await selected(true),
    target = withKey();
  await generateOnce(target, job.id, 1);
  expect((await processRaw(target, job.id, 1)).state).toBe('held');
  expect((await getJob(target, job.id, 1))?.validation_state).toBe('claimed');
  expect((await processRaw(target, job.id, 1)).state).toBe('held');
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).includes('/responses'))
  ).toHaveLength(1);
  await runtime.DB.prepare(
    "UPDATE cd_artwork_jobs SET validation_lease_until='2000-01-01' WHERE id=?"
  )
    .bind(job.id)
    .run();
  fetcher.mockRestore();
  const recovered = providers({ retail: true });
  expect((await processRaw(target, job.id, 1)).state).toBe('pending');
  expect(
    recovered.mock.calls.filter(([url]) =>
      String(url).includes('/images/edits')
    )
  ).toHaveLength(0);
});
it('exhausts transient material recovery after two attempts without looping', async () => {
  const fetcher = providers({ retail: true, failVerifier: true });
  const job = await selected(true),
    target = withKey();
  await generateOnce(target, job.id, 1);
  await processRaw(target, job.id, 1);
  await runtime.DB.prepare(
    "UPDATE cd_artwork_jobs SET validation_lease_until='2000-01-01' WHERE id=?"
  )
    .bind(job.id)
    .run();
  await processRaw(target, job.id, 1);
  expect((await getJob(target, job.id, 1))?.validation_state).toBe('held');
  await processRaw(target, job.id, 1);
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).includes('/responses'))
  ).toHaveLength(2);
});

it.each([false, true])(
  'replays cached material proof after a candidate write interruption and rejects changed decision=%s',
  async (tampered) => {
    const fetcher = providers({ retail: true }),
      target = withKey(),
      job = await selected(true);
    await generateOnce(target, job.id, 1);
    const put = vi
      .spyOn(runtime.ARTWORK, 'put')
      .mockRejectedValueOnce(Error('synthetic_candidate_write_interruption'));
    await expect(processRaw(target, job.id, 1)).rejects.toThrow(
      'synthetic_candidate_write_interruption'
    );
    put.mockRestore();
    const saved = (await getJob(target, job.id, 1))!;
    expect(saved.candidate_key).toBeNull();
    expect(JSON.parse(saved.provenance).verifiedMaterialHash).toBeTruthy();
    if (tampered)
      await runtime.DB.prepare(
        "UPDATE cd_artwork_jobs SET provenance=json_set(provenance,'$.hubDecision',json(?)) WHERE id=?"
      )
        .bind(
          JSON.stringify({
            kind: 'clear_plastic',
            confidence: 'high',
            region_id: 999,
            unprinted: true,
            non_metallic: true,
          }),
          job.id
        )
        .run();
    const calls = fetcher.mock.calls.length;
    expect((await processRaw(target, job.id, 1)).state).toBe(
      tampered ? 'needs_registration' : 'pending'
    );
    expect(fetcher.mock.calls.length).toBe(calls);
    if (tampered)
      expect((await getJob(target, job.id, 1))?.error_code).toBe(
        'automatic_verification_stale'
      );
  }
);

it('uses real legacy play evidence only for the explicitly queued historical replay', async () => {
  providers();
  await runtime.DB.exec(
    "UPDATE cd_artwork_control SET enroll_since='2099-01-01'; INSERT INTO lastfm_scrobbles(user_id,track_id,album_recorded,scrobbled_at,created_at) VALUES(1,1,0,'2026-01-01','2026-01-01')"
  );
  await queueArtworkReprocessing(runtime, 1, [1], false);
  const check = (await runtime.DB.prepare(
    'SELECT id FROM cd_artwork_checks'
  ).first<{ id: number }>())!;
  const target = {
    ...withKey(),
    CD_WORKFLOW: { create: vi.fn(async () => ({})) },
  } as unknown as ArtworkEnv;
  expect((await checkListeningArtwork(target, check.id)).outcome).toBe(
    'generation_queued'
  );
  expect(
    (await runtime.DB.prepare(
      'SELECT COUNT(*) n FROM lastfm_scrobbles'
    ).first())!.n
  ).toBe(1);
  expect(
    (await runtime.DB.prepare(
      'SELECT COUNT(*) n FROM cd_artwork_jobs WHERE automatic=1'
    ).first())!.n
  ).toBe(1);
});
