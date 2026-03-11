import { describe, it, expect } from 'vitest';
import { generateThumbHash } from './thumbhash.js';

describe('generateThumbHash', () => {
  it('generates a base64 string for a small image', () => {
    const width = 4;
    const height = 4;
    const pixels = new Uint8Array(width * height * 4);
    // Fill with a solid color
    for (let i = 0; i < width * height; i++) {
      pixels[i * 4] = 100;
      pixels[i * 4 + 1] = 150;
      pixels[i * 4 + 2] = 200;
      pixels[i * 4 + 3] = 255;
    }

    const hash = generateThumbHash(width, height, pixels);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
    // Should be valid base64
    expect(() => atob(hash)).not.toThrow();
  });

  it('generates different hashes for different images', () => {
    const width = 4;
    const height = 4;

    const red = new Uint8Array(width * height * 4);
    const blue = new Uint8Array(width * height * 4);

    for (let i = 0; i < width * height; i++) {
      red[i * 4] = 255;
      red[i * 4 + 3] = 255;

      blue[i * 4 + 2] = 255;
      blue[i * 4 + 3] = 255;
    }

    const hashRed = generateThumbHash(width, height, red);
    const hashBlue = generateThumbHash(width, height, blue);

    expect(hashRed).not.toBe(hashBlue);
  });

  it('throws for images larger than 100x100', () => {
    const pixels = new Uint8Array(101 * 101 * 4);
    expect(() => generateThumbHash(101, 101, pixels)).toThrow(
      'ThumbHash input must be max 100x100 pixels'
    );
  });

  it('handles 1x1 image', () => {
    const pixels = new Uint8Array([128, 128, 128, 255]);
    const hash = generateThumbHash(1, 1, pixels);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  it('handles images with alpha channel', () => {
    const width = 4;
    const height = 4;
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      pixels[i * 4] = 200;
      pixels[i * 4 + 1] = 100;
      pixels[i * 4 + 2] = 50;
      pixels[i * 4 + 3] = 128; // Semi-transparent
    }

    const hash = generateThumbHash(width, height, pixels);
    expect(typeof hash).toBe('string');
  });
});
