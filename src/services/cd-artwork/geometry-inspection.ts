import {
  readPixels,
  type Pixels,
} from '../../../scripts/cd-artwork/pixels.mjs';
import { fitEllipse } from './ellipse.js';

function circle(points: Array<[number, number]>) {
  if (points.length < 32) throw Error('circle_fit_insufficient');
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
export function bilinear(p: Pixels, x: number, y: number, c: number) {
  const xx = Math.floor(x),
    yy = Math.floor(y),
    fx = x - xx,
    fy = y - yy;
  return (
    (1 - fy) * ((1 - fx) * rgb(p, xx, yy, c) + fx * rgb(p, xx + 1, yy, c)) +
    fy * ((1 - fx) * rgb(p, xx, yy + 1, c) + fx * rgb(p, xx + 1, yy + 1, c))
  );
}

/** Inspect a strong continuous printed hub boundary independently of alpha.
 * Search a coherent radial profile when lettering obscures the strongest edge.
 * All coordinates here are canonical pixels, with no album-specific tuning.
 */
function inspectHubRing(
  p: Pixels,
  outer: { x: number; y: number },
  scale: number
) {
  const points: Array<[number, number]> = [];
  const radii = new Array<number | undefined>(180);
  for (let i = 0; i < 180; i++) {
    const angle = (i * Math.PI) / 90,
      dx = Math.cos(angle),
      dy = Math.sin(angle);
    let best = 0,
      at = 0;
    for (let r = 70; r <= 185; r++) {
      let contrast = 0;
      for (let c = 0; c < 3; c++)
        contrast +=
          Math.abs(
            bilinear(
              p,
              outer.x + (dx * (r - 1)) / scale,
              outer.y + (dy * (r - 1)) / scale,
              c
            ) -
              bilinear(
                p,
                outer.x + (dx * (r + 1)) / scale,
                outer.y + (dy * (r + 1)) / scale,
                c
              )
          ) / 3;
      if (contrast > best) {
        best = contrast;
        at = r;
      }
    }
    if (best >= 24) {
      points.push([dx * at, dy * at]);
      radii[i] = at;
    }
  }
  if (points.length < 162) return inspectRadialProfile(p, outer, scale);
  const ring = circle(points);
  // Strong ellipses must not disappear behind a failed circle fit. A smooth
  // near-complete radial contour is still a boundary, even when noncircular.
  const smoothEdges = radii.filter((r, i) => {
    const next = radii[(i + 1) % radii.length];
    return r !== undefined && next !== undefined && Math.abs(r - next) <= 4;
  }).length;
  if (ring.p90 > 8 && smoothEdges < 162)
    return inspectRadialProfile(p, outer, scale);
  return {
    detected: true as const,
    ...ring,
    centerError: Math.hypot(ring.x, ring.y),
    pass: ring.p90 <= 2.5 && Math.hypot(ring.x, ring.y) <= 2.5,
  };
}

/** Supplemental measurement, used only when the strongest-edge contour is
 * incoherent. The middle half of angular contrasts suppresses lettering spikes.
 * A candidate needs a distinct radial peak and 90% angular support. Finding a
 * circular search maximum is not itself evidence of a circular physical edge:
 * independently refit edges in a window wider than the acceptance tolerance.
 * Existing measured failures are never replaced by a more favorable fit.
 */
function inspectRadialProfile(
  p: Pixels,
  outer: { x: number; y: number },
  scale: number
) {
  const angles = Array.from({ length: 180 }, (_, i) => [
    Math.cos((i * Math.PI) / 90),
    Math.sin((i * Math.PI) / 90),
  ]);
  const edge = (x: number, y: number, dx: number, dy: number) => {
    let contrast = 0;
    for (let c = 0; c < 3; c++)
      contrast +=
        Math.abs(
          bilinear(
            p,
            outer.x + (x - dx * 1.5) / scale,
            outer.y + (y - dy * 1.5) / scale,
            c
          ) -
            bilinear(
              p,
              outer.x + (x + dx * 1.5) / scale,
              outer.y + (y + dy * 1.5) / scale,
              c
            )
        ) / 3;
    return contrast;
  };
  const score = (x: number, y: number, r: number) => {
    const contrasts = angles
      .map(([dx, dy]) => edge(x + dx * r, y + dy * r, dx, dy))
      .sort((a, b) => a - b);
    return contrasts.slice(36, 126).reduce((sum, n) => sum + n, 0) / 90;
  };
  const profiles = [];
  for (let r = 72; r <= 184; r += 2)
    profiles.push({ x: 0, y: 0, r, score: score(0, 0, r) });
  profiles.sort((a, b) => b.score - a.score);
  const seeds: typeof profiles = [];
  for (const candidate of profiles) {
    if (seeds.some((seed) => Math.abs(seed.r - candidate.r) < 8)) continue;
    seeds.push(candidate);
    // Cover the whole bounded radius interval (at most 15 separated seeds).
    // A top-N cutoff can hide a weaker eccentric ring behind stronger print.
  }
  const candidates = [];
  for (const seed of seeds) {
    let best = seed;
    for (const step of [3, 1, 0.5]) {
      const around = best;
      for (let dx = -2 * step; dx <= 2 * step; dx += step)
        for (let dy = -2 * step; dy <= 2 * step; dy += step)
          for (let dr = -step; dr <= step; dr += step) {
            const x = around.x + dx,
              y = around.y + dy,
              r = around.r + dr;
            if (r < 70 || r > 185) continue;
            const value = score(x, y, r);
            if (value > best.score) best = { x, y, r, score: value };
          }
    }
    const prominence =
      best.score /
      Math.max(
        1,
        score(best.x, best.y, best.r - 6),
        score(best.x, best.y, best.r + 6)
      );
    if (best.score < 20 || prominence < 2) continue;
    const points: Array<[number, number]> = [];
    for (const [dx, dy] of angles) {
      let strength = 0,
        radius = 0;
      for (let d = -4; d <= 4; d += 0.25) {
        const r = best.r + d;
        const value = edge(best.x + dx * r, best.y + dy * r, dx, dy);
        // Follow the local edge nearest this contour, not a stronger adjacent
        // material ring. The wider window still exposes residual shape error.
        const before = edge(
          best.x + dx * (r - 0.25),
          best.y + dy * (r - 0.25),
          dx,
          dy
        );
        const after = edge(
          best.x + dx * (r + 0.25),
          best.y + dy * (r + 0.25),
          dx,
          dy
        );
        if (
          value >= 12 &&
          value >= before &&
          value > after &&
          (!strength || Math.abs(d) < Math.abs(radius - best.r))
        ) {
          strength = value;
          radius = r;
        }
      }
      if (strength >= 12)
        points.push([best.x + dx * radius, best.y + dy * radius]);
    }
    if (points.length < 162) continue;
    const fitted = circle(points);
    candidates.push({
      ...fitted,
      strength: best.score,
      prominence,
      support: points.length,
    });
  }
  candidates.sort((a, b) => b.strength - a.strength);
  const ring = candidates[0];
  if (!ring) return { detected: false as const };
  // Contrast cannot identify which of two different centers is the physical
  // hub. Preserve that ambiguity instead of selecting the convenient circle.
  if (
    candidates.some(
      (other) =>
        Math.abs(other.r - ring.r) > 4 &&
        Math.hypot(other.x - ring.x, other.y - ring.y) > 2.5
    )
  )
    return {
      detected: false as const,
      reason: 'conflicting_ring_centers' as const,
      candidates,
    };
  const centerError = Math.hypot(ring.x, ring.y);
  return {
    detected: true as const,
    method: 'radial-profile' as const,
    ...ring,
    centerError,
    pass: ring.p90 <= 2.5 && centerError <= 2.5,
  };
}
/** Report every measurable defect before making a publication decision.
 * Measurement is not visual acceptance; limits stay unchanged until calibrated.
 */
export function inspectRegistration(
  raw: Uint8Array,
  holeMode: 'white' | 'scan' | 'alpha' = 'white'
) {
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
  // Measure the visible scan on white, never hidden RGB under transparent pixels.
  for (let i = 0; i < p.data.length; i += 4) {
    const alpha = p.data[i + 3] / 255;
    for (let c = 0; c < 3; c++)
      p.data[i + c] = Math.round(p.data[i + c] * alpha + 255 * (1 - alpha));
    if (holeMode !== 'alpha') p.data[i + 3] = 255;
  }
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
      if (holeMode === 'alpha' ? bilinear(p, x, y, 3) >= 128 : luma < 220) {
        outerPoints.push([x, y]);
        break;
      }
    }
  }
  if (outerPoints.length < 600) throw Error('rim_uncertain');
  const outer = circle(outerPoints);
  const outerEllipse = fitEllipse(outerPoints);
  const scale = 480 / outer.r;
  if (!Number.isFinite(scale) || outer.r < 380 || outer.r > 510)
    throw Error('rim_uncertain');
  const failures: string[] = [];
  if (outer.p90 * scale > 3) failures.push('rim_uncertain');
  // Inspect only the connected white component at the spindle hole; a white
  // scan background elsewhere never defines the plastic material alpha.
  const seen = new Uint8Array(1024 * 1024),
    queue = new Int32Array(1024 * 1024),
    boundary: Array<[number, number]> = [];
  let head = 0,
    tail = 1;
  queue[0] = 512 * 1024 + 512;
  seen[queue[0]] = 1;
  const holeThreshold =
    holeMode === 'scan'
      ? Math.min(
          245,
          p.data[queue[0] * 4],
          p.data[queue[0] * 4 + 1],
          p.data[queue[0] * 4 + 2]
        ) - 12
      : 245;
  if (holeMode !== 'alpha' && holeThreshold < 205)
    throw Error('hole_uncertain');
  const white = (index: number) =>
    holeMode === 'alpha'
      ? p.data[index * 4 + 3] <= 16
      : p.data[index * 4] > holeThreshold &&
        p.data[index * 4 + 1] > holeThreshold &&
        p.data[index * 4 + 2] > holeThreshold;
  if (!white(queue[0])) throw Error('hole_uncertain');
  while (head < tail) {
    const index = queue[head++],
      x = index % 1024,
      y = Math.floor(index / 1024);
    if (x === 0 || x === 1023 || y === 0 || y === 1023)
      throw Error('hole_connected_to_background');
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
  const innerEllipse = fitEllipse(boundary);
  if (inner.r < 35 || inner.r > 122 || inner.p90 * scale > 1.5)
    failures.push('hole_uncertain');
  // A centered alpha mask cannot fix an eccentric physical disc. Move the
  // entire photograph together; never interpolate different hub/rim centers.
  const centerError = Math.hypot(inner.x - outer.x, inner.y - outer.y) * scale;
  const holeRadiusError = Math.abs(inner.r * scale - 60);
  if (centerError > 2.5) failures.push('disc_not_concentric');
  if (holeRadiusError > 2.5) failures.push('hole_ratio_invalid');
  const printedHub = inspectHubRing(p, outer, scale);
  if (printedHub.detected && !printedHub.pass)
    failures.push('printed_hub_not_concentric');
  return {
    pass: failures.length === 0,
    failures,
    inner,
    outer,
    outerEllipse,
    innerEllipse,
    scale,
    centerError,
    holeRadiusError,
    printedHub,
    printedHubEvidence: printedHub.detected
      ? 'measured'
      : 'requires_visual_verification',
    limits: {
      rimP90: 3,
      holeP90: 1.5,
      centerOffset: 2.5,
      holeRadiusError: 2.5,
      printedHub: 2.5,
    },
  };
}
export class RegistrationError extends Error {
  constructor(
    public readonly inspection: ReturnType<typeof inspectRegistration>
  ) {
    super(inspection.failures[0]);
  }
}
