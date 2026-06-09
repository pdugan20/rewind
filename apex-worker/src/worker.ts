import { FAVICON_ICO_B64, FAVICON_SVG } from './assets';

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const ICO_BYTES = b64ToBytes(FAVICON_ICO_B64);

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
      // Intentionally NOT served. A *transparent* apple-touch-icon makes Google's
      // favicon service flatten it onto black and return a JPEG at 48/64px, which
      // the Claude mobile client renders as a black square. Matching Mintlify (which
      // serves no apple-touch), we 404 these so Google falls back to the transparent
      // favicon.ico / favicon.svg and keeps the icon transparent at every size.
      case '/apple-touch-icon.png':
      case '/apple-touch-icon-precomposed.png':
        return new Response(null, { status: 404 });
    }

    return Response.redirect(DOCS_ORIGIN + url.pathname + url.search, 302);
  },
};
