import { describe, it, expect } from 'vitest';
import * as jpeg from 'jpeg-js';
import { encode as encodePng } from 'fast-png';
import { detectFormat, downsample, decodeImageForAnalysis } from './decode.js';

/**
 * Create a minimal JPEG image with a solid color fill.
 */
function createTestJpeg(
  width: number,
  height: number,
  color: { r: number; g: number; b: number }
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = color.r;
    pixels[i * 4 + 1] = color.g;
    pixels[i * 4 + 2] = color.b;
    pixels[i * 4 + 3] = 255;
  }
  const rawImageData = { data: pixels, width, height };
  const encoded = jpeg.encode(rawImageData, 90);
  return new Uint8Array(encoded.data);
}

/**
 * Create a minimal PNG image with a solid color fill.
 */
function createTestPng(
  width: number,
  height: number,
  color: { r: number; g: number; b: number }
): Uint8Array {
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 3] = color.r;
    pixels[i * 3 + 1] = color.g;
    pixels[i * 3 + 2] = color.b;
  }
  return encodePng({ data: pixels, width, height, channels: 3 });
}

describe('detectFormat', () => {
  it('detects JPEG from magic bytes', () => {
    const data = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(detectFormat(data)).toBe('jpeg');
  });

  it('detects PNG from magic bytes', () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(detectFormat(data)).toBe('png');
  });

  it('returns null for unknown format', () => {
    const data = new Uint8Array([0x47, 0x49, 0x46, 0x38]); // GIF
    expect(detectFormat(data)).toBeNull();
  });
});

describe('downsample', () => {
  it('returns original data when within max size', () => {
    const pixels = new Uint8Array(50 * 50 * 4);
    const result = downsample(pixels, 50, 50, 100);
    expect(result.width).toBe(50);
    expect(result.height).toBe(50);
    expect(result.pixels).toBe(pixels); // same reference
  });

  it('downsamples large images to fit within max size', () => {
    const pixels = new Uint8Array(200 * 300 * 4);
    const result = downsample(pixels, 200, 300, 100);
    expect(result.width).toBeLessThanOrEqual(100);
    expect(result.height).toBeLessThanOrEqual(100);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  it('maintains aspect ratio', () => {
    const pixels = new Uint8Array(400 * 200 * 4);
    const result = downsample(pixels, 400, 200, 100);
    const ratio = result.width / result.height;
    expect(ratio).toBeCloseTo(2.0, 0);
  });

  it('preserves pixel values during downsampling', () => {
    // 2x2 image with distinct colors per pixel
    const pixels = new Uint8Array([
      255,
      0,
      0,
      255, // red
      0,
      255,
      0,
      255, // green
      0,
      0,
      255,
      255, // blue
      255,
      255,
      0,
      255, // yellow
    ]);
    // Downsample 2x2 to 1x1 should pick top-left (nearest neighbor)
    const result = downsample(pixels, 2, 2, 1);
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(result.pixels[0]).toBe(255); // red channel
    expect(result.pixels[1]).toBe(0);
    expect(result.pixels[2]).toBe(0);
    expect(result.pixels[3]).toBe(255);
  });
});

describe('decodeImageForAnalysis', () => {
  it('decodes a JPEG image to correct pixel data', () => {
    const jpegData = createTestJpeg(10, 10, { r: 255, g: 0, b: 0 });
    const result = decodeImageForAnalysis(jpegData.buffer as ArrayBuffer);

    expect(result).not.toBeNull();
    expect(result!.width).toBe(10);
    expect(result!.height).toBe(10);
    expect(result!.pixels.length).toBe(10 * 10 * 4);

    // JPEG is lossy, so colors won't be exact, but should be close to red
    const avgR =
      Array.from({ length: 100 }, (_, i) => result!.pixels[i * 4]).reduce(
        (a, b) => a + b
      ) / 100;
    const avgG =
      Array.from({ length: 100 }, (_, i) => result!.pixels[i * 4 + 1]).reduce(
        (a, b) => a + b
      ) / 100;
    const avgB =
      Array.from({ length: 100 }, (_, i) => result!.pixels[i * 4 + 2]).reduce(
        (a, b) => a + b
      ) / 100;

    expect(avgR).toBeGreaterThan(200); // mostly red
    expect(avgG).toBeLessThan(50); // little green
    expect(avgB).toBeLessThan(50); // little blue
  });

  it('decodes a PNG image to correct pixel data', () => {
    const pngData = createTestPng(10, 10, { r: 0, g: 0, b: 255 });
    const result = decodeImageForAnalysis(pngData.buffer as ArrayBuffer);

    expect(result).not.toBeNull();
    expect(result!.width).toBe(10);
    expect(result!.height).toBe(10);
    expect(result!.pixels.length).toBe(10 * 10 * 4);

    // PNG is lossless, so colors should be exact
    expect(result!.pixels[0]).toBe(0); // R
    expect(result!.pixels[1]).toBe(0); // G
    expect(result!.pixels[2]).toBe(255); // B
    expect(result!.pixels[3]).toBe(255); // A
  });

  it('downsamples large images to max 100x100', () => {
    const jpegData = createTestJpeg(300, 200, { r: 128, g: 128, b: 128 });
    const result = decodeImageForAnalysis(jpegData.buffer as ArrayBuffer);

    expect(result).not.toBeNull();
    expect(result!.width).toBeLessThanOrEqual(100);
    expect(result!.height).toBeLessThanOrEqual(100);
  });

  it('returns null for unsupported formats', () => {
    const gifHeader = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const result = decodeImageForAnalysis(gifHeader.buffer as ArrayBuffer);
    expect(result).toBeNull();
  });

  it('returns null for corrupted data', () => {
    // JPEG magic bytes followed by garbage
    const corrupt = new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00]);
    const result = decodeImageForAnalysis(corrupt.buffer as ArrayBuffer);
    expect(result).toBeNull();
  });

  it('produces pixels that yield meaningful colors', () => {
    // Create a green image and verify color extraction would work
    const pngData = createTestPng(50, 50, { r: 0, g: 200, b: 0 });
    const result = decodeImageForAnalysis(pngData.buffer as ArrayBuffer);

    expect(result).not.toBeNull();

    // Sample several pixels - they should all be green
    for (let i = 0; i < 10; i++) {
      const idx = i * 4;
      expect(result!.pixels[idx]).toBe(0); // R
      expect(result!.pixels[idx + 1]).toBe(200); // G
      expect(result!.pixels[idx + 2]).toBe(0); // B
    }
  });
});
