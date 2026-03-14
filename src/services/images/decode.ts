/**
 * Image decoding for the pipeline.
 * Decodes JPEG and PNG images to raw RGBA pixel data using pure-JS decoders
 * (jpeg-js and fast-png), compatible with Cloudflare Workers.
 */

import * as jpeg from 'jpeg-js';
import { decode as decodePng } from 'fast-png';

/**
 * Detect image format from magic bytes.
 */
export function detectFormat(data: Uint8Array): 'jpeg' | 'png' | null {
  if (data[0] === 0xff && data[1] === 0xd8) return 'jpeg';
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  )
    return 'png';
  return null;
}

/**
 * Downsample RGBA pixel data to fit within maxSize x maxSize using
 * nearest-neighbor sampling. Returns original data if already small enough.
 */
export function downsample(
  pixels: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  maxSize: number
): { pixels: Uint8Array; width: number; height: number } {
  if (srcWidth <= maxSize && srcHeight <= maxSize) {
    return { pixels, width: srcWidth, height: srcHeight };
  }

  const scale = Math.min(maxSize / srcWidth, maxSize / srcHeight);
  const dstWidth = Math.max(1, Math.round(srcWidth * scale));
  const dstHeight = Math.max(1, Math.round(srcHeight * scale));
  const dst = new Uint8Array(dstWidth * dstHeight * 4);

  for (let y = 0; y < dstHeight; y++) {
    const srcY = Math.min(Math.floor(y / scale), srcHeight - 1);
    for (let x = 0; x < dstWidth; x++) {
      const srcX = Math.min(Math.floor(x / scale), srcWidth - 1);
      const srcIdx = (srcY * srcWidth + srcX) * 4;
      const dstIdx = (y * dstWidth + x) * 4;
      dst[dstIdx] = pixels[srcIdx];
      dst[dstIdx + 1] = pixels[srcIdx + 1];
      dst[dstIdx + 2] = pixels[srcIdx + 2];
      dst[dstIdx + 3] = pixels[srcIdx + 3];
    }
  }

  return { pixels: dst, width: dstWidth, height: dstHeight };
}

/**
 * Decode image bytes to raw RGBA pixel data using proper JPEG/PNG decoders.
 * Downsamples to max 100x100 for ThumbHash and color extraction.
 */
export function decodeImageForAnalysis(bytes: ArrayBuffer): {
  pixels: Uint8Array;
  width: number;
  height: number;
} | null {
  const data = new Uint8Array(bytes);
  const format = detectFormat(data);

  if (!format) {
    console.log('[ERROR] Unsupported image format (not JPEG or PNG)');
    return null;
  }

  try {
    let rawPixels: Uint8Array;
    let width: number;
    let height: number;

    if (format === 'jpeg') {
      const decoded = jpeg.decode(data, {
        useTArray: true,
        formatAsRGBA: true,
        maxMemoryUsageInMB: 128,
      });
      rawPixels = decoded.data;
      width = decoded.width;
      height = decoded.height;
    } else {
      const decoded = decodePng(data);
      width = decoded.width;
      height = decoded.height;

      if (decoded.channels === 4) {
        rawPixels = new Uint8Array(decoded.data);
      } else if (decoded.channels === 3) {
        // Convert RGB to RGBA
        rawPixels = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          rawPixels[i * 4] = decoded.data[i * 3];
          rawPixels[i * 4 + 1] = decoded.data[i * 3 + 1];
          rawPixels[i * 4 + 2] = decoded.data[i * 3 + 2];
          rawPixels[i * 4 + 3] = 255;
        }
      } else if (decoded.channels === 1) {
        // Grayscale to RGBA
        rawPixels = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          const v = decoded.data[i];
          rawPixels[i * 4] = v;
          rawPixels[i * 4 + 1] = v;
          rawPixels[i * 4 + 2] = v;
          rawPixels[i * 4 + 3] = 255;
        }
      } else if (decoded.channels === 2) {
        // Grayscale + alpha to RGBA
        rawPixels = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          const v = decoded.data[i * 2];
          rawPixels[i * 4] = v;
          rawPixels[i * 4 + 1] = v;
          rawPixels[i * 4 + 2] = v;
          rawPixels[i * 4 + 3] = decoded.data[i * 2 + 1];
        }
      } else {
        console.log(
          `[ERROR] Unsupported PNG channel count: ${decoded.channels}`
        );
        return null;
      }
    }

    // Downsample to max 100x100 for ThumbHash (spec limit) and color extraction
    return downsample(rawPixels, width, height, 100);
  } catch (error) {
    console.log(
      `[ERROR] Image decode failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
