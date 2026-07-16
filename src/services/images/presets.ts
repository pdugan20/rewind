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
  'poster-sm': { width: 240, height: 360, fit: 'cover' },
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
  | 'deezer'
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
  const originalUrl = `${CDN_BASE_URL}/${r2Key}?v=${imageVersion}`;

  if (!preset || (preset.width === null && preset.height === null)) {
    return originalUrl;
  }

  const options = [
    preset.width ? `width=${preset.width}` : null,
    preset.height ? `height=${preset.height}` : null,
    `fit=${preset.fit}`,
    'format=auto',
    'quality=85',
  ]
    .filter(Boolean)
    .join(',');

  return `${CDN_BASE_URL}/cdn-cgi/image/${options}/${r2Key}?v=${imageVersion}`;
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
