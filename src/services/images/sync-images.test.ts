import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processItems } from './sync-images.js';
import type { SyncImageResult } from './sync-images.js';
import type { PipelineEnv } from './pipeline.js';
import type { SourceSearchParams } from './sources/types.js';

// Mock runPipeline
vi.mock('./pipeline.js', () => ({
  runPipeline: vi.fn(),
}));

// Mock placeholder insert
vi.mock('./placeholder.js', () => ({
  insertNoSourcePlaceholder: vi.fn(),
}));

import { runPipeline } from './pipeline.js';
const mockRunPipeline = vi.mocked(runPipeline);

describe('processItems', () => {
  const mockDb = {} as never;
  const mockEnv: PipelineEnv = {
    IMAGES: {} as R2Bucket,
    IMAGE_TRANSFORMS: {} as ImagesBinding,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns zero counts for empty items array', async () => {
    const result = await processItems(
      mockDb,
      mockEnv,
      'listening',
      'albums',
      []
    );

    expect(result).toEqual<SyncImageResult>({
      domain: 'listening',
      entityType: 'albums',
      queued: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    });
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('counts succeeded items when pipeline returns a result', async () => {
    mockRunPipeline.mockResolvedValue({
      r2Key: 'listening/albums/1/original.jpg',
      source: 'coverartarchive',
      sourceUrl: 'https://example.com/img.jpg',
      width: 500,
      height: 500,
      imageVersion: 1,
      thumbhash: 'abc',
      dominantColor: '#000',
      accentColor: '#fff',
    });

    const items: SourceSearchParams[] = [
      { domain: 'listening', entityType: 'albums', entityId: '1', albumName: 'Test' },
      { domain: 'listening', entityType: 'albums', entityId: '2', albumName: 'Test2' },
    ];

    const result = await processItems(
      mockDb,
      mockEnv,
      'listening',
      'albums',
      items
    );

    expect(result.queued).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(mockRunPipeline).toHaveBeenCalledTimes(2);
  });

  it('counts skipped items when pipeline returns null', async () => {
    mockRunPipeline.mockResolvedValue(null);

    const items: SourceSearchParams[] = [
      { domain: 'watching', entityType: 'movies', entityId: '10', tmdbId: '550' },
    ];

    const result = await processItems(
      mockDb,
      mockEnv,
      'watching',
      'movies',
      items
    );

    expect(result.queued).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('counts failed items when pipeline throws', async () => {
    mockRunPipeline.mockRejectedValue(new Error('fetch failed'));

    const items: SourceSearchParams[] = [
      { domain: 'collecting', entityType: 'releases', entityId: '99' },
    ];

    const result = await processItems(
      mockDb,
      mockEnv,
      'collecting',
      'releases',
      items
    );

    expect(result.queued).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('handles mixed results correctly', async () => {
    mockRunPipeline
      .mockResolvedValueOnce({
        r2Key: 'key1',
        source: 'tmdb',
        sourceUrl: 'https://example.com/img.jpg',
        width: 500,
        height: 750,
        imageVersion: 1,
        thumbhash: 'h1',
        dominantColor: '#111',
        accentColor: '#222',
      })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('timeout'));

    const items: SourceSearchParams[] = [
      { domain: 'watching', entityType: 'movies', entityId: '1' },
      { domain: 'watching', entityType: 'movies', entityId: '2' },
      { domain: 'watching', entityType: 'movies', entityId: '3' },
    ];

    const result = await processItems(
      mockDb,
      mockEnv,
      'watching',
      'movies',
      items
    );

    expect(result.queued).toBe(3);
    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('passes correct search params to pipeline', async () => {
    mockRunPipeline.mockResolvedValue(null);

    const items: SourceSearchParams[] = [
      {
        domain: 'listening',
        entityType: 'albums',
        entityId: '42',
        albumName: 'OK Computer',
        artistName: 'Radiohead',
        mbid: 'abc-123',
      },
    ];

    await processItems(mockDb, mockEnv, 'listening', 'albums', items);

    expect(mockRunPipeline).toHaveBeenCalledWith(mockDb, mockEnv, {
      domain: 'listening',
      entityType: 'albums',
      entityId: '42',
      albumName: 'OK Computer',
      artistName: 'Radiohead',
      mbid: 'abc-123',
    });
  });

  it('sets domain and entityType on result', async () => {
    const result = await processItems(
      mockDb,
      mockEnv,
      'collecting',
      'releases',
      []
    );

    expect(result.domain).toBe('collecting');
    expect(result.entityType).toBe('releases');
  });
});
