import { describe, it, expect } from 'vitest';
import { extractColors } from './colors.js';

describe('extractColors', () => {
  it('extracts colors from a solid red image', () => {
    // Create a 4x4 solid red image
    const width = 4;
    const height = 4;
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      pixels[i * 4] = 255; // R
      pixels[i * 4 + 1] = 0; // G
      pixels[i * 4 + 2] = 0; // B
      pixels[i * 4 + 3] = 255; // A
    }

    const result = extractColors(pixels, width, height);
    expect(result.dominantColor).toBe('#ff0000');
    expect(result.accentColor).toBe('#ff0000'); // Single color, accent = dominant
  });

  it('extracts colors from a two-tone image', () => {
    // Create a 4x4 image: half blue, half green
    const width = 4;
    const height = 4;
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      if (i < (width * height) / 2) {
        // Blue
        pixels[i * 4] = 0;
        pixels[i * 4 + 1] = 0;
        pixels[i * 4 + 2] = 255;
      } else {
        // Green
        pixels[i * 4] = 0;
        pixels[i * 4 + 1] = 255;
        pixels[i * 4 + 2] = 0;
      }
      pixels[i * 4 + 3] = 255;
    }

    const result = extractColors(pixels, width, height);
    expect(result.dominantColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(result.accentColor).toMatch(/^#[0-9a-f]{6}$/);
    // The two colors should be different since they are visually distinct
    expect(result.dominantColor).not.toBe(result.accentColor);
  });

  it('handles fully transparent pixels', () => {
    const width = 2;
    const height = 2;
    const pixels = new Uint8Array(width * height * 4); // All zeros including alpha

    const result = extractColors(pixels, width, height);
    expect(result.dominantColor).toBe('#000000');
    expect(result.accentColor).toBe('#666666');
  });

  it('returns valid hex strings', () => {
    const width = 8;
    const height = 8;
    const pixels = new Uint8Array(width * height * 4);
    // Random-ish pixel data
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = (i * 37 + 127) % 256;
    }

    const result = extractColors(pixels, width, height);
    expect(result.dominantColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(result.accentColor).toMatch(/^#[0-9a-f]{6}$/);
  });
});
