import { readPixels } from '../../../scripts/cd-artwork/pixels.mjs';
import { extractColors } from '../images/colors.js';
import { generateThumbHash } from '../images/thumbhash.js';
export function artworkMetadata(bytes: Uint8Array) {
  const p = readPixels(bytes),
    small = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const index = ((y * 32 + 16) * 1024 + x * 32 + 16) * 4;
      small.set(p.data.subarray(index, index + 4), (y * 32 + x) * 4);
    }
  const colors = extractColors(small, 32, 32);
  return {
    thumbhash: generateThumbHash(32, 32, small),
    dominant_color: colors.dominantColor,
    accent_color: colors.accentColor,
  };
}
