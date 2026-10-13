import { describe, it, expect } from 'vitest';
import { treatmentForDecision } from './hub-material.js';
import {
  composeCover,
  finishHub,
  materialInspectionView,
  hasNativeHubAlpha,
  measureHubAnnuli,
} from './rendering.js';
import { png, readPixels } from '../../../scripts/cd-artwork/pixels.mjs';
const pixel = (p: ReturnType<typeof readPixels>, x: number, y: number) => [
  ...p.data.slice((y * p.width + x) * 4, (y * p.width + x) * 4 + 4),
];
function base(rgb = [30, 80, 160]) {
  const data = new Uint8Array(800 * 800 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return composeCover(png({ width: 800, height: 800, data }), {
    innerRadius: 60,
    outerRadius: 470,
  });
}
const clear = {
  kind: 'clear_plastic',
  confidence: 'high',
  region_id: 0,
  unprinted: true,
  non_metallic: true,
};
describe('source-shaped hub materials', () => {
  it('reserves real translucent plastic on cover designs without changing ink or the outer finish', () => {
    const before = base(),
      after = finishHub(before.bytes, { mode: 'cover' });
    expect(pixel(after.image, 588, 512)).toEqual([193, 193, 193, 117]);
    expect(pixel(after.image, 750, 512)).toEqual(pixel(before.image, 750, 512));
    expect(pixel(after.image, 987, 512)).toEqual([193, 193, 193, 255]);
    expect(pixel(after.image, 512, 512)[3]).toBe(0);
    expect(after.geometry.pass).toBe(true);
    const light = readPixels(
      materialInspectionView(after.bytes, [248, 248, 244])
    );
    const dark = readPixels(materialInspectionView(after.bytes, [32, 35, 32]));
    expect(
      pixel(light, 588, 512)[0] - pixel(dark, 588, 512)[0]
    ).toBeGreaterThan(100);
    expect(pixel(light, 750, 512)).toEqual(pixel(dark, 750, 512));
  });
  it('retains opaque white print and silver metal instead of imposing a translucent ring', () => {
    for (const rgb of [
      [255, 255, 255],
      [193, 193, 193],
    ]) {
      const before = base(rgb),
        after = finishHub(
          before.bytes,
          treatmentForDecision(
            {
              ...clear,
              kind: 'opaque',
              region_id: null,
              unprinted: false,
              non_metallic: false,
            },
            []
          )
        );
      expect(after.bytes).toEqual(before.bytes);
      expect(pixel(after.image, 588, 512)[3]).toBe(255);
    }
  });
  it('only reconstructs a confidently identified unprinted non-metallic annulus', () => {
    const before = base([190, 190, 190]),
      after = finishHub(
        before.bytes,
        treatmentForDecision(clear, [{ id: 0, inner: 62, outer: 100 }])
      );
    expect(pixel(after.image, 588, 512)).toEqual([190, 190, 190, 117]);
    expect(pixel(after.image, 750, 512)).toEqual(pixel(before.image, 750, 512));
    expect(hasNativeHubAlpha(after.bytes)).toBe(true);
    for (const d of [
      { ...clear, unprinted: false },
      { ...clear, non_metallic: false },
      { ...clear, region_id: 999 },
    ])
      expect(
        treatmentForDecision(d, [{ id: 0, inner: 62, outer: 100 }])
      ).toEqual({ mode: 'preserve' });
  });
  it('preserves the source rather than guessing alpha when material is uncertain', () => {
    expect(
      treatmentForDecision(
        {
          ...clear,
          kind: 'uncertain',
          confidence: 'uncertain',
          region_id: null,
        },
        []
      )
    ).toEqual({ mode: 'preserve' });
    const before = base([193, 193, 193]);
    expect(
      finishHub(
        before.bytes,
        treatmentForDecision({ ...clear, confidence: 'uncertain' }, [])
      ).bytes
    ).toEqual(before.bytes);
  });
  it('holds a mask that crosses colored printing or dark lettering', () => {
    expect(() =>
      finishHub(
        base().bytes,
        treatmentForDecision(clear, [{ id: 0, inner: 62, outer: 100 }])
      )
    ).toThrow('material_region_not_unprinted');
    expect(() =>
      finishHub(
        base([20, 20, 20]).bytes,
        treatmentForDecision(clear, [{ id: 0, inner: 62, outer: 100 }])
      )
    ).toThrow('material_region_not_unprinted');
  });
  it('preserves existing partial source alpha and asymmetric printing byte-for-byte', () => {
    const before = finishHub(base().bytes, { mode: 'cover' }),
      p = readPixels(before.bytes);
    p.data.set([210, 20, 30, 255], (512 * 1024 + 588) * 4);
    const b = png(p),
      after = finishHub(b, { mode: 'preserve' });
    expect(after.bytes).toEqual(b);
    expect(pixel(after.image, 588, 512)).toEqual([210, 20, 30, 255]);
    expect(pixel(after.image, 512, 588)[3]).toBe(117);
  });
});

it('measures boundaries in code and cannot accept invented model coordinates', () => {
  const image = base().image;
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512);
      if (r >= 62 && r < 105)
        image.data.set([190, 190, 190, 255], (y * 1024 + x) * 4);
    }
  const regions = measureHubAnnuli(png(image));
  expect(regions.length).toBeGreaterThan(0);
  expect(regions[0].inner).toBeGreaterThanOrEqual(62);
  expect(regions[0].outer).toBeGreaterThan(99);
  expect(regions[0].outer).toBeLessThan(106);
  expect(treatmentForDecision(clear, regions)).toMatchObject({
    mode: 'clear',
    inner: regions[0].inner,
    outer: regions[0].outer,
  });
  expect(treatmentForDecision({ ...clear, region_id: 999 }, regions)).toEqual({
    mode: 'preserve',
  });
  expect(() =>
    treatmentForDecision({ ...clear, inner_radius: 62 }, regions)
  ).toThrow();
  expect(measureHubAnnuli(base([255, 255, 255]).bytes)).toEqual([]);
});
it('holds even a single colored ink pixel inside a proposed clear region', () => {
  const image = base([190, 190, 190]).image;
  image.data.set([240, 15, 20, 255], (512 * 1024 + 588) * 4);
  expect(() =>
    finishHub(png(image), { mode: 'clear', inner: 62, outer: 100 })
  ).toThrow('material_region_not_unprinted');
});

it('never proposes a feather region crossing a dark edge pixel between sampled rays', () => {
  const image = base().image;
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512);
      if (r >= 62 && r < 110)
        image.data.set([190, 190, 190, 255], (y * 1024 + x) * 4);
    }
  // Offset angularly from the old sampled rays, near the proposed outer feather.
  image.data.set([20, 20, 20, 255], (519 * 1024 + 621) * 4);
  const bytes = png(image),
    regions = measureHubAnnuli(bytes);
  expect(regions.length).toBeGreaterThan(0);
  expect(regions.every((r) => r.outer < 109)).toBe(true);
  for (const r of regions)
    expect(() =>
      finishHub(bytes, { mode: 'clear', inner: r.inner, outer: r.outer })
    ).not.toThrow();
});
