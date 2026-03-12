import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getImageAttachment, getImageAttachmentBatch } from './images.js';
import type { ImageAttachment } from './images.js';

// Mock the database module
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();

const mockDb = {
  select: mockSelect,
} as never;

beforeEach(() => {
  vi.restoreAllMocks();
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ limit: mockLimit });
});

describe('getImageAttachment', () => {
  it('returns null when no image record exists', async () => {
    mockLimit.mockResolvedValue([]);

    const result = await getImageAttachment(
      mockDb,
      'listening',
      'albums',
      '123'
    );
    expect(result).toBeNull();
  });

  it('returns ImageAttachment with CDN URL when record exists', async () => {
    mockLimit.mockResolvedValue([
      {
        r2Key: 'listening/albums/123/original.jpg',
        thumbhash: 'abc123',
        dominantColor: '#ff0000',
        accentColor: '#00ff00',
        imageVersion: 2,
      },
    ]);

    const result = await getImageAttachment(
      mockDb,
      'listening',
      'albums',
      '123'
    );

    expect(result).not.toBeNull();
    expect(result!.cdn_url).toContain('cdn.rewind.rest');
    expect(result!.cdn_url).toContain('listening/albums/123/original.jpg');
    expect(result!.cdn_url).toContain('v=2');
    expect(result!.thumbhash).toBe('abc123');
    expect(result!.dominant_color).toBe('#ff0000');
    expect(result!.accent_color).toBe('#00ff00');
  });

  it('uses specified size preset', async () => {
    mockLimit.mockResolvedValue([
      {
        r2Key: 'watching/movies/456/original.jpg',
        thumbhash: null,
        dominantColor: null,
        accentColor: null,
        imageVersion: 1,
      },
    ]);

    const result = await getImageAttachment(
      mockDb,
      'watching',
      'movies',
      '456',
      'poster'
    );

    expect(result).not.toBeNull();
    expect(result!.cdn_url).toContain('width=342');
    expect(result!.cdn_url).toContain('height=513');
  });
});

describe('getImageAttachmentBatch', () => {
  it('returns empty map for empty entity IDs', async () => {
    const result = await getImageAttachmentBatch(
      mockDb,
      'collecting',
      'releases',
      []
    );
    expect(result.size).toBe(0);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('returns map of entity ID to ImageAttachment', async () => {
    mockWhere.mockResolvedValue([
      {
        entityId: '100',
        r2Key: 'collecting/releases/100/original.jpg',
        thumbhash: 'hash1',
        dominantColor: '#aaa',
        accentColor: '#bbb',
        imageVersion: 1,
      },
      {
        entityId: '200',
        r2Key: 'collecting/releases/200/original.jpg',
        thumbhash: 'hash2',
        dominantColor: '#ccc',
        accentColor: '#ddd',
        imageVersion: 3,
      },
    ]);

    const result = await getImageAttachmentBatch(
      mockDb,
      'collecting',
      'releases',
      ['100', '200', '300']
    );

    expect(result.size).toBe(2);
    expect(result.has('100')).toBe(true);
    expect(result.has('200')).toBe(true);
    expect(result.has('300')).toBe(false);

    const img100 = result.get('100') as ImageAttachment;
    expect(img100.cdn_url).toContain('releases/100');
    expect(img100.thumbhash).toBe('hash1');

    const img200 = result.get('200') as ImageAttachment;
    expect(img200.cdn_url).toContain('v=3');
  });
});
