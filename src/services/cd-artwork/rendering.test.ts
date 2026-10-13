import { describe, expect, it } from 'vitest';
import {
  png,
  readPixels,
  checkGeometry,
} from '../../../scripts/cd-artwork/pixels.mjs';
import {
  composeCover,
  normalizeRetail,
  materialInspectionView,
  rimInspectionView,
} from './rendering.js';

const at = (p: ReturnType<typeof readPixels>, x: number, y: number) => [
  ...p.data.slice((y * p.width + x) * 4, (y * p.width + x) * 4 + 4),
];
function solidCover() {
  const data = new Uint8Array(800 * 800 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([30, 80, 160, 255], i);
  return png({ width: 800, height: 800, data });
}
function scan(hole: number, hub: number, stretch = 1, holeShade = 255) {
  const data = new Uint8Array(1024 * 1024 * 4).fill(255);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const dx = (x + 0.5 - 504) / stretch,
        dy = y + 0.5 - 508;
      const radius = Math.hypot(dx, dy);
      if (radius < hole) {
        data.set([holeShade, holeShade, holeShade, 255], (y * 1024 + x) * 4);
        continue;
      }
      if (radius > 450) continue;
      data.set(
        radius < hub
          ? [180, 180, 180, 255]
          : dy < 0
            ? [200, 40, 30, 255]
            : [30, 40, 200, 255],
        (y * 1024 + x) * 4
      );
    }
  return png({ width: 1024, height: 1024, data });
}

describe('source artwork normalization and print coverage', () => {
  it('allows full-face artwork next to both the spindle and outer edge', () => {
    const result = composeCover(solidCover());
    expect(checkGeometry(result.image).pass).toBe(true);
    expect(at(result.image, 580, 512)).toEqual([30, 80, 160, 255]);
    expect(at(result.image, 982, 512)).toEqual([30, 80, 160, 255]);
    expect(at(result.image, 512, 512)[3]).toBe(0);
  });
  it('changes print coverage without moving the physical hole or silhouette', () => {
    const result = composeCover(solidCover(), {
      innerRadius: 144,
      outerRadius: 472,
    });
    expect(checkGeometry(result.image).pass).toBe(true);
    expect(at(result.image, 600, 512)).toEqual([193, 193, 193, 166]);
    expect(at(result.image, 750, 512)).toEqual([30, 80, 160, 255]);
    expect(at(result.image, 988, 512)).toEqual([193, 193, 193, 255]);
  });
  it.each([45, 60, 75])(
    'normalizes a %s-pixel source hole instead of rejecting its ratio',
    (hole) => {
      const result = normalizeRetail(scan(hole, 110, 1.08));
      expect(result.geometry.pass).toBe(true);
      expect(at(result.image, 512, 512)[3]).toBe(0);
      // Perspective correction retains the artwork's orientation, not the fit's
      // arbitrary eigenvector orientation for nearly circular boundaries.
      expect(at(result.image, 512, 230).slice(0, 3)).toEqual([200, 40, 30]);
      expect(at(result.image, 512, 790).slice(0, 3)).toEqual([30, 40, 200]);
    }
  );
  it('preserves different source hub coverage rather than forcing one silver ring', () => {
    const narrow = normalizeRetail(scan(60, 80)).image;
    const wide = normalizeRetail(scan(60, 140)).image;
    expect(at(narrow, 612, 532).slice(0, 3)).toEqual([30, 40, 200]);
    expect(at(wide, 612, 532).slice(0, 3)).toEqual([180, 180, 180]);
  });
  it('finishes retail and cover-generated images with the same neutral outer band', () => {
    const retail = normalizeRetail(scan(60, 140));
    const generated = normalizeRetail(composeCover(solidCover()).bytes);
    for (const result of [retail, generated]) {
      expect(result.verification.outerEdge).toMatchObject({
        physicalRadius: 480,
        printRadius: 470,
        width: 10,
        color: '#c1c1c1',
      });
      for (const [x, y] of [
        [987, 512],
        [36, 512],
        [512, 987],
        [512, 36],
      ])
        expect(at(result.image, x, y)).toEqual([193, 193, 193, 255]);
      expect(result.geometry.pass).toBe(true);
      expect(at(result.image, 512, 512)[3]).toBe(0);
      expect(at(result.image, 5, 512)[3]).toBe(0);
    }
    expect(at(retail.image, 512, 230)).toEqual([200, 40, 30, 255]);
    expect(at(generated.image, 750, 512)).toEqual([30, 80, 160, 255]);
    expect(at(retail.image, 600, 512)).toEqual([180, 180, 180, 255]);
  });
  it('measures an off-white photographed hole without an album-specific cutoff', () => {
    const result = normalizeRetail(scan(60, 110, 1.06, 232));
    expect(result.geometry.pass).toBe(true);
    expect(at(result.image, 512, 512)[3]).toBe(0);
    expect(at(result.image, 750, 532).slice(0, 3)).toEqual([30, 40, 200]);
  });
  it('refuses excessive source distortion rather than forcing a misleading result', () => {
    expect(() => normalizeRetail(scan(60, 100, 1.35))).toThrow();
    expect(() =>
      composeCover(solidCover(), { innerRadius: 250, outerRadius: 480 })
    ).toThrow('print_coverage_invalid');
  });
  it('rejects an eccentric nearby hub that would fold the sampling map', () => {
    const data = new Uint8Array(1024 * 1024 * 4).fill(255);
    for (let y = 0; y < 1024; y++)
      for (let x = 0; x < 1024; x++) {
        const dy = y + 0.5 - 512;
        if (Math.hypot(x + 0.5 - 512, dy) > 450) continue;
        if (Math.hypot(x + 0.5 - 490, dy) < 55) continue;
        const shade = Math.hypot(x + 0.5 - 516, dy) < 80 ? 180 : 50;
        data.set([shade, shade, shade, 255], (y * 1024 + x) * 4);
      }
    // All individual offsets/radii fit the normalizer's initial limits, but
    // moving the hole and nearby hub in opposite directions reverses local
    // source sampling. A circular alpha silhouette alone would hide this.
    expect(() =>
      normalizeRetail(png({ width: 1024, height: 1024, data }))
    ).toThrow('scan_normalization_uncertain');
  });
  it('checks PNG and JPEG dimensions before decoding their pixel buffers', () => {
    const oversizedPng = new Uint8Array(solidCover());
    const header = new DataView(oversizedPng.buffer);
    header.setUint32(16, 5000);
    header.setUint32(20, 5000);
    expect(() => normalizeRetail(oversizedPng)).toThrow(
      'source_dimensions_too_large'
    );
    const jpegHeader = Uint8Array.from([
      255, 216, 255, 192, 0, 11, 8, 0x13, 0x88, 0x13, 0x88, 1, 1, 0x11, 0,
    ]);
    expect(() => normalizeRetail(jpegHeader)).toThrow(
      'source_dimensions_too_large'
    );
  });
  it('allows a one-pixel alpha edge crossing while rejecting larger silhouette errors', () => {
    const near = composeCover(solidCover()).image;
    for (let y = 0; y < 1024; y++)
      for (let x = 0; x < 1024; x++) {
        const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512);
        const i = (y * 1024 + x) * 4 + 3;
        if (r >= 479 && near.data[i])
          near.data[i] = Math.min(127, near.data[i]);
      }
    expect(checkGeometry(near)).toMatchObject({
      pass: true,
      outerTransitions: [33, 991],
    });
    const tooFar = composeCover(solidCover()).image;
    for (let y = 0; y < 1024; y++)
      for (let x = 0; x < 1024; x++) {
        const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512);
        const i = (y * 1024 + x) * 4 + 3;
        if (r >= 478 && tooFar.data[i])
          tooFar.data[i] = Math.min(127, tooFar.data[i]);
      }
    expect(checkGeometry(tooFar).pass).toBe(false);
  });
  it('preserves real hub alpha and ink opacity through normalization', () => {
    const source = readPixels(scan(60, 140));
    for (let y = 0; y < 1024; y++)
      for (let x = 0; x < 1024; x++) {
        const r = Math.hypot(x + 0.5 - 504, y + 0.5 - 508);
        if (r > 62 && r < 135) source.data[(y * 1024 + x) * 4 + 3] = 117;
      }
    const result = normalizeRetail(png(source));
    expect(at(result.image, 600, 532)[3]).toBe(117);
    expect(at(result.image, 750, 532)[3]).toBe(255);
    const light = readPixels(
      materialInspectionView(result.bytes, [248, 248, 244])
    );
    const dark = readPixels(materialInspectionView(result.bytes, [32, 35, 32]));
    expect(at(light, 600, 532).slice(0, 3)).not.toEqual(
      at(dark, 600, 532).slice(0, 3)
    );
    expect(at(light, 750, 532)).toEqual(at(dark, 750, 532));
    expect(at(result.image, 600, 532)[3]).toBe(117);
    expect(at(dark, 512, 512)).toEqual([32, 35, 32, 255]);
  });
});

it('magnifies a thin colored rim for inspection without changing the candidate', () => {
  const data = new Uint8Array(1024 * 1024 * 4);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512);
      if (r >= 60 && r <= 480)
        data.set(
          r >= 463 && r < 465 ? [180, 30, 220, 255] : [193, 193, 193, 255],
          (y * 1024 + x) * 4
        );
    }
  const before = png({ width: 1024, height: 1024, data }),
    saved = before.slice();
  const view = readPixels(rimInspectionView(before));
  expect(view.width).toBe(1024);
  expect(view.height).toBe(256);
  let purple = 0;
  for (let i = 0; i < view.data.length; i += 4)
    if (
      view.data[i] === 180 &&
      view.data[i + 1] === 30 &&
      view.data[i + 2] === 220
    )
      purple++;
  expect(purple).toBeGreaterThan(4 * 1024);
  expect(before).toEqual(saved);
});
