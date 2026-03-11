/**
 * Image size presets for Cloudflare Images transforms.
 * Each preset defines dimensions, fit mode, and intended use case.
 */

export interface SizePreset {
  width: number | null;
  height: number | null;
  fit: 'cover' | 'contain' | 'scale-down' | 'crop';
}

export const SIZE_PRESETS: Record<string, SizePreset> = {
  thumbnail: { width: 64, height: 64, fit: 'cover' },
  small: { width: 150, height: 150, fit: 'cover' },
  medium: { width: 300, height: 300, fit: 'cover' },
  large: { width: 600, height: 600, fit: 'cover' },
  poster: { width: 342, height: 513, fit: 'cover' },
  'poster-lg': { width: 500, height: 750, fit: 'cover' },
  backdrop: { width: 780, height: 439, fit: 'cover' },
  original: { width: null, height: null, fit: 'scale-down' },
};

export const VALID_SIZES = Object.keys(SIZE_PRESETS);

export const CDN_BASE_URL = 'https://cdn.rewind.rest';

export const CDN_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age': '86400',
} as const;

export const IMAGE_CACHE_CONTROL =
  'public, max-age=31536000, immutable' as const;

export type ImageDomain = 'listening' | 'watching' | 'collecting';

export type EntityType = 'albums' | 'artists' | 'movies' | 'shows' | 'releases';

export type ImageSource =
  | 'cover-art-archive'
  | 'itunes'
  | 'apple-music'
  | 'fanart-tv'
  | 'tmdb'
  | 'plex'
  | 'manual'
  | 'placeholder';

/**
 * Build a CDN URL with optional size transform parameters and cache busting.
 */
export function buildCdnUrl(
  r2Key: string,
  size: string,
  imageVersion: number
): string {
  const preset = SIZE_PRESETS[size];
  if (!preset) {
    return `${CDN_BASE_URL}/${r2Key}?v=${imageVersion}`;
  }

  const params = new URLSearchParams();
  if (preset.width) params.set('width', String(preset.width));
  if (preset.height) params.set('height', String(preset.height));
  params.set('fit', preset.fit);
  params.set('format', 'auto');
  params.set('quality', '85');
  params.set('v', String(imageVersion));

  return `${CDN_BASE_URL}/${r2Key}?${params.toString()}`;
}

/**
 * Build the R2 object key for an image.
 */
export function buildR2Key(
  domain: string,
  entityType: string,
  entityId: string,
  ext = 'jpg'
): string {
  return `${domain}/${entityType}/${entityId}/original.${ext}`;
}
