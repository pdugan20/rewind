import { decode as decodePng } from 'fast-png';
import encodeWebp, { init as initWebpEncoder } from '@jsquash/webp/encode.js';
import decodeWebp, { init as initWebpDecoder } from '@jsquash/webp/decode.js';
import encoderWasm from '@jsquash/webp/codec/enc/webp_enc_simd.wasm';
import decoderWasm from '@jsquash/webp/codec/dec/webp_dec.wasm';

const MAX_CANONICAL_BYTES = 8 * 1024 * 1024;
const MAX_VARIANT_BYTES = 8 * 1024 * 1024;
const DIMENSION = 1024;
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
  version: 1;
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

export function isStoredWebpVariant(
  value: unknown,
  canonicalHash: string
): value is StoredWebpVariant {
  if (!value || typeof value !== 'object') return false;
  const variant = value as Partial<StoredWebpVariant>;
  return (
    variant.version === 1 &&
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
