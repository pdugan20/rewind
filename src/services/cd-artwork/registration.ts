import {
  readPixels,
  png,
  checkGeometry,
  repairHub,
  applyTemplateHub,
  type Pixels,
} from '../../../scripts/cd-artwork/pixels.mjs';
import template from './assets/cover-template.png';
import type { JobInput } from './types.js';

function circle(points: Array<[number, number]>) {
  const fit = (p: Array<[number, number]>) => {
    let sx = 0,
      sy = 0,
      sxx = 0,
      syy = 0,
      sxy = 0,
      sxq = 0,
      syq = 0,
      sq = 0;
    for (const [x, y] of p) {
      const q = x * x + y * y;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
      sxq += x * q;
      syq += y * q;
      sq += q;
    }
    const a = [
      [sxx, sxy, sx, sxq],
      [sxy, syy, sy, syq],
      [sx, sy, p.length, sq],
    ];
    for (let c = 0; c < 3; c++) {
      let pivot = c;
      for (let r = c + 1; r < 3; r++)
        if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
      [a[c], a[pivot]] = [a[pivot], a[c]];
      const d = a[c][c];
      if (Math.abs(d) < 1e-8) throw Error('circle_fit_singular');
      for (let k = c; k < 4; k++) a[c][k] /= d;
      for (let r = 0; r < 3; r++)
        if (r !== c) {
          const m = a[r][c];
          for (let k = c; k < 4; k++) a[r][k] -= m * a[c][k];
        }
    }
    const x = a[0][3] / 2,
      y = a[1][3] / 2,
      r = Math.sqrt(a[2][3] + x * x + y * y);
    return { x, y, r };
  };
  let fitted = fit(points);
  for (let i = 0; i < 2; i++) {
    const kept = points.filter(
      ([x, y]) =>
        Math.abs(Math.hypot(x - fitted.x, y - fitted.y) - fitted.r) < 8
    );
    if (kept.length < points.length * 0.8) break;
    fitted = fit(kept);
  }
  const errors = points
    .map(([x, y]) =>
      Math.abs(Math.hypot(x - fitted.x, y - fitted.y) - fitted.r)
    )
    .sort((a, b) => a - b);
  return { ...fitted, p90: errors[Math.floor(errors.length * 0.9)] };
}
const rgb = (p: Pixels, x: number, y: number, c: number) =>
  p.data[
    (Math.max(0, Math.min(p.height - 1, y)) * p.width +
      Math.max(0, Math.min(p.width - 1, x))) *
      4 +
      c
  ];
function bilinear(p: Pixels, x: number, y: number, c: number) {
  const xx = Math.floor(x),
    yy = Math.floor(y),
    fx = x - xx,
    fy = y - yy;
  return (
    (1 - fy) * ((1 - fx) * rgb(p, xx, yy, c) + fx * rgb(p, xx + 1, yy, c)) +
    fy * ((1 - fx) * rgb(p, xx, yy + 1, c) + fx * rgb(p, xx + 1, yy + 1, c))
  );
}
export function register(raw: Uint8Array) {
  if (
    raw.length < 24 ||
    raw[0] !== 137 ||
    raw[1] !== 80 ||
    new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(16) !==
      1024 ||
    new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(20) !==
      1024
  )
    throw Error('output_dimensions_invalid');
  const p = readPixels(raw);
  if (p.width !== 1024 || p.height !== 1024)
    throw Error('output_dimensions_invalid');
  const outerPoints: Array<[number, number]> = [];
  for (let i = 0; i < 720; i++) {
    const angle = (i * Math.PI) / 360;
    for (let r = 574; r > 379; r -= 0.5) {
      const x = 511.5 + Math.cos(angle) * r,
        y = 511.5 + Math.sin(angle) * r;
      const luma =
        (bilinear(p, x, y, 0) + bilinear(p, x, y, 1) + bilinear(p, x, y, 2)) /
        3;
      if (luma < 220) {
        outerPoints.push([x, y]);
        break;
      }
    }
  }
  if (outerPoints.length < 600) throw Error('rim_uncertain');
  const outer = circle(outerPoints);
  if (outer.p90 > 12) throw Error('rim_uncertain');
  // Inspect only the connected white component at the spindle hole; a white
  // scan background elsewhere never defines the plastic material alpha.
  const seen = new Uint8Array(1024 * 1024),
    queue = new Int32Array(1024 * 1024),
    boundary: Array<[number, number]> = [];
  let head = 0,
    tail = 1;
  queue[0] = 512 * 1024 + 512;
  seen[queue[0]] = 1;
  const white = (index: number) =>
    p.data[index * 4] > 245 &&
    p.data[index * 4 + 1] > 245 &&
    p.data[index * 4 + 2] > 245;
  if (!white(queue[0])) throw Error('hole_uncertain');
  while (head < tail) {
    const index = queue[head++],
      x = index % 1024,
      y = Math.floor(index / 1024);
    let edge = false;
    for (const neighbor of [index - 1, index + 1, index - 1024, index + 1024]) {
      if (neighbor < 0 || neighbor >= seen.length)
        throw Error('hole_connected_to_background');
      if (!white(neighbor)) {
        edge = true;
        continue;
      }
      if (!seen[neighbor]) {
        seen[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }
    if (edge) boundary.push([x, y]);
    if (tail > 50000) throw Error('hole_uncertain');
  }
  const inner = circle(boundary);
  if (inner.r < 35 || inner.r > 122 || inner.p90 > 4)
    throw Error('hole_uncertain');
  const data = new Uint8Array(1024 * 1024 * 4);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const dx = x + 0.5 - 512,
        dy = y + 0.5 - 512,
        r = Math.hypot(dx, dy),
        i = (y * 1024 + x) * 4;
      if (r < 59 || r > 481) continue;
      const t = Math.max(0, Math.min(1, (r - 60) / 420)),
        angle = Math.atan2(dy, dx),
        sr = inner.r + (outer.r - inner.r) * t;
      const sx = inner.x + (outer.x - inner.x) * t + Math.cos(angle) * sr,
        sy = inner.y + (outer.y - inner.y) * t + Math.sin(angle) * sr;
      for (let c = 0; c < 3; c++)
        data[i + c] = Math.round(bilinear(p, sx, sy, c));
      let coverage = 0;
      for (let py = 0; py < 4; py++)
        for (let px = 0; px < 4; px++) {
          const sub = Math.hypot(
            x + (px + 0.5) / 4 - 512,
            y + (py + 0.5) / 4 - 512
          );
          if (sub >= 60 && sub <= 480) coverage++;
        }
      data[i + 3] = Math.round((coverage * 255) / 16);
    }
  const image = { width: 1024, height: 1024, data };
  if (!checkGeometry(image).pass) throw Error('registration_geometry_failed');
  return {
    image,
    verification: {
      method: 'circle fit and smooth radial registration; bilinear sampling',
      inner,
      outer,
      sourcePixelsUnchanged: false,
    },
  };
}
export function prepareCandidate(raw: Uint8Array, input: JobInput) {
  const registered = register(raw);
  let result;
  if (input.source_kind === 'cover')
    result = applyTemplateHub(
      registered.image,
      readPixels(new Uint8Array(template))
    );
  else {
    if (!input.material) throw Error('material_review_required');
    const { inner, outer, opacity } = input.material;
    const patch = {
      ...registered.image,
      data: new Uint8Array(registered.image.data),
    };
    for (let i = 3; i < patch.data.length; i += 4)
      patch.data[i] = Math.round(patch.data[i] * opacity);
    result = repairHub(registered.image, patch, { inner, outer });
  }
  return {
    bytes: png(result.image),
    verification: {
      registration: registered.verification,
      material: result.verification,
      geometry: checkGeometry(result.image),
    },
  };
}
export const validateCandidate = (bytes: Uint8Array) => {
  if (
    bytes.length < 24 ||
    bytes[0] !== 137 ||
    bytes[1] !== 80 ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      16
    ) !== 1024 ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      20
    ) !== 1024
  )
    return { pass: false };
  return checkGeometry(readPixels(bytes));
};
