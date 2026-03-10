import type { Context } from 'hono';

type CachePreset = 'realtime' | 'short' | 'medium' | 'long' | 'static' | 'none';

const presets: Record<CachePreset, string> = {
  realtime: 'public, max-age=30, s-maxage=30',
  short: 'public, max-age=300, s-maxage=300',
  medium: 'public, max-age=3600, s-maxage=3600',
  long: 'public, max-age=86400, s-maxage=86400',
  static: 'public, max-age=604800, s-maxage=604800, immutable',
  none: 'no-store',
};

export function setCache(c: Context, preset: CachePreset) {
  c.header('Cache-Control', presets[preset]);
}
