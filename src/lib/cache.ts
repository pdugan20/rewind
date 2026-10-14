import type { Context } from 'hono';

type CachePreset = 'realtime' | 'short' | 'medium' | 'long' | 'static' | 'none';

// Data routes sit behind per-key auth, so responses are private: a shared
// cache must never reuse one key's response for another caller. Next's own
// server-side fetch cache is unaffected by these headers.
const presets: Record<CachePreset, string> = {
  realtime: 'private, max-age=30',
  short: 'private, max-age=300',
  medium: 'private, max-age=3600',
  long: 'private, max-age=86400',
  static: 'private, max-age=604800, immutable',
  none: 'no-store',
};

export function setCache(c: Context, preset: CachePreset) {
  c.header('Cache-Control', presets[preset]);
  c.header('Vary', 'Authorization');
}
