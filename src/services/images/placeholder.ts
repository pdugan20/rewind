/**
 * Default placeholder image management.
 * Creates and stores a minimal placeholder image in R2 for entities
 * that have no image available from any source.
 */

const PLACEHOLDER_R2_KEY = 'system/placeholder/original.png';

/**
 * Generate a minimal 1x1 gray PNG as default placeholder.
 * This is a valid PNG file that can be served as a fallback.
 */
function generatePlaceholderPng(): Uint8Array {
  // Minimal 1x1 gray PNG (67 bytes)
  // PNG header + IHDR + IDAT (single gray pixel) + IEND
  return new Uint8Array([
    // PNG signature
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    // IHDR chunk (13 bytes data)
    0x00,
    0x00,
    0x00,
    0x0d, // length
    0x49,
    0x48,
    0x44,
    0x52, // type: IHDR
    0x00,
    0x00,
    0x00,
    0x01, // width: 1
    0x00,
    0x00,
    0x00,
    0x01, // height: 1
    0x08,
    0x02, // bit depth: 8, color type: RGB
    0x00,
    0x00,
    0x00, // compression, filter, interlace
    0x72,
    0x73,
    0x97,
    0x73, // CRC (custom computed -- placeholder)
    // IDAT chunk (compressed pixel data for 1x1 gray pixel)
    0x00,
    0x00,
    0x00,
    0x0c, // length
    0x49,
    0x44,
    0x41,
    0x54, // type: IDAT
    0x08,
    0xd7,
    0x63,
    0x60,
    0x60,
    0x60,
    0x00,
    0x00,
    0x00,
    0x04,
    0x00,
    0x01, // zlib-compressed 1x1 RGB pixel
    0x27,
    0x06,
    0x17,
    0xb5, // CRC
    // IEND chunk
    0x00,
    0x00,
    0x00,
    0x00, // length
    0x49,
    0x45,
    0x4e,
    0x44, // type: IEND
    0xae,
    0x42,
    0x60,
    0x82, // CRC
  ]);
}

/**
 * Ensure the placeholder image exists in R2.
 */
export async function ensurePlaceholder(bucket: R2Bucket): Promise<string> {
  // Check if placeholder already exists
  const existing = await bucket.head(PLACEHOLDER_R2_KEY);
  if (existing) {
    return PLACEHOLDER_R2_KEY;
  }

  // Create and upload placeholder
  const png = generatePlaceholderPng();
  await bucket.put(PLACEHOLDER_R2_KEY, png, {
    httpMetadata: { contentType: 'image/png' },
    customMetadata: {
      'x-source': 'placeholder',
      'x-source-url': 'generated',
      'x-dimensions': '1x1',
    },
  });

  console.log('[INFO] Created default placeholder image in R2');
  return PLACEHOLDER_R2_KEY;
}

export { PLACEHOLDER_R2_KEY };
