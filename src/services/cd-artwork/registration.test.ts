import { describe, expect, it } from 'vitest';
import { png, readPixels } from '../../../scripts/cd-artwork/pixels.mjs';
import {
  register,
  inspectRegistration,
  RegistrationError,
} from './registration.js';

// Manufactured geometry, never an album-specific crop or measured override.
function scan({
  cx = 512,
  cy = 512,
  radius = 480,
  holeX = cx,
  holeY = cy,
  holeRadius = radius / 8,
  stretch = 1,
  holeStretch = 1,
  ringX = cx,
  ringStretch = 1,
  ringRadius = holeRadius + 25,
}: Partial<
  Record<
    | 'cx'
    | 'cy'
    | 'radius'
    | 'holeX'
    | 'holeY'
    | 'holeRadius'
    | 'stretch'
    | 'holeStretch'
    | 'ringX'
    | 'ringStretch'
    | 'ringRadius',
    number
  >
> = {}) {
  const data = new Uint8Array(1024 * 1024 * 4).fill(255);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const outer = Math.hypot((x + 0.5 - cx) / stretch, y + 0.5 - cy);
      const inner = Math.hypot(
        (x + 0.5 - holeX) / holeStretch,
        y + 0.5 - holeY
      );
      if (outer <= radius && inner >= holeRadius) {
        const ring =
          Math.hypot((x + 0.5 - ringX) / ringStretch, y + 0.5 - cy) <
          ringRadius;
        data.set(
          ring ? [170, 180, 190, 255] : [40, 70, 100, 255],
          (y * 1024 + x) * 4
        );
      }
    }
  return png({ width: 1024, height: 1024, data });
}
describe('whole-disc registration', () => {
  it('moves and scales a concentric disc as one rigid face', () => {
    const result = register(scan({ cx: 502, cy: 506, radius: 450 }));
    expect(result.verification.method).toContain('uniform');
    expect(result.image.width).toBe(1024);
    const p = readPixels(png(result.image));
    expect(p.data[(512 * 1024 + 512) * 4 + 3]).toBe(0);
  });
  it('rejects an off-center physical hole instead of warping it to the mask', () => {
    expect(() => register(scan({ holeX: 532, holeY: 520 }))).toThrow(
      'disc_not_concentric'
    );
  });
  it('rejects a large hub mistaken for the spindle hole', () => {
    expect(() => register(scan({ holeRadius: 100 }))).toThrow(
      'hole_ratio_invalid'
    );
  });
  it('rejects perspective distortion instead of hiding it with a circular mask', () => {
    expect(() => register(scan({ radius: 450, stretch: 1.05 }))).toThrow(
      'rim_uncertain'
    );
  });
});

it('rejects an elliptical spindle opening', () => {
  expect(() => register(scan({ holeStretch: 1.15 }))).toThrow('hole_uncertain');
});
it('rejects an eccentric printed hub even with a perfectly centered hole and rim', () => {
  expect(() => register(scan({ ringX: 524 }))).toThrow(
    'printed_hub_not_concentric'
  );
});
it('rejects an elliptical printed hub independently of the spindle opening', () => {
  expect(() => register(scan({ ringStretch: 1.12 }))).toThrow(
    'printed_hub_not_concentric'
  );
});
it('tolerates pixel-scale scan noise without independently warping rings', () => {
  expect(
    register(scan({ ringStretch: 1.01 })).verification.printedHub.detected
  ).toBe(true);
});

it('rejects a strong elliptical hub instead of dismissing a poor circle fit', () => {
  expect(() => register(scan({ ringRadius: 140, ringStretch: 1.25 }))).toThrow(
    'printed_hub_not_concentric'
  );
});

it('reports all measurable failures instead of stopping at the first limit', () => {
  const bytes = scan({
    radius: 450,
    stretch: 1.05,
    holeX: 525,
    holeRadius: 75,
    ringX: 535,
  });
  const report = inspectRegistration(bytes);
  expect(report.pass).toBe(false);
  expect(report.failures).toEqual(
    expect.arrayContaining([
      'rim_uncertain',
      'disc_not_concentric',
      'hole_ratio_invalid',
      'printed_hub_not_concentric',
    ])
  );
  expect(report.centerError).toBeGreaterThan(report.limits.centerOffset);
  expect(() => register(bytes)).toThrow(RegistrationError);
});
it('inspection does not relax publication thresholds for borderline holes', () => {
  const bytes = scan({ holeRadius: 63.5 });
  expect(inspectRegistration(bytes).failures).toContain('hole_ratio_invalid');
  expect(() => register(bytes)).toThrow('hole_ratio_invalid');
});

// A coherent lower-contrast hub is surrounded by stronger irregular printing.
// A strongest-edge-per-ray detector follows the printing and loses the hub.
function busyScan(offset: number, includeRing = true, competingRing = false) {
  const p = readPixels(scan({ ringX: 512 + offset, ringRadius: 84 }));
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const dx = x + 0.5 - 512,
        dy = y + 0.5 - 512;
      const radius = Math.hypot(dx, dy);
      if (radius < 60 || radius > 480) continue;
      const hub = includeRing && Math.hypot(dx - offset, dy) <= 84;
      const printing =
        Math.abs(radius - (145 + 35 * Math.sin(7 * Math.atan2(dy, dx)))) < 3;
      const value = printing
        ? 0
        : hub
          ? 160
          : competingRing && radius > 104 && radius < 120
            ? 210
            : 100;
      p.data.set([value, value, value, 255], (y * 1024 + x) * 4);
    }
  return png(p);
}

it('finds an eccentric hub obscured by stronger irregular printing', () => {
  const report = inspectRegistration(busyScan(7));
  expect(report.printedHub).toMatchObject({
    detected: true,
    method: 'radial-profile',
    pass: false,
  });
  expect(report.failures).toContain('printed_hub_not_concentric');
});

it('preserves a centered hub under the same stronger printing', () => {
  const report = inspectRegistration(busyScan(0));
  expect(report.printedHub).toMatchObject({
    detected: true,
    method: 'radial-profile',
    pass: true,
  });
  expect(report.pass).toBe(true);
});

it('does not certify irregular printing as a physical ring when no ring exists', () => {
  const report = inspectRegistration(busyScan(0, false));
  expect(report.printedHub.detected).toBe(false);
  expect(report.printedHubEvidence).toBe('requires_visual_verification');
});

it('keeps competing coherent rings with different centers uncertain', () => {
  const report = inspectRegistration(busyScan(7, true, true));
  expect(report.printedHub).toMatchObject({
    detected: false,
    reason: 'conflicting_ring_centers',
  });
});

it('does not let many stronger print contours hide a weaker eccentric hub', () => {
  const data = new Uint8Array(1024 * 1024 * 4).fill(255);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const dx = x + 0.5 - 512,
        dy = y + 0.5 - 512;
      const r = Math.hypot(dx, dy),
        angle = Math.atan2(dy, dx);
      if (r < 60 || r > 480) continue;
      let value = Math.hypot(dx - 5, dy) <= 100 ? 140 : 100;
      for (let band = 0; band < 10; band++)
        if (
          (angle / (2 * Math.PI) + 1) % 1 < 0.9 &&
          Math.abs(r - (70 + band * 10)) < 1
        )
          value = 140;
      if (Math.abs(r - (150 + 32 * Math.sin(7 * angle))) < 2) value = 0;
      data.set([value, value, value, 255], (y * 1024 + x) * 4);
    }
  const report = inspectRegistration(png({ width: 1024, height: 1024, data }));
  expect(report.printedHub).toMatchObject({
    detected: false,
    reason: 'conflicting_ring_centers',
  });
});

it('preserves existing translucent source pixels through legacy registration', () => {
  const original = readPixels(scan());
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const radius = Math.hypot(x + 0.5 - 512, y + 0.5 - 512);
      if (radius > 70 && radius < 80)
        original.data[(y * 1024 + x) * 4 + 3] = 128;
    }
  const registered = register(png(original)).image;
  const offset = (512 * 1024 + 588) * 4;
  expect(registered.data[offset + 3]).toBe(128);
  expect(
    Math.abs(registered.data[offset] - original.data[offset])
  ).toBeLessThanOrEqual(2);
});

it('cannot certify hidden disc RGB in a fully transparent PNG', () => {
  const hidden = readPixels(scan());
  for (let i = 3; i < hidden.data.length; i += 4) hidden.data[i] = 0;
  expect(() => register(png(hidden))).toThrow('rim_uncertain');
});

it('rejects an oversized encoded PNG header before decoding its raster', () => {
  const bytes = png(readPixels(scan()));
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    16,
    100000
  );
  expect(() => readPixels(bytes)).toThrow('image_dimensions_invalid');
});
