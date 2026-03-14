/**
 * ThumbHash generation for blur placeholders.
 * Uses the official thumbhash package by Evan Wallace.
 */

import { rgbaToThumbHash } from 'thumbhash';

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
  if (w > 100 || h > 100) {
    throw new Error('ThumbHash input must be max 100x100 pixels');
  }

  const bytes = rgbaToThumbHash(w, h, rgba);
  return uint8ArrayToBase64(bytes);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
