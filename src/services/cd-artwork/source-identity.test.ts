import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import {
  resolveSource,
  resolveEditionCandidates,
  providerJson,
} from './sources.js';
import type { ArtworkEnv } from './types.js';
const runtime = env as typeof env & ArtworkEnv;
const sourceId = '11111111-1111-4111-8111-111111111111';
const storedId = '22222222-2222-4222-8222-222222222222';
const groupId = '33333333-3333-4333-8333-333333333333';
const foreignGroup = '44444444-4444-4444-8444-444444444444';
const artistId = '55555555-5555-4555-8555-555555555555';
const album = {
  name: 'Synthetic',
  artist: 'Synthetic',
  mbid: storedId,
  artist_mbid: artistId,
};
const input = {
  album_id: 1,
  release_id: sourceId,
  medium_position: 1,
  source_kind: 'cover' as const,
};
const release = (group = groupId, artist = artistId) => ({
  id: sourceId,
  title: 'Synthetic',
  status: 'Official',
  'release-group': { id: group },
  media: [{ format: 'CD', position: 1 }],
  'artist-credit': [
    { name: 'Synthetic', artist: { id: artist, name: 'Synthetic' } },
  ],
});
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, runtime.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await runtime.DB.prepare(
    'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1'
  ).run();
});
afterEach(() => vi.unstubAllGlobals());
function mock({
  entity = 'release',
  group = groupId,
  artist = artistId,
  failure = 0,
}: {
  entity?: string;
  group?: string;
  artist?: string;
  failure?: number;
} = {}) {
  const fetcher = vi.fn(async (url: string) => {
    const u = String(url);
    let data: unknown;
    let status = 200;
    if (u.includes('/release/' + sourceId)) data = release(group, artist);
    else if (u.includes('/release/' + storedId)) {
      if (failure) status = failure;
      else if (entity === 'release') data = release();
      else status = 404;
    } else if (u.includes('/release-group/' + storedId)) data = { id: groupId };
    else if (u.includes('/release/?'))
      data = { releases: [release(), release(foreignGroup)] };
    else if (u.includes('coverartarchive.org')) data = { images: [] };
    else throw Error('Unexpected provider');
    return new Response(JSON.stringify(data ?? {}), {
      status,
      headers: {
        'content-type': 'application/json',
        ...(status === 429 ? { 'retry-after': '7200' } : {}),
      },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
it('rejects a same-artist self-title from a different logical album before archive or generation work', async () => {
  const fetcher = mock({ group: foreignGroup });
  await expect(
    resolveSource(runtime, input, album, true)
  ).rejects.toMatchObject({ code: 'edition_identity_mismatch' });
  expect(
    fetcher.mock.calls.some(([url]) => String(url).includes('coverartarchive'))
  ).toBe(false);
});
it.each(['release', 'release-group'])(
  'resolves stored %s namespace and allows a same-group representative CD',
  async (entity) => {
    mock({ entity });
    expect(
      (await resolveSource(runtime, input, album, true)).discovery.outcome
    ).toBe('not_found');
  }
);
it('rejects a different MusicBrainz artist with an identical display name', async () => {
  const fetcher = mock({ artist: foreignGroup });
  await expect(
    resolveSource(runtime, input, album, true)
  ).rejects.toMatchObject({ code: 'edition_identity_mismatch' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('defers a provider rate limit without interpreting it as the other entity namespace', async () => {
  const fetcher = mock({ failure: 429 });
  await expect(
    resolveSource(runtime, input, album, true)
  ).rejects.toMatchObject({
    code: 'discovery_provider_error',
    retryAfter: 7200,
  });
  expect(
    fetcher.mock.calls.some(([url]) => String(url).includes('/release-group/'))
  ).toBe(false);
});
it('restricts candidate search and returned candidates to the verified catalog group', async () => {
  const fetcher = mock();
  expect(
    (await resolveEditionCandidates(runtime, album)).candidates
  ).toHaveLength(1);
  const url = String(
    fetcher.mock.calls.find(([url]) => String(url).includes('/release/?'))![0]
  );
  expect(new URL(url).searchParams.get('query')).toContain('rgid:' + groupId);
  expect(new URL(url).searchParams.get('query')).toContain('arid:' + artistId);
});
it('keeps unidentified self-titled candidates as explicit edition choices', async () => {
  const fetcher = mock();
  const result = await resolveEditionCandidates(runtime, {
    ...album,
    mbid: null,
  });
  expect(result.outcome).toBe('edition_choice_required');
  expect(result.candidates).toHaveLength(2);
  expect(result.candidates.every((c) => c.requires_medium_verification)).toBe(
    true
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('busy callers do not reserve unused provider slots or wait an hour for local capacity', async () => {
  const future = Date.now() + 20000;
  await runtime.DB.prepare(
    'UPDATE cd_artwork_control SET provider_next_ms=? WHERE id=1'
  )
    .bind(future)
    .run();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(
    providerJson(runtime, 'https://musicbrainz.org/ws/2/release/' + sourceId)
  ).rejects.toMatchObject({
    code: 'discovery_busy',
    status: 429,
    retryAfter: expect.any(Number),
  });
  expect(
    (
      await runtime.DB.prepare(
        'SELECT provider_next_ms FROM cd_artwork_control WHERE id=1'
      ).first<{ provider_next_ms: number }>()
    )?.provider_next_ms
  ).toBe(future);
  expect(fetcher).not.toHaveBeenCalled();
});
