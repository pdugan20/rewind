import {
  APPLE_TOUCH_ICON_PNG_B64,
  FAVICON_ICO_B64,
  FAVICON_SVG,
} from './assets';

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const ICO_BYTES = b64ToBytes(FAVICON_ICO_B64);
const APPLE_BYTES = b64ToBytes(APPLE_TOUCH_ICON_PNG_B64);

const ICON_CACHE = 'public, max-age=86400, s-maxage=604800, immutable';
const DOCS_ORIGIN = 'https://docs.rewind.rest';

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/favicon.ico':
        return new Response(ICO_BYTES, {
          headers: {
            'content-type': 'image/x-icon',
            'cache-control': ICON_CACHE,
          },
        });
      case '/favicon.svg':
        return new Response(FAVICON_SVG, {
          headers: {
            'content-type': 'image/svg+xml',
            'cache-control': ICON_CACHE,
          },
        });
      case '/apple-touch-icon.png':
      case '/apple-touch-icon-precomposed.png':
        return new Response(APPLE_BYTES, {
          headers: {
            'content-type': 'image/png',
            'cache-control': ICON_CACHE,
          },
        });
    }

    return Response.redirect(DOCS_ORIGIN + url.pathname + url.search, 302);
  },
};
