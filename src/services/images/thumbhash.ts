/**
 * ThumbHash generation for blur placeholders.
 * Pure JavaScript implementation compatible with Cloudflare Workers.
 *
 * Based on the ThumbHash algorithm by Evan Wallace.
 * This is a simplified encoder that produces compact ~30-byte blur placeholders.
 */

/**
 * Encode RGBA pixel data into a ThumbHash.
 * Input must be max 100x100 pixels.
 * Returns a base64-encoded string.
 */
export function generateThumbHash(
  w: number,
  h: number,
  rgba: Uint8Array
): string {
  // Validate inputs
  if (w > 100 || h > 100) {
    throw new Error('ThumbHash input must be max 100x100 pixels');
  }

  const bytes = rgbaToThumbHash(w, h, rgba);
  return uint8ArrayToBase64(bytes);
}

/**
 * Core ThumbHash encoding algorithm.
 * Encodes an RGBA image into a compact binary hash.
 */
function rgbaToThumbHash(w: number, h: number, rgba: Uint8Array): Uint8Array {
  // Determine if there is meaningful alpha
  let hasAlpha = false;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 255) {
      hasAlpha = true;
      break;
    }
  }

  // Determine L and P channel sizes
  const isLandscape = w > h;
  const lx = Math.max(1, Math.round(isLandscape ? 7 : (7 * w) / h));
  const ly = Math.max(1, Math.round(isLandscape ? (7 * h) / w : 7));

  // Convert to LPQA channels
  const l: number[] = new Array(w * h);
  const p: number[] = new Array(w * h);
  const q: number[] = new Array(w * h);
  const a: number[] = new Array(w * h);

  for (let i = 0; i < w * h; i++) {
    const alpha = rgba[i * 4 + 3] / 255;
    const r = (rgba[i * 4] / 255) * alpha;
    const g = (rgba[i * 4 + 1] / 255) * alpha;
    const b = (rgba[i * 4 + 2] / 255) * alpha;
    l[i] = (r + g + b) / 3;
    p[i] = (r + g) / 2 - b;
    q[i] = r - g;
    a[i] = alpha;
  }

  // Encode channels using DCT
  const lDct = encodeDCT(l, w, h, lx, ly);
  const pDct = encodeDCT(p, w, h, 3, 3);
  const qDct = encodeDCT(q, w, h, 3, 3);
  const aDct = hasAlpha ? encodeDCT(a, w, h, 5, 5) : null;

  // Compute DC and scale values
  const lDc = lDct[0];
  const pDc = pDct[0];
  const qDc = qDct[0];

  const lScale = lDct.length > 1 ? Math.max(...lDct.slice(1).map(Math.abs)) : 0;
  const pScale = pDct.length > 1 ? Math.max(...pDct.slice(1).map(Math.abs)) : 0;
  const qScale = qDct.length > 1 ? Math.max(...qDct.slice(1).map(Math.abs)) : 0;

  // Pack into bytes
  const header =
    (Math.round(63 * lDc) |
      (Math.round(31.5 + 31.5 * pDc) << 6) |
      (Math.round(31.5 + 31.5 * qDc) << 12) |
      (Math.round(31 * lScale) << 18) |
      (hasAlpha ? 1 << 23 : 0)) >>>
    0;

  const packed: number[] = [
    header & 255,
    (header >> 8) & 255,
    (header >> 16) & 255,
    lx |
      (ly << 3) |
      ((Math.round(63 * pScale) > 31 ? 31 : Math.round(63 * pScale)) << 6) |
      0,
    (Math.round(63 * qScale) > 31 ? 31 : Math.round(63 * qScale)) |
      (Math.round(isLandscape ? 1 : 0) << 5) |
      0,
  ];

  // Quantize AC coefficients
  const acValues: number[] = [];
  if (lScale > 0) {
    for (let i = 1; i < lDct.length; i++) {
      acValues.push(Math.round(15.5 + (15 * lDct[i]) / lScale));
    }
  }
  if (pScale > 0) {
    for (let i = 1; i < pDct.length; i++) {
      acValues.push(Math.round(15.5 + (15 * pDct[i]) / pScale));
    }
  }
  if (qScale > 0) {
    for (let i = 1; i < qDct.length; i++) {
      acValues.push(Math.round(15.5 + (15 * qDct[i]) / qScale));
    }
  }
  if (aDct && aDct.length > 1) {
    for (let i = 1; i < aDct.length; i++) {
      acValues.push(Math.round(15.5 + 15 * aDct[i]));
    }
  }

  // Pack nibbles into bytes
  for (let i = 0; i < acValues.length; i += 2) {
    const lo = Math.max(0, Math.min(15, acValues[i]));
    const hi =
      i + 1 < acValues.length ? Math.max(0, Math.min(15, acValues[i + 1])) : 0;
    packed.push(lo | (hi << 4));
  }

  return new Uint8Array(packed);
}

/**
 * Compute 2D DCT coefficients for a channel.
 */
function encodeDCT(
  channel: number[],
  w: number,
  h: number,
  nx: number,
  ny: number
): number[] {
  const coeffs: number[] = [];

  for (let cy = 0; cy < ny; cy++) {
    for (let cx = 0; cx < nx; cx++) {
      let sum = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const cosX = Math.cos((Math.PI / w) * (x + 0.5) * cx);
          const cosY = Math.cos((Math.PI / h) * (y + 0.5) * cy);
          sum += channel[y * w + x] * cosX * cosY;
        }
      }
      // Normalize
      const norm = (cx === 0 ? 1 : 2) * (cy === 0 ? 1 : 2);
      coeffs.push((sum * norm) / (w * h));
    }
  }

  return coeffs;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
