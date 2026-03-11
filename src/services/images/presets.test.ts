import { describe, it, expect } from 'vitest';
import {
  SIZE_PRESETS,
  VALID_SIZES,
  buildCdnUrl,
  buildR2Key,
} from './presets.js';

describe('presets', () => {
  it('defines all expected size presets', () => {
    expect(VALID_SIZES).toContain('thumbnail');
    expect(VALID_SIZES).toContain('small');
    expect(VALID_SIZES).toContain('medium');
    expect(VALID_SIZES).toContain('large');
    expect(VALID_SIZES).toContain('poster');
    expect(VALID_SIZES).toContain('poster-lg');
    expect(VALID_SIZES).toContain('backdrop');
    expect(VALID_SIZES).toContain('original');
  });

  it('thumbnail preset has correct dimensions', () => {
    expect(SIZE_PRESETS.thumbnail).toEqual({
      width: 64,
      height: 64,
      fit: 'cover',
    });
  });

  it('original preset has no fixed dimensions', () => {
    expect(SIZE_PRESETS.original).toEqual({
      width: null,
      height: null,
      fit: 'scale-down',
    });
  });
});

describe('buildCdnUrl', () => {
  it('builds URL with size params and version', () => {
    const url = buildCdnUrl('listening/albums/abc/original.jpg', 'medium', 1);
    expect(url).toContain('cdn.rewind.rest');
    expect(url).toContain('width=300');
    expect(url).toContain('height=300');
    expect(url).toContain('fit=cover');
    expect(url).toContain('format=auto');
    expect(url).toContain('v=1');
  });

  it('builds URL with only version for original size', () => {
    const url = buildCdnUrl('listening/albums/abc/original.jpg', 'original', 2);
    expect(url).toContain('fit=scale-down');
    expect(url).toContain('v=2');
    expect(url).not.toContain('width=');
  });

  it('includes version for cache busting', () => {
    const v1 = buildCdnUrl('test/key', 'medium', 1);
    const v2 = buildCdnUrl('test/key', 'medium', 2);
    expect(v1).toContain('v=1');
    expect(v2).toContain('v=2');
    expect(v1).not.toBe(v2);
  });
});

describe('buildR2Key', () => {
  it('builds correct key with default extension', () => {
    expect(buildR2Key('listening', 'albums', 'abc123')).toBe(
      'listening/albums/abc123/original.jpg'
    );
  });

  it('builds correct key with custom extension', () => {
    expect(buildR2Key('watching', 'movies', 'tmdb-27205', 'png')).toBe(
      'watching/movies/tmdb-27205/original.png'
    );
  });
});
