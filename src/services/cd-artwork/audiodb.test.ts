import { env, applyD1Migrations } from 'cloudflare:test';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { encode as encodePng } from 'fast-png';
import type { ArtworkEnv } from './types.js';
import { sha256 } from './types.js';
import {
  prepareAudioDbArtwork,
  reviewAudioDbArtwork,
  readReviewedAudioDbArtwork,
  readAudioDbReviewHash,
  findReviewedAudioDbArtwork,
} from './audiodb.js';
import { resolveSource } from './sources.js';
import { selectAutomaticSource } from './selection.js';

const runtime = env as typeof env & ArtworkEnv;
const GROUP = '33333333-3333-4333-8333-333333333333';
const RELEASE = '11111111-1111-4111-8111-111111111111';
const ALBUM = { name: 'Synthetic Album', artist: 'Synthetic Artist' };
const IMAGE_URL = 'https://r2.theaudiodb.com/images/media/album/cdart/123.png';
function pngImage(seed = 1) {
  const pixels = new Uint8Array(700 * 700 * 4).fill(255);
  pixels[0] = seed;
  return encodePng({ width: 700, height: 700, data: pixels });
}
const png = pngImage();

beforeAll(async () => applyD1Migrations(runtime.DB, runtime.TEST_MIGRATIONS));
beforeEach(async () => {
  await runtime.DB.prepare(
    'UPDATE cd_artwork_control SET provider_next_ms=0 WHERE id=1'
  ).run();
  for (const key of [
    'audiodb/reviews/1/99/' + GROUP + '/123.json',
    'audiodb/reviews/2/99/' + GROUP + '/123.json',
  ])
    await runtime.ARTWORK.delete(key);
  await runtime.ARTWORK.delete(
    `audiodb/reviewed-assets/${await sha256(png)}.png`
  );
});
afterEach(() => vi.unstubAllGlobals());

function mockProvider({
  group = GROUP,
  includeGroup = true,
}: { group?: string; includeGroup?: boolean } = {}) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('theaudiodb.com/api/'))
      return Response.json({
        album: [
          {
            idAlbum: '123',
            strAlbum: ALBUM.name,
            strArtist: ALBUM.artist,
            ...(includeGroup ? { strMusicBrainzReleaseGroupID: group } : {}),
            strAlbumCDart: IMAGE_URL,
          },
        ],
      });
    if (url === IMAGE_URL)
      return new Response(png.slice().buffer, {
        headers: { 'content-type': 'image/png' },
      });
    if (url.includes('musicbrainz.org/ws/2/release/'))
      return Response.json({
        id: RELEASE,
        title: ALBUM.name,
        'release-group': { id: GROUP },
        media: [{ format: 'CD', position: 1 }],
        'artist-credit': [
          { name: ALBUM.artist, artist: { name: ALBUM.artist } },
        ],
      });
    if (url.includes('coverartarchive.org'))
      return Response.json({ images: [] });
    throw Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('AudioDB reviewed CD art', () => {
  it('spaces free API calls by at least 2100ms and binds exact metadata, URL, and bytes', async () => {
    const fetcher = mockProvider();
    const reservationStart = Date.now();
    const prepared = await prepareAudioDbArtwork(runtime, ALBUM, GROUP);
    expect(prepared).toMatchObject({
      groupId: GROUP,
      providerAlbumId: '123',
      sourceUrl: IMAGE_URL,
      sourceSha256: await sha256(png),
    });
    const reserved = await runtime.DB.prepare(
      'SELECT provider_next_ms FROM cd_artwork_control WHERE id=1'
    ).first<{ provider_next_ms: number }>();
    expect(reserved!.provider_next_ms).toBeGreaterThanOrEqual(
      reservationStart + 2100
    );
    expect(
      new URL(
        String(
          fetcher.mock.calls.find(([u]) =>
            String(u).includes('theaudiodb.com/api/')
          )![0]
        )
      ).pathname
    ).toBe('/api/v1/json/123/album-mb.php');
    const binding = await reviewAudioDbArtwork(
      runtime,
      1,
      99,
      ALBUM,
      prepared!,
      true,
      'Owner confirmed the pictured disc art is official.'
    );
    expect(
      fetcher.mock.calls.filter(([u]) =>
        String(u).includes('theaudiodb.com/api/')
      )
    ).toHaveLength(2);
    const reviewed = await readReviewedAudioDbArtwork(runtime, 1, 99, binding);
    expect(reviewed).toMatchObject({
      ...binding,
      officialArtwork: true,
      bytes: png,
    });
    expect(await readAudioDbReviewHash(runtime, 1, 99, GROUP, '123')).toBe(
      binding.sourceSha256
    );
    expect(
      await readReviewedAudioDbArtwork(runtime, 2, 99, binding)
    ).toBeNull();
  });

  it('rejects metadata contradictions and unsafe CDN URLs', async () => {
    mockProvider({ group: '44444444-4444-4444-8444-444444444444' });
    await expect(
      prepareAudioDbArtwork(runtime, ALBUM, GROUP)
    ).rejects.toMatchObject({ code: 'audiodb_identity_contradiction' });
    vi.restoreAllMocks();
    const fetcher = mockProvider();
    fetcher.mockImplementation(async (input) => {
      if (String(input).includes('theaudiodb.com/api/'))
        return Response.json({
          album: [
            {
              idAlbum: '123',
              strAlbum: ALBUM.name,
              strArtist: ALBUM.artist,
              strMusicBrainzReleaseGroupID: GROUP,
              strAlbumCDart: 'https://example.com/image.png',
            },
          ],
        });
      throw Error('unsafe URL must not be fetched');
    });
    await expect(
      prepareAudioDbArtwork(runtime, ALBUM, GROUP)
    ).rejects.toMatchObject({ code: 'audiodb_cdart_url_invalid' });
    vi.restoreAllMocks();
    const nested = mockProvider();
    nested.mockImplementation(async (input) => {
      if (String(input).includes('theaudiodb.com/api/'))
        return Response.json({
          album: [
            {
              idAlbum: '123',
              strAlbum: ALBUM.name,
              strArtist: ALBUM.artist,
              strMusicBrainzReleaseGroupID: GROUP,
              strAlbumCDart:
                'https://r2.theaudiodb.com/images/media/album/cdart/nested/123.png',
            },
          ],
        });
      throw Error('nested path must be rejected before download');
    });
    await expect(
      prepareAudioDbArtwork(runtime, ALBUM, GROUP)
    ).rejects.toMatchObject({ code: 'audiodb_cdart_url_invalid' });
  });

  it('bounds decoded source dimensions before processing pixel data', async () => {
    const tooSmall = encodePng({
      width: 640,
      height: 700,
      data: new Uint8Array(640 * 700 * 4).fill(255),
    });
    const fetcher = mockProvider();
    fetcher.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('theaudiodb.com/api/'))
        return Response.json({
          album: [
            {
              idAlbum: '123',
              strAlbum: ALBUM.name,
              strArtist: ALBUM.artist,
              strMusicBrainzReleaseGroupID: GROUP,
              strAlbumCDart: IMAGE_URL,
            },
          ],
        });
      if (url === IMAGE_URL)
        return new Response(tooSmall.buffer as ArrayBuffer);
      throw Error(`Unexpected request ${url}`);
    });
    await expect(
      prepareAudioDbArtwork(runtime, ALBUM, GROUP)
    ).rejects.toMatchObject({ code: 'audiodb_image_dimensions_invalid' });
    const oversized = png.slice();
    new DataView(
      oversized.buffer,
      oversized.byteOffset,
      oversized.byteLength
    ).setUint32(16, 4000);
    new DataView(
      oversized.buffer,
      oversized.byteOffset,
      oversized.byteLength
    ).setUint32(20, 3001);
    fetcher.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('theaudiodb.com/api/'))
        return Response.json({
          album: [
            {
              idAlbum: '123',
              strAlbum: ALBUM.name,
              strArtist: ALBUM.artist,
              strMusicBrainzReleaseGroupID: GROUP,
              strAlbumCDart: IMAGE_URL,
            },
          ],
        });
      if (url === IMAGE_URL)
        return new Response(oversized.buffer as ArrayBuffer);
      throw Error(`Unexpected request ${url}`);
    });
    await expect(
      prepareAudioDbArtwork(runtime, ALBUM, GROUP)
    ).rejects.toMatchObject({ code: 'audiodb_image_dimensions_invalid' });
  });

  it('selects exact-identity candidates without a human approval record', async () => {
    const fetcher = mockProvider();
    const selected = await selectAutomaticSource(
      runtime,
      99,
      1,
      ALBUM,
      RELEASE,
      1
    );
    expect(selected).toMatchObject({
      sourceKind: 'retail',
      identityType: 'representative_release',
      selectedImageId: null,
      preparedMime: 'image/png',
      preparedBytes: png,
      request: {
        album_id: 99,
        release_id: RELEASE,
        medium_position: 1,
        source_kind: 'retail',
      },
      discovery: {
        release_group_id: GROUP,
        medium_verified: true,
        audiodb: {
          outcome: 'identity_matched_candidate',
          provider_album_id: '123',
          requires_automatic_visual_verification: true,
          source_sha256: await sha256(png),
        },
      },
    });
    expect(selected.request.image_id).toBeUndefined();
    expect(
      fetcher.mock.calls.filter(([u]) =>
        String(u).includes('coverartarchive.org')
      )
    ).toHaveLength(1);
  });

  it('does not reuse a review after same-URL bytes change and allows explicit CAS re-review', async () => {
    mockProvider();
    const first = await prepareAudioDbArtwork(runtime, ALBUM, GROUP);
    const binding = await reviewAudioDbArtwork(
      runtime,
      1,
      99,
      ALBUM,
      first!,
      true,
      'Owner confirms official artwork v1.'
    );
    const changed = pngImage(2);
    const fetcher = mockProvider();
    fetcher.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('theaudiodb.com/api/'))
        return Response.json({
          album: [
            {
              idAlbum: '123',
              strAlbum: ALBUM.name,
              strArtist: ALBUM.artist,
              strMusicBrainzReleaseGroupID: GROUP,
              strAlbumCDart: IMAGE_URL,
            },
          ],
        });
      if (url === IMAGE_URL)
        return new Response(changed.slice().buffer as ArrayBuffer, {
          headers: { 'content-type': 'image/png' },
        });
      if (url.includes('musicbrainz.org/ws/2/release/'))
        return Response.json({
          id: RELEASE,
          title: ALBUM.name,
          'release-group': { id: GROUP },
          media: [{ format: 'CD', position: 1 }],
          'artist-credit': [
            { name: ALBUM.artist, artist: { name: ALBUM.artist } },
          ],
        });
      if (url === 'https://coverartarchive.org/cover.png')
        return new Response(png.slice().buffer as ArrayBuffer, {
          headers: { 'content-type': 'image/png' },
        });
      if (url.includes('coverartarchive.org'))
        return Response.json({
          images: [
            {
              id: 9,
              approved: true,
              types: ['Front'],
              image: 'https://coverartarchive.org/cover.png',
            },
          ],
        });
      throw Error(`Unexpected request ${url}`);
    });
    const automatic = await selectAutomaticSource(
      runtime,
      99,
      1,
      ALBUM,
      RELEASE,
      1
    );
    expect(automatic.sourceKind).toBe('retail');
    expect(automatic.preparedBytes).toEqual(changed);
    expect(automatic.discovery.audiodb).toMatchObject({
      source_sha256: await sha256(changed),
      requires_automatic_visual_verification: true,
    });
    expect(
      await findReviewedAudioDbArtwork(runtime, 1, 99, ALBUM, GROUP)
    ).toBeNull();
    const newPrepared = await prepareAudioDbArtwork(runtime, ALBUM, GROUP);
    expect(newPrepared!.sourceSha256).not.toBe(binding.sourceSha256);
    await expect(
      reviewAudioDbArtwork(
        runtime,
        1,
        99,
        ALBUM,
        newPrepared!,
        true,
        'Owner confirms official artwork v2.'
      )
    ).rejects.toMatchObject({ code: 'audiodb_review_conflict' });
    const updated = await reviewAudioDbArtwork(
      runtime,
      1,
      99,
      ALBUM,
      newPrepared!,
      true,
      'Owner confirms official artwork v2.',
      binding.sourceSha256
    );
    expect(updated.sourceSha256).toBe(newPrepared!.sourceSha256);
    expect(
      (await findReviewedAudioDbArtwork(runtime, 1, 99, ALBUM, GROUP))?.bytes
    ).toEqual(changed);
  });

  it('skips provider asset fetches when the release has no confirmed group', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('musicbrainz.org'))
        return Response.json({
          id: RELEASE,
          title: ALBUM.name,
          media: [{ format: 'CD', position: 1 }],
          'artist-credit': [
            { name: ALBUM.artist, artist: { name: ALBUM.artist } },
          ],
        });
      if (url.includes('coverartarchive.org'))
        return Response.json({ images: [] });
      throw Error(`unexpected provider call ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const found = await resolveSource(
      runtime,
      {
        album_id: 99,
        release_id: RELEASE,
        medium_position: 1,
        source_kind: 'retail',
      },
      ALBUM,
      true
    );
    expect(found.discovery.release_group_id).toBeNull();
    expect(
      fetcher.mock.calls.some(([u]) => String(u).includes('theaudiodb.com'))
    ).toBe(false);
  });
});
