import {
  readPixels,
  png,
  checkGeometry,
  type Pixels,
} from '../../../scripts/cd-artwork/pixels.mjs';
import { inspectRegistration } from './geometry-inspection.js';
import type { Ellipse } from './ellipse.js';

export const RENDER_STRATEGY = 'shared-edge-and-source-shaped-hub-v3';
export const PRINT_OUTER_RADIUS = 470;
const EDGE_COLOR = 193;
export interface PrintCoverage {
  innerRadius: number;
  outerRadius: number;
}
export const FULL_FACE: PrintCoverage = { innerRadius: 60, outerRadius: 480 };
type Sample = [number, number, number, number];
export const HUB_POLICY = 'source-shaped-clear-plastic-v1';
export const COVER_HUB_RADIUS = 88;
export const CLEAR_PLASTIC_ALPHA = 117;
export type HubTreatment =
  | { mode: 'cover' }
  | { mode: 'preserve' }
  | { mode: 'clear'; inner: number; outer: number };
export interface HubAnnulus {
  id: number;
  inner: number;
  outer: number;
}

/** Measure complete neutral annuli with observed outer boundaries. This
 * proposes geometry only; pale printing and metal still need classification.
 */
export function measureHubAnnuli(bytes: Uint8Array): HubAnnulus[] {
  const p = decodeSource(bytes);
  if (p.width !== 1024 || p.height !== 1024)
    throw Error('material_requires_normalization');
  // Check whole pixel shells, including the feather's extent. Ray sampling
  // can miss dark face pixels between rays at a measured outer boundary.
  const valid = new Map<number, boolean>();
  for (let r = 62; r <= 190; r++) valid.set(r, true);
  for (let y = 321; y < 703; y++)
    for (let x = 321; x < 703; x++) {
      const radius = Math.floor(Math.hypot(x + 0.5 - 512, y + 0.5 - 512));
      if (radius < 62 || radius > 190) continue;
      const i = (y * 1024 + x) * 4;
      const rgb = [...p.data.subarray(i, i + 3)];
      if (
        Math.max(...rgb) - Math.min(...rgb) > 24 ||
        Math.max(...rgb) < 80 ||
        p.data[i + 3] < 32
      )
        valid.set(radius, false);
    }
  const regions: HubAnnulus[] = [];
  let start: number | null = null;
  for (let r = 62; r <= 190; r++) {
    if (valid.get(r)) {
      start ??= r;
      continue;
    }
    if (start !== null) {
      const inner = Math.max(62, start + 1),
        outer = r - 1;
      if (outer - inner >= 4 && outer - inner <= 100 && r < 190)
        regions.push({ id: regions.length, inner, outer });
      start = null;
    }
  }
  return regions.slice(0, 4);
}

/** Only a normalized, source-bound image is eligible for this material stage.
 * Covers reserve their own unprinted hub. Retail masks must be classified as
 * clear, unprinted and non-metallic before this function is called.
 */
export function finishHub(bytes: Uint8Array, treatment: HubTreatment) {
  const image = decodeSource(bytes);
  if (image.width !== 1024 || image.height !== 1024)
    throw Error('material_requires_normalization');
  const before = image.data.slice();
  if (
    treatment.mode === 'clear' &&
    (!Number.isFinite(treatment.inner) ||
      !Number.isFinite(treatment.outer) ||
      treatment.inner < 62 ||
      treatment.outer > 190 ||
      treatment.outer - treatment.inner < 4 ||
      treatment.outer - treatment.inner > 100)
  )
    throw Error('material_region_invalid');
  const inner = treatment.mode === 'clear' ? treatment.inner : 60;
  const outer = treatment.mode === 'clear' ? treatment.outer : COVER_HUB_RADIUS;
  let changed = 0,
    partial = 0,
    region = 0,
    unsafe = 0,
    missing = 0;
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512),
        i = (y * 1024 + x) * 4;
      if (treatment.mode === 'preserve' || r < inner - 0.5 || r > outer + 0.5)
        continue;
      const weight = Math.max(0, Math.min(1, r - inner + 0.5, outer - r + 0.5));
      if (!weight || r < 60) continue;
      if (treatment.mode === 'clear') {
        region++;
        const rgb = [...before.subarray(i, i + 3)];
        // A semantic mask cannot authorize colored printing, dark lettering, or
        // a deleted hub. Reject the whole mask instead of thinning those pixels.
        if (Math.max(...rgb) - Math.min(...rgb) > 24 || Math.max(...rgb) < 80)
          unsafe++;
        if (before[i + 3] < 32) missing++;
      }
      const targetAlpha =
        treatment.mode === 'cover' && r <= 62 ? 128 : CLEAR_PLASTIC_ALPHA;
      const target =
        treatment.mode === 'cover'
          ? [193, 193, 193]
          : [...before.subarray(i, i + 3)];
      const a = before[i + 3] * (1 - weight) + targetAlpha * weight;
      for (let c = 0; c < 3; c++)
        image.data[i + c] = Math.round(
          (before[i + c] * before[i + 3] * (1 - weight) +
            target[c] * targetAlpha * weight) /
            a
        );
      image.data[i + 3] = Math.round(a);
      if (image.data[i + 3] !== before[i + 3]) changed++;
      if (r > inner + 1 && r < outer - 1) {
        if (image.data[i + 3] > 0 && image.data[i + 3] < 240) partial++;
      }
    }
  if (treatment.mode === 'clear' && (!region || unsafe > 0 || missing > 0))
    throw Error('material_region_not_unprinted');
  const geometry = checkGeometry(image);
  if (!geometry.pass) throw Error('material_geometry_invalid');
  // The protected face, hole and outer band must be byte-identical to the base.
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512),
        i = (y * 1024 + x) * 4;
      if (
        treatment.mode !== 'preserve' &&
        r >= inner - 0.5 &&
        r <= outer + 0.5 &&
        r >= 60
      )
        continue;
      for (let c = 0; c < 4; c++)
        if (image.data[i + c] !== before[i + c])
          throw Error('material_protected_pixels_changed');
    }
  if (treatment.mode !== 'preserve' && !partial)
    throw Error('material_translucency_missing');
  return {
    bytes: png(image),
    image,
    geometry,
    verification: {
      policy: HUB_POLICY,
      treatment,
      changedPixels: changed,
      translucentPixels: partial,
      protectedPixelsUnchanged: true,
    },
  };
}

export function hasNativeHubAlpha(bytes: Uint8Array) {
  const image = decodeSource(bytes);
  if (image.width !== 1024 || image.height !== 1024)
    throw Error('material_requires_normalization');
  let partial = 0;
  for (let y = 322; y < 702; y++)
    for (let x = 322; x < 702; x++) {
      const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512);
      if (r < 64 || r > 190) continue;
      const a = image.data[(y * 1024 + x) * 4 + 3];
      if (a > 32 && a < 220) partial++;
    }
  return partial >= 500;
}

/** Crop public artwork for material identification, retaining source pixels.
 * The canonical crop spans 400 pixels and is displayed at 512 square.
 */
export function hubInspectionView(
  bytes: Uint8Array,
  canonical = false,
  annuli: HubAnnulus[] = []
) {
  const source = decodeSource(bytes);
  let centerX = source.width / 2,
    centerY = source.height / 2;
  let side = canonical ? 400 : Math.min(source.width, source.height) * 0.44;
  if (!canonical) {
    try {
      const canvas = scanCanvas(bytes);
      const { inner } = inspectRegistration(canvas.measurement, 'scan');
      centerX += (inner.x - 512) / canvas.scale;
      centerY += (inner.y - 512) / canvas.scale;
      side = 400 / canvas.scale;
    } catch {
      // If source geometry cannot be measured, show the whole source instead
      // of an assumed center crop. The classifier must judge the transfer.
      side = Math.max(source.width, source.height);
    }
  }
  const data = new Uint8Array(512 * 512 * 4);
  for (let y = 0; y < 512; y++)
    for (let x = 0; x < 512; x++) {
      const color = sample(
          source,
          centerX + ((x + 0.5 - 256) * side) / 512 - 0.5,
          centerY + ((y + 0.5 - 256) * side) / 512 - 0.5
        ),
        i = (y * 512 + x) * 4;
      for (let c = 0; c < 3; c++)
        data[i + c] = Math.round((color[c] * color[3]) / 255 + 255 - color[3]);
      data[i + 3] = 255;
      if (canonical) {
        const radius = (Math.hypot(x + 0.5 - 256, y + 0.5 - 256) * 400) / 512;
        if (
          annuli.some(
            (a) =>
              Math.abs(radius - a.inner) < 0.65 ||
              Math.abs(radius - a.outer) < 0.65
          )
        )
          data.set([45, 130, 235, 255], i);
      }
    }
  return png({ width: 512, height: 512, data });
}

/** One physical finish for native scans and generated artwork. Blend at the
 * print boundary in premultiplied color; the disc renderer clips the exterior.
 * Source print and material inside the edge keep their existing color/alpha.
 */
function smallOuterEdge(color: Sample, radius: number): Sample {
  const edge = Math.max(0, Math.min(1, radius - PRINT_OUTER_RADIUS + 0.5));
  if (!edge) return color;
  const sourceAlpha = color[3] * (1 - edge);
  const edgeAlpha = 255 * edge;
  const alpha = sourceAlpha + edgeAlpha;
  return [
    (color[0] * sourceAlpha + EDGE_COLOR * edgeAlpha) / alpha,
    (color[1] * sourceAlpha + EDGE_COLOR * edgeAlpha) / alpha,
    (color[2] * sourceAlpha + EDGE_COLOR * edgeAlpha) / alpha,
    alpha,
  ];
}

/** Two matte views expose the actual stored alpha to the visual inspector.
 * These are inspection inputs only; the publishable PNG is never flattened.
 */
export function materialInspectionView(
  bytes: Uint8Array,
  backdrop: readonly [number, number, number]
) {
  const image = decodeSource(bytes);
  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = image.data[i + 3] / 255;
    for (let c = 0; c < 3; c++)
      image.data[i + c] = Math.round(
        image.data[i + c] * alpha + backdrop[c] * (1 - alpha)
      );
    image.data[i + 3] = 255;
  }
  return png(image);
}

function decodeSource(bytes: Uint8Array) {
  if (bytes.byteLength > 12 * 1024 * 1024) throw Error('source_too_large');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0,
    height = 0;
  if (
    bytes.length >= 24 &&
    bytes[0] === 137 &&
    bytes[1] === 80 &&
    bytes[2] === 78 &&
    bytes[3] === 71
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    // JPEG frame dimensions are available before entropy decoding/allocation.
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 255) throw Error('source_dimensions_invalid');
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) break;
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length)
        throw Error('source_dimensions_invalid');
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        if (length < 8) throw Error('source_dimensions_invalid');
        height = view.getUint16(at + 3);
        width = view.getUint16(at + 5);
        break;
      }
      at += length;
    }
  }
  if (!width || !height) throw Error('source_dimensions_invalid');
  if (width * height > 12_000_000) throw Error('source_dimensions_too_large');
  return readPixels(bytes);
}

/** Interpolate premultiplied color so hidden RGB outside a transparent scan
 * cannot create colored fringes around the finished physical edge.
 */
function sample(p: Pixels, x: number, y: number): Sample {
  const xx = Math.floor(x),
    yy = Math.floor(y),
    fx = x - xx,
    fy = y - yy;
  const color = [0, 0, 0];
  let alpha = 0;
  for (let dy = 0; dy < 2; dy++)
    for (let dx = 0; dx < 2; dx++) {
      const px = Math.max(0, Math.min(p.width - 1, xx + dx));
      const py = Math.max(0, Math.min(p.height - 1, yy + dy));
      const index = (py * p.width + px) * 4;
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      const a = p.data[index + 3] / 255;
      alpha += weight * a;
      for (let c = 0; c < 3; c++) color[c] += p.data[index + c] * weight * a;
    }
  return [
    alpha ? color[0] / alpha : 0,
    alpha ? color[1] / alpha : 0,
    alpha ? color[2] / alpha : 0,
    alpha * 255,
  ];
}

function disc(pick: (dx: number, dy: number, r: number) => Sample) {
  const data = new Uint8Array(1024 * 1024 * 4);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const dx = x + 0.5 - 512,
        dy = y + 0.5 - 512,
        r = Math.hypot(dx, dy);
      if (r < 59 || r > 481) continue;
      let coverage = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const rr = Math.hypot(
            x + (sx + 0.5) / 4 - 512,
            y + (sy + 0.5) / 4 - 512
          );
          if (rr >= 60 && rr <= 480) coverage++;
        }
      if (!coverage) continue;
      const color = pick(dx, dy, r),
        index = (y * 1024 + x) * 4;
      for (let c = 0; c < 3; c++) data[index + c] = Math.round(color[c]);
      data[index + 3] = Math.round((color[3] * coverage) / 16);
    }
  const image = { width: 1024, height: 1024, data };
  const geometry = checkGeometry(image);
  if (!geometry.pass) throw Error('normalized_geometry_invalid');
  return { image, bytes: png(image), geometry };
}

/** Covers have no authoritative disc-print boundaries. Use a full-face design
 * by default, without imposing a silver hub or outer gap. Alternate coverage
 * is a shared renderer parameter, never a named-album coordinate exception.
 */
export function composeCover(
  bytes: Uint8Array,
  coverage: PrintCoverage = FULL_FACE,
  layout: 'fill' | 'fit' = 'fill'
) {
  if (
    !Number.isFinite(coverage.innerRadius) ||
    !Number.isFinite(coverage.outerRadius) ||
    coverage.innerRadius < 60 ||
    coverage.innerRadius > 190 ||
    coverage.outerRadius < 470 ||
    coverage.outerRadius > 480
  )
    throw Error('print_coverage_invalid');
  const source = decodeSource(bytes);
  const scale =
    layout === 'fill'
      ? 960 / Math.min(source.width, source.height)
      : (coverage.outerRadius * 2) / Math.hypot(source.width, source.height);
  const border = [
    [0, 0],
    [source.width - 1, 0],
    [0, source.height - 1],
    [source.width - 1, source.height - 1],
    [source.width / 2, 0],
    [source.width / 2, source.height - 1],
    [0, source.height / 2],
    [source.width - 1, source.height / 2],
  ].map(([x, y]) => sample(source, x, y));
  const background: Sample = [0, 1, 2]
    .map((c) => border.map((p) => p[c]).sort((a, b) => a - b)[4])
    .concat(255) as Sample;
  const result = disc((dx, dy, r) => {
    const sx = dx / scale + source.width / 2 - 0.5;
    const sy = dy / scale + source.height / 2 - 0.5;
    const artwork =
      layout === 'fit' &&
      (sx < 0 || sy < 0 || sx > source.width - 1 || sy > source.height - 1)
        ? background
        : sample(source, sx, sy);
    const print =
      Math.max(0, Math.min(1, r - coverage.innerRadius + 0.5)) *
      Math.max(0, Math.min(1, coverage.outerRadius - r + 0.5));
    // Only exposed material receives this neutral treatment. A full-face cover
    // keeps its artwork all the way to the hole and physical silhouette.
    const materialAlpha = r > 62 && r < coverage.innerRadius ? 166 : 255;
    const alpha = artwork[3] * print + materialAlpha * (1 - print);
    const rgb = artwork
      .slice(0, 3)
      .map((v) =>
        alpha
          ? (v * artwork[3] * print + 193 * materialAlpha * (1 - print)) / alpha
          : 0
      );
    return [rgb[0], rgb[1], rgb[2], alpha];
  });
  return {
    ...result,
    verification: {
      method: 'original cover resampled into constructed disc',
      layout,
      printCoverage: coverage,
      geometry: result.geometry,
      redraw: false,
    },
  };
}

function scanCanvas(bytes: Uint8Array) {
  const source = decodeSource(bytes);
  const scale = 940 / Math.max(source.width, source.height);
  const data = new Uint8Array(1024 * 1024 * 4).fill(255);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const sx = (x + 0.5 - 512) / scale + source.width / 2 - 0.5;
      const sy = (y + 0.5 - 512) / scale + source.height / 2 - 0.5;
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height)
        continue;
      const color = sample(source, sx, sy),
        i = (y * 1024 + x) * 4;
      for (let c = 0; c < 3; c++)
        data[i + c] = Math.round((color[c] * color[3]) / 255 + 255 - color[3]);
    }
  return {
    source,
    scale,
    measurement: png({ width: 1024, height: 1024, data }),
  };
}

function directionalRadius(ellipse: Ellipse, vx: number, vy: number) {
  const u = vx * Math.cos(ellipse.angle) + vy * Math.sin(ellipse.angle);
  const v = -vx * Math.sin(ellipse.angle) + vy * Math.cos(ellipse.angle);
  return 1 / Math.hypot(u / ellipse.a, v / ellipse.b);
}

/** Normalize the scan's two physical boundaries with one continuous sampling
 * map. Correct modest perspective/offset and hole-size variation, preserving
 * print/material coverage from the source instead of replacing its hub.
 * Both automatic source kinds use this path and receive the same outer finish.
 */
export function normalizeRetail(bytes: Uint8Array) {
  const canvas = scanCanvas(bytes);
  const inspection = inspectRegistration(canvas.measurement, 'scan');
  const outer = inspection.outerEllipse,
    inner = inspection.innerEllipse;
  const scale = 480 / Math.sqrt(outer.a * outer.b);
  const holeRadius = Math.sqrt(inner.a * inner.b) * scale;
  const offset = Math.hypot(inner.x - outer.x, inner.y - outer.y) * scale;
  if (
    outer.b / outer.a > 1.2 ||
    inner.b / inner.a > 1.25 ||
    outer.p90 * scale > 5 ||
    inner.p90 * scale > 3 ||
    holeRadius < 38 ||
    holeRadius > 96 ||
    offset > 24
  )
    throw Error('scan_normalization_uncertain');
  const hub = inspection.printedHub;
  const anchor =
    hub.detected &&
    hub.p90 <= 3 &&
    hub.r > holeRadius + 8 &&
    hub.r < 190 &&
    hub.centerError <= 24
      ? {
          radius: 60 + ((hub.r - holeRadius) * 420) / (480 - holeRadius),
          x: hub.x / inspection.scale,
          y: hub.y / inspection.scale,
        }
      : null;
  if (anchor) {
    const gap = Math.min(anchor.radius - 60, 480 - anchor.radius);
    const baseline = (480 - anchor.radius) / 420;
    const correction = Math.hypot(
      anchor.x - (inner.x - outer.x) * baseline,
      anchor.y - (inner.y - outer.y) * baseline
    );
    // Every ray must advance through the source rather than fold backwards.
    // Bound the anchor's center-shift slope by the minimum radial advance of
    // the base ellipse map, including its existing hole-to-rim center shift.
    const radialAdvance =
      (outer.a - inner.b - Math.hypot(inner.x - outer.x, inner.y - outer.y)) /
      420;
    if (correction / gap >= radialAdvance * 0.8)
      throw Error('scan_normalization_uncertain');
  }
  const cos = Math.cos(outer.angle),
    sin = Math.sin(outer.angle);
  const result = disc((dx, dy, r) => {
    const ux = dx / r,
      uy = dy / r;
    // Apply the ellipse's symmetric shape transform without rotating the art
    // into the arbitrarily oriented eigenvector frame of an almost-circle.
    const vx =
      ((cos * cos * outer.a + sin * sin * outer.b) * ux +
        cos * sin * (outer.a - outer.b) * uy) /
      480;
    const vy =
      (cos * sin * (outer.a - outer.b) * ux +
        (sin * sin * outer.a + cos * cos * outer.b) * uy) /
      480;
    const nativeHole = directionalRadius(inner, vx, vy);
    const t = Math.max(0, Math.min(1, (r - 60) / 420));
    const nativeRadius = nativeHole + t * (480 - nativeHole);
    let cx = (inner.x - outer.x) * (1 - t),
      cy = (inner.y - outer.y) * (1 - t);
    if (anchor) {
      const blend =
        r < anchor.radius
          ? (r - 60) / (anchor.radius - 60)
          : (480 - r) / (480 - anchor.radius);
      const baseline = (480 - anchor.radius) / 420;
      cx += Math.max(0, blend) * (anchor.x - (inner.x - outer.x) * baseline);
      cy += Math.max(0, blend) * (anchor.y - (inner.y - outer.y) * baseline);
    }
    const sx =
      (outer.x + cx + vx * nativeRadius - 512) / canvas.scale +
      canvas.source.width / 2 -
      0.5;
    const sy =
      (outer.y + cy + vy * nativeRadius - 512) / canvas.scale +
      canvas.source.height / 2 -
      0.5;
    const color = sample(canvas.source, sx, sy);
    // Preserve clear/silver/printed material; only a narrow physical spindle
    // lip has a minimum coverage, as required by the existing consumer contract.
    if (r <= 62 && color[3] < 128) {
      if (color[3] < 1) color[0] = color[1] = color[2] = 193;
      color[3] = 128;
    }
    return smallOuterEdge(color, r);
  });
  return {
    ...result,
    verification: {
      method: 'continuous scan normalization',
      sourceGeometry: { outer, inner, holeRadius, offset },
      hubAnchor: anchor,
      printCoverage: 'preserved from source inside shared outer edge',
      outerEdge: {
        physicalRadius: 480,
        printRadius: PRINT_OUTER_RADIUS,
        width: 480 - PRINT_OUTER_RADIUS,
        color: '#c1c1c1',
        appliedBy: 'shared renderer',
      },
      geometry: result.geometry,
      redraw: false,
      sourcePixelsUnchanged: false,
    },
  };
}
