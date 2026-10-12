import fs from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { decode, encode } from 'fast-png';
import jpeg from 'jpeg-js';

export const GEOMETRY = {
  canvas: 1024,
  center: 512,
  outerRadius: 480,
  holeRadius: 60,
};
export const VERSION = 'cd-material-v2';
export const smooth = (t) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};
export function readPixels(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216)
    return jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 20 });
  const p = decode(bytes);
  if (p.depth !== 8 || ![3, 4].includes(p.channels))
    throw Error('Use an 8-bit RGB/RGBA PNG or JPEG');
  const data = new Uint8Array(p.width * p.height * 4);
  for (let i = 0; i < p.width * p.height; i++) {
    data.set(p.data.subarray(i * p.channels, i * p.channels + 3), i * 4);
    data[i * 4 + 3] = p.channels === 4 ? p.data[i * 4 + 4 - 1] : 255;
  }
  return { width: p.width, height: p.height, data };
}
export const png = (p) => Buffer.from(encode({ ...p, channels: 4, depth: 8 }));
export const loadPixels = async (path) => readPixels(await fs.readFile(path));
export function sample(p, x, y, c) {
  x = Math.max(0, Math.min(p.width - 1, x));
  y = Math.max(0, Math.min(p.height - 1, y));
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    fx = x - x0,
    fy = y - y0;
  const at = (xx, yy) =>
    p.data[
      (Math.min(yy, p.height - 1) * p.width + Math.min(xx, p.width - 1)) * 4 + c
    ];
  return (
    (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) +
    fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1))
  );
}
export function checkGeometry(p) {
  if (p.width !== 1024 || p.height !== 1024)
    return { pass: false, reason: 'registration-required' };
  let holeLeaks = 0,
    outsideLeaks = 0,
    missingFace = 0,
    holeEdgeMissing = 0;
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512),
        a = p.data[(y * 1024 + x) * 4 + 3];
      if (r < 57 && a) holeLeaks++;
      if (r > 483 && a) outsideLeaks++;
      if (r > 200 && r < 470 && a < 250) missingFace++;
      if (r > 61.3 && r < 61.9 && a < 128) holeEdgeMissing++;
    }
  const transitions = [];
  // Outer diameter only: material alpha may cross 50% within the hub.
  for (const y of [512])
    for (let x = 0; x < 1024; x++) {
      if (x >= 310 && x <= 714) continue;
      const a = p.data[(y * 1024 + x) * 4 + 3] >= 128;
      const b = x ? p.data[(y * 1024 + x - 1) * 4 + 3] >= 128 : false;
      if (a !== b) transitions.push(x);
    }
  return {
    pass:
      !holeLeaks &&
      !outsideLeaks &&
      !missingFace &&
      !holeEdgeMissing &&
      transitions.join(',') === '32,992',
    holeLeaks,
    outsideLeaks,
    missingFace,
    holeEdgeMissing,
    outerTransitions: transitions,
  };
}
export function repairHub(master, patch, region) {
  if (!checkGeometry(master).pass) throw Error('Master requires registration');
  const { inner = 62, outer } = region;
  if (!(inner >= 60 && outer > inner + 6 && outer <= 190))
    throw Error('Invalid reviewed material region');
  const out = { width: 1024, height: 1024, data: new Uint8Array(master.data) };
  let protectedChanges = 0,
    partial = 0;
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const i = (y * 1024 + x) * 4,
        r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512);
      const w = smooth((r - inner) / 3) * smooth((outer - r) / 3);
      if (w) {
        const sx = ((x + 0.5) * patch.width) / 1024 - 0.5,
          sy = ((y + 0.5) * patch.height) / 1024 - 0.5;
        const pa = sample(patch, sx, sy, 3) / 255,
          a = 1 - w + w * pa;
        for (let c = 0; c < 3; c++)
          out.data[i + c] = Math.round(
            ((1 - w) * master.data[i + c] + w * pa * sample(patch, sx, sy, c)) /
              a
          );
        out.data[i + 3] = Math.round(master.data[i + 3] * a);
      }
      if (
        (r <= inner || r >= outer) &&
        out.data.subarray(i, i + 4).some((v, c) => v !== master.data[i + c])
      )
        protectedChanges++;
      if (
        r > inner + 3 &&
        r < outer - 3 &&
        out.data[i + 3] > 0 &&
        out.data[i + 3] < 255
      )
        partial++;
    }
  if (protectedChanges || partial < 100)
    throw Error('Material preservation/translucency check failed');
  return {
    image: out,
    verification: { protectedChanges, partialHubPixels: partial, region },
  };
}

// A reusable editable print template. The photo-derived rim and clear plastic
// remain separate from the print layer; album artwork never defines alpha.
export function makeTemplate(rim, clearHub) {
  if (!checkGeometry(rim).pass || !checkGeometry(clearHub).pass)
    throw Error('Template inputs require registration');
  const out = { width: 1024, height: 1024, data: new Uint8Array(rim.data) };
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const i = (y * 1024 + x) * 4,
        r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512);
      if (r <= 60) {
        out.data.set(clearHub.data.subarray(i, i + 4), i);
        continue;
      }
      if (r < 88) {
        const sr = 60 + ((r - 60) * 36) / 28,
          theta = Math.atan2(y + 0.5 - 512, x + 0.5 - 512);
        for (let c = 0; c < 4; c++)
          out.data[i + c] = Math.round(
            sample(
              clearHub,
              512 + Math.cos(theta) * sr - 0.5,
              512 + Math.sin(theta) * sr - 0.5,
              c
            )
          );
      } else if (r < 470) {
        out.data.set([246, 245, 239, 255], i);
      }
    }
  return out;
}
export function applyTemplateHub(master, template) {
  if (!checkGeometry(master).pass || !checkGeometry(template).pass)
    throw Error('Registered composition and template required');
  // Preserve the selected model-composed face. The template defines only the
  // material inside its print opening; it does not re-lay out the album cover.
  const out = { width: 1024, height: 1024, data: new Uint8Array(master.data) };
  let protectedChanges = 0,
    partialHubPixels = 0;
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512),
        i = (y * 1024 + x) * 4;
      const w = smooth((r - 62) / 2) * smooth((88 - r) / 2);
      if (w) {
        const pa = template.data[i + 3] / 255,
          a = 1 - w + w * pa;
        for (let c = 0; c < 3; c++)
          out.data[i + c] = Math.round(
            ((1 - w) * master.data[i + c] + w * pa * template.data[i + c]) / a
          );
        out.data[i + 3] = Math.round(master.data[i + 3] * a);
      }
      if (
        (r <= 62 || r >= 88) &&
        out.data.subarray(i, i + 4).some((v, c) => v !== master.data[i + c])
      )
        protectedChanges++;
      if (r > 64 && r < 86 && out.data[i + 3] > 0 && out.data[i + 3] < 255)
        partialHubPixels++;
    }
  if (protectedChanges || partialHubPixels < 100)
    throw Error('Template material validation failed');
  return {
    image: out,
    verification: {
      protectedChanges,
      partialHubPixels,
      region: { inner: 62, outer: 88 },
      layout: 'preserved from the selected model composition',
    },
  };
}
