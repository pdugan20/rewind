import { describe, expect, it } from 'vitest';
import { encode as encodePng } from 'fast-png';
import { createLosslessWebp } from './webp-variant.js';
import decodeWebp, { init as initWebpDecoder } from '@jsquash/webp/decode.js';
import decoderWasm from '@jsquash/webp/codec/dec/webp_dec.wasm';

describe('lossless WebP preparation', () => {
  it('preserves every RGBA byte, including RGB under zero alpha', async () => {
    const pixels = new Uint8Array(1024 * 1024 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      const pixel = i / 4;
      pixels[i] = pixel % 251;
      pixels[i + 1] = (pixel * 7) % 253;
      pixels[i + 2] = (pixel * 13) % 255;
      pixels[i + 3] = pixel % 11 === 0 ? 0 : pixel % 255;
    }
    const png = encodePng({ width: 1024, height: 1024, data: pixels });
    const webp = await createLosslessWebp(png);
    await initWebpDecoder(decoderWasm);
    const decoded = await decodeWebp(webp.buffer as ArrayBuffer);

    expect(decoded.width).toBe(1024);
    expect(decoded.height).toBe(1024);
    expect(decoded.data).toEqual(new Uint8ClampedArray(pixels));
    expect(webp.byteLength).toBeGreaterThan(0);
  });

  it('rejects images outside the fixed resolution and byte bounds', async () => {
    const tiny = encodePng({
      width: 1,
      height: 1,
      data: new Uint8Array([0, 0, 0, 0]),
    });
    await expect(createLosslessWebp(tiny)).rejects.toThrow(
      'canonical_dimensions_invalid'
    );
    await expect(
      createLosslessWebp(new Uint8Array(8 * 1024 * 1024 + 1))
    ).rejects.toThrow('canonical_size_invalid');
  });

  it('omits variants for 16-bit PNGs instead of truncating channel values', async () => {
    const pixels = new Uint16Array(1024 * 1024 * 4);
    pixels.fill(65_535);
    const png = encodePng({
      width: 1024,
      height: 1024,
      depth: 16,
      data: pixels,
    });
    await expect(createLosslessWebp(png)).rejects.toThrow(
      'canonical_depth_invalid'
    );
  });
});
