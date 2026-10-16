import { describe, expect, it } from 'vitest';
import { encode as encodePng } from 'fast-png';
import { createDeliveryWebp, createLosslessWebp } from './webp-variant.js';
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
    // Compare raw bytes. A deep toEqual walks all 4,194,304 elements through
    // Vitest's generic equality and took ~3.7 of this test's ~4.3 seconds,
    // which pushed it past the 20 second timeout on busy CI runners.
    const actual = new Uint8Array(
      decoded.data.buffer,
      decoded.data.byteOffset,
      decoded.data.byteLength
    );
    expect(actual.byteLength).toBe(pixels.byteLength);
    // -1 when every RGBA byte matches; otherwise the first differing byte.
    expect(actual.findIndex((value, index) => value !== pixels[index])).toBe(
      -1
    );
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

describe('delivery WebP preparation', () => {
  async function decoded(webp: Uint8Array) {
    await initWebpDecoder(decoderWasm);
    const image = await decodeWebp(webp.buffer as ArrayBuffer);
    return new Uint8Array(
      image.data.buffer,
      image.data.byteOffset,
      image.data.byteLength
    );
  }

  it('encodes smooth artwork lossily with every alpha byte intact', async () => {
    // A disc: soft gradients, an opaque body, a transparent hole and outside,
    // and an antialiased edge.
    const pixels = new Uint8Array(1024 * 1024 * 4);
    for (let y = 0; y < 1024; y++)
      for (let x = 0; x < 1024; x++) {
        const i = (y * 1024 + x) * 4;
        const r = Math.hypot(x - 511.5, y - 511.5);
        // Photographic grain: a few levels of deterministic noise.
        const grain = ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 9) - 4;
        pixels[i] = 120 + Math.round(80 * Math.sin(x / 90)) + grain;
        pixels[i + 1] = 90 + Math.round(60 * Math.cos(y / 70)) + grain;
        pixels[i + 2] = Math.round((x + y) / 8) + grain + 4;
        pixels[i + 3] = Math.round(
          255 *
            Math.min(1, Math.max(0, 500 - r)) *
            Math.min(1, Math.max(0, r - 60))
        );
      }
    const png = encodePng({ width: 1024, height: 1024, data: pixels });
    const [delivery, lossless] = await Promise.all([
      createDeliveryWebp(png),
      createLosslessWebp(png),
    ]);
    // Grain makes the lossy encode the smaller one, so it is the one chosen.
    expect(delivery.byteLength).toBeLessThan(lossless.byteLength);
    const actual = await decoded(delivery);
    let squared = 0;
    let samples = 0;
    let alphaChanged = -1;
    for (let i = 0; i < pixels.length; i += 4) {
      if (alphaChanged < 0 && actual[i + 3] !== pixels[i + 3]) alphaChanged = i;
      const alpha = pixels[i + 3];
      if (!alpha) continue;
      for (let c = 0; c < 3; c++) {
        const error = ((actual[i + c] - pixels[i + c]) * alpha) / 255;
        squared += error * error;
        samples++;
      }
    }
    expect(alphaChanged).toBe(-1);
    expect(10 * Math.log10((255 * 255 * samples) / squared)).toBeGreaterThan(
      40
    );
  });

  it('encodes a printed halftone lossily, judging its error at display scale', async () => {
    // A four-pixel dot screen with scanner grain over a smooth tone, like a
    // printed disc photo. At quality 95 this scores about 35 dB per pixel,
    // below the floor, but about 44 dB over the 2x2 blocks the texture is
    // drawn at, so the lossy encode (about half the lossless bytes) is kept.
    const pixels = new Uint8Array(1024 * 1024 * 4);
    for (let y = 0; y < 1024; y++)
      for (let x = 0; x < 1024; x++) {
        const i = (y * 1024 + x) * 4;
        const tone =
          60 + Math.round(40 * Math.sin(x / 120) * Math.cos(y / 150));
        const grain = ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 7) - 3;
        const dot = Math.round(
          20 * Math.sin((Math.PI * x) / 2) * Math.sin((Math.PI * y) / 2)
        );
        pixels[i] = tone + 40 + dot + grain;
        pixels[i + 1] = tone + dot + grain;
        pixels[i + 2] = tone + 70 + dot + grain;
        pixels[i + 3] = 255;
      }
    const png = encodePng({ width: 1024, height: 1024, data: pixels });
    const [delivery, lossless] = await Promise.all([
      createDeliveryWebp(png),
      createLosslessWebp(png),
    ]);
    expect(delivery.byteLength).toBeLessThan(lossless.byteLength * 0.6);
    const actual = await decoded(delivery);
    expect(
      actual.findIndex((value, index) => value !== pixels[index])
    ).not.toBe(-1);
  });
  it('falls back to the exact lossless encode when lossy RGB would fall below the floor', async () => {
    // Per-pixel noise defeats lossy coding at any useful quality.
    const pixels = new Uint8Array(1024 * 1024 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      const pixel = i / 4;
      pixels[i] = (pixel * 97) % 251;
      pixels[i + 1] = (pixel * 7919) % 253;
      pixels[i + 2] = (pixel * 104729) % 255;
      pixels[i + 3] = 255;
    }
    const png = encodePng({ width: 1024, height: 1024, data: pixels });
    const actual = await decoded(await createDeliveryWebp(png));
    expect(actual.findIndex((value, index) => value !== pixels[index])).toBe(
      -1
    );
  });
});
