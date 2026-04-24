import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { env } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import { lastfmArtists } from '../../db/schema/lastfm.js';
import { images } from '../../db/schema/system.js';
import { setupTestDb } from '../../test-helpers.js';

// Mock runPipeline so we're testing only the sync-images wrapper logic,
// not the full R2 / thumbhash / color-extraction pipeline (which has its
// own tests).
vi.mock('./pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pipeline.js')>();
  return {
    ...actual,
    runPipeline: vi.fn(),
  };
});

import { runPipeline } from './pipeline.js';
import { refreshArtistImageFromAppleMusicId } from './sync-images.js';
import type { PipelineEnv } from './pipeline.js';

const mockRunPipeline = vi.mocked(runPipeline);

function makePipelineEnv(overrides: Partial<PipelineEnv> = {}): PipelineEnv {
  return {
    IMAGES: {} as R2Bucket,
    IMAGE_TRANSFORMS: {} as ImagesBinding,
    APPLE_MUSIC_DEVELOPER_TOKEN: 'test-token',
    ...overrides,
  };
}

function mockAppleMusicArtwork(artworkUrl: string | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: artworkUrl
            ? [
                {
                  id: '42',
                  attributes: {
                    artwork: {
                      url: artworkUrl,
                      width: 1000,
                      height: 1000,
                    },
                  },
                },
              ]
            : [],
        }),
    })
  );
}

describe('refreshArtistImageFromAppleMusicId', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(images);
    await db.delete(lastfmArtists);
    mockRunPipeline.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns zero-work without calling Apple Music when token is unset', async () => {
    await db.insert(lastfmArtists).values({
      name: 'Stale Artist',
      appleMusicId: 12345,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshArtistImageFromAppleMusicId(
      db,
      makePipelineEnv({ APPLE_MUSIC_DEVELOPER_TOKEN: undefined }),
      10
    );

    expect(result.queued).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('skips artists without an apple_music_id', async () => {
    await db.insert(lastfmArtists).values({
      name: 'No Apple Id',
      appleMusicId: null,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshArtistImageFromAppleMusicId(
      db,
      makePipelineEnv(),
      10
    );

    expect(result.queued).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls runPipeline with a pre-resolved candidate on artwork hit', async () => {
    const [artist] = await db
      .insert(lastfmArtists)
      .values({ name: 'Tunitas', appleMusicId: 9999, playcount: 10 })
      .returning({ id: lastfmArtists.id });

    mockAppleMusicArtwork(
      'https://is1-ssl.mzstatic.com/image/thumb/Artist/{w}x{h}.jpg'
    );
    mockRunPipeline.mockResolvedValue({
      r2Key: `listening/artists/${artist.id}/original.jpg`,
      source: 'apple-music',
      sourceUrl:
        'https://is1-ssl.mzstatic.com/image/thumb/Artist/1000x1000.jpg',
      width: 1000,
      height: 1000,
      thumbhash: 'abc',
      dominantColor: '#000',
      accentColor: '#fff',
      imageVersion: 1,
    });

    const result = await refreshArtistImageFromAppleMusicId(
      db,
      makePipelineEnv(),
      10
    );

    expect(result.succeeded).toBe(1);
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    const [, , params, options] = mockRunPipeline.mock.calls[0];
    expect(params).toMatchObject({
      domain: 'listening',
      entityType: 'artists',
      entityId: String(artist.id),
      artistName: 'Tunitas',
    });
    expect(options?.prefetchedCandidates).toHaveLength(1);
    expect(options?.prefetchedCandidates?.[0].source).toBe('apple-music');
    // Template placeholders should be substituted with '1000'
    expect(options?.prefetchedCandidates?.[0].url).toContain('1000x1000');
  });

  it('writes a placeholder when the catalog has no artwork', async () => {
    const [artist] = await db
      .insert(lastfmArtists)
      .values({ name: 'Obscure', appleMusicId: 1 })
      .returning({ id: lastfmArtists.id });

    mockAppleMusicArtwork(null);

    const result = await refreshArtistImageFromAppleMusicId(
      db,
      makePipelineEnv(),
      10
    );

    expect(result.skipped).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(mockRunPipeline).not.toHaveBeenCalled();

    const [placeholder] = await db
      .select()
      .from(images)
      .where(
        and(
          eq(images.domain, 'listening'),
          eq(images.entityType, 'artists'),
          eq(images.entityId, String(artist.id))
        )
      );
    expect(placeholder).toBeDefined();
    expect(placeholder.source).toBe('none');
    expect(placeholder.r2Key).toBe('');
  });

  it('retries a stale null-source placeholder (>7 days old)', async () => {
    const [artist] = await db
      .insert(lastfmArtists)
      .values({ name: 'Stale Tunitas', appleMusicId: 77 })
      .returning({ id: lastfmArtists.id });

    // Seed a null-source placeholder that is 10 days old
    const tenDaysAgo = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000
    ).toISOString();
    await db.insert(images).values({
      domain: 'listening',
      entityType: 'artists',
      entityId: String(artist.id),
      r2Key: '',
      source: 'none',
      imageVersion: 0,
      createdAt: tenDaysAgo,
    });

    mockAppleMusicArtwork(
      'https://is1-ssl.mzstatic.com/image/thumb/Artist/{w}x{h}.jpg'
    );
    mockRunPipeline.mockResolvedValue({
      r2Key: `listening/artists/${artist.id}/original.jpg`,
      source: 'apple-music',
      sourceUrl: 'https://example.com',
      width: 1000,
      height: 1000,
      thumbhash: 'abc',
      dominantColor: '#000',
      accentColor: '#fff',
      imageVersion: 1,
    });

    const result = await refreshArtistImageFromAppleMusicId(
      db,
      makePipelineEnv(),
      10
    );

    expect(result.succeeded).toBe(1);
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a fresh null-source placeholder (<7 days old)', async () => {
    const [artist] = await db
      .insert(lastfmArtists)
      .values({ name: 'Freshly Placeheld', appleMusicId: 88 })
      .returning({ id: lastfmArtists.id });

    const threeDaysAgo = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000
    ).toISOString();
    await db.insert(images).values({
      domain: 'listening',
      entityType: 'artists',
      entityId: String(artist.id),
      r2Key: '',
      source: 'none',
      imageVersion: 0,
      createdAt: threeDaysAgo,
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshArtistImageFromAppleMusicId(
      db,
      makePipelineEnv(),
      10
    );

    expect(result.queued).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('handles 404 from Apple Music gracefully (stale id)', async () => {
    await db.insert(lastfmArtists).values({
      name: 'Dead Id',
      appleMusicId: 999999999,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404 })
    );

    const result = await refreshArtistImageFromAppleMusicId(
      db,
      makePipelineEnv(),
      10
    );

    expect(result.skipped).toBe(1);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('skips filtered artists even if they have an apple_music_id', async () => {
    await db.insert(lastfmArtists).values({
      name: 'Filtered',
      appleMusicId: 123,
      isFiltered: 1,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshArtistImageFromAppleMusicId(
      db,
      makePipelineEnv(),
      10
    );

    expect(result.queued).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
