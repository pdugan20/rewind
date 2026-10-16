import { decode as decodePng } from 'fast-png';
import encodeWebp, { init as initWebpEncoder } from '@jsquash/webp/encode.js';
import decodeWebp, { init as initWebpDecoder } from '@jsquash/webp/decode.js';
import encoderWasm from '@jsquash/webp/codec/enc/webp_enc_simd.wasm';
import decoderWasm from '@jsquash/webp/codec/dec/webp_dec.wasm';

const MAX_CANONICAL_BYTES = 8 * 1024 * 1024;
const MAX_VARIANT_BYTES = 8 * 1024 * 1024;
const DIMENSION = 1024;
/**
 * Delivery encodes are lossy at this quality with a lossless alpha plane. At
 * the Discman's display size, quality 95 renders indistinguishably from the
 * PNG (fine disc lettering included) at roughly a tenth of its bytes.
 */
const DELIVERY_QUALITY = 95;
/**
 * Minimum PSNR of visible RGB (weighted by alpha) against the PNG. Real disc
 * art measured about 43.5 dB at quality 95; an encode below this floor falls
 * back to the verified lossless encode.
 */
const MIN_DELIVERY_PSNR = 40;
let codecInit: Promise<void> | undefined;

export type WebpVariant = {
  image_url: string;
  sha256: string;
  format: 'webp';
  width: 1024;
  height: 1024;
  bytes: number;
};

export type StoredWebpVariant = Omit<WebpVariant, 'image_url'> & {
  canonical_hash: string;
  /** 1: lossless. 2: delivery (lossy with exact alpha, or lossless fallback). */
  version: 1 | 2;
};

async function initializeCodecs() {
  if (!codecInit) {
    const initialization = (async () => {
      await initWebpEncoder(encoderWasm);
      await initWebpDecoder(decoderWasm);
    })();
    codecInit = initialization.catch((error: unknown) => {
      codecInit = undefined;
      throw error;
    });
  }
  await codecInit;
}

function toRgba(png: Uint8Array) {
  const image = decodePng(png);
  if (image.depth !== 8) throw new Error('canonical_depth_invalid');
  if (image.width !== DIMENSION || image.height !== DIMENSION)
    throw new Error('canonical_dimensions_invalid');
  if (image.channels === 4) return new Uint8Array(image.data);
  if (image.channels === 3) {
    const rgba = new Uint8Array(DIMENSION * DIMENSION * 4);
    for (let source = 0, target = 0; source < image.data.length; source += 3) {
      rgba[target++] = image.data[source];
      rgba[target++] = image.data[source + 1];
      rgba[target++] = image.data[source + 2];
      rgba[target++] = 255;
    }
    return rgba;
  }
  throw new Error('canonical_channels_invalid');
}

/** Encode and decode-check a bounded canonical PNG with libwebp lossless mode. */
export async function createLosslessWebp(png: Uint8Array) {
  if (png.byteLength === 0 || png.byteLength > MAX_CANONICAL_BYTES)
    throw new Error('canonical_size_invalid');
  const rgba = toRgba(png);
  await initializeCodecs();
  const encoded = new Uint8Array(
    await encodeWebp(
      {
        data: new Uint8ClampedArray(rgba),
        width: DIMENSION,
        height: DIMENSION,
        colorSpace: 'srgb',
      },
      {
        lossless: 1,
        exact: 1,
        near_lossless: 100,
        alpha_quality: 100,
        method: 4,
      }
    )
  );
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_VARIANT_BYTES)
    throw new Error('variant_size_invalid');
  const decoded = await decodeWebp(encoded.buffer as ArrayBuffer);
  if (
    decoded.width !== DIMENSION ||
    decoded.height !== DIMENSION ||
    decoded.data.byteLength !== rgba.byteLength
  )
    throw new Error('variant_dimensions_invalid');
  for (let i = 0; i < rgba.length; i++) {
    if (decoded.data[i] !== rgba[i]) throw new Error('variant_fidelity_failed');
  }
  return encoded;
}

/**
 * The delivery variant: lossy RGB with every alpha byte preserved, verified
 * after decoding. The exact lossless encode is used instead when visible RGB
 * would drop below MIN_DELIVERY_PSNR, or when it is smaller (flat or
 * graphic art), so a delivery variant is never larger than the lossless one.
 */
export async function createDeliveryWebp(png: Uint8Array) {
  if (png.byteLength === 0 || png.byteLength > MAX_CANONICAL_BYTES)
    throw new Error('canonical_size_invalid');
  const rgba = toRgba(png);
  await initializeCodecs();
  const encoded = new Uint8Array(
    await encodeWebp(
      {
        data: new Uint8ClampedArray(rgba),
        width: DIMENSION,
        height: DIMENSION,
        colorSpace: 'srgb',
      },
      {
        quality: DELIVERY_QUALITY,
        alpha_quality: 100,
        alpha_compression: 1,
        exact: 1,
        use_sharp_yuv: 1,
        method: 4,
      }
    )
  );
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_VARIANT_BYTES)
    throw new Error('variant_size_invalid');
  const decoded = await decodeWebp(encoded.buffer as ArrayBuffer);
  if (
    decoded.width !== DIMENSION ||
    decoded.height !== DIMENSION ||
    decoded.data.byteLength !== rgba.byteLength
  )
    throw new Error('variant_dimensions_invalid');
  let squaredError = 0;
  let samples = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (decoded.data[i + 3] !== rgba[i + 3])
      throw new Error('variant_alpha_changed');
    const alpha = rgba[i + 3];
    if (!alpha) continue;
    for (let c = 0; c < 3; c++) {
      // A half-transparent pixel shows half its error.
      const error = ((decoded.data[i + c] - rgba[i + c]) * alpha) / 255;
      squaredError += error * error;
      samples++;
    }
  }
  const psnr = squaredError
    ? 10 * Math.log10((255 * 255 * samples) / squaredError)
    : Infinity;
  if (psnr < MIN_DELIVERY_PSNR) return createLosslessWebp(png);
  const lossless = await createLosslessWebp(png);
  return lossless.byteLength < encoded.byteLength ? lossless : encoded;
}

export function isStoredWebpVariant(
  value: unknown,
  canonicalHash: string
): value is StoredWebpVariant {
  if (!value || typeof value !== 'object') return false;
  const variant = value as Partial<StoredWebpVariant>;
  return (
    (variant.version === 1 || variant.version === 2) &&
    typeof variant.canonical_hash === 'string' &&
    /^[a-f0-9]{64}$/.test(variant.canonical_hash) &&
    variant.canonical_hash === canonicalHash &&
    variant.format === 'webp' &&
    variant.width === DIMENSION &&
    variant.height === DIMENSION &&
    typeof variant.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(variant.sha256) &&
    Number.isInteger(variant.bytes) &&
    (variant.bytes ?? 0) > 0 &&
    (variant.bytes ?? MAX_VARIANT_BYTES + 1) <= MAX_VARIANT_BYTES
  );
}

export { DIMENSION as WEBP_VARIANT_DIMENSION };
