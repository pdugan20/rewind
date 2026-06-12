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

// Self-contained landing page for the apex. Crucially, it advertises ONLY the
// transparent favicon and NO apple-touch. The apex used to 302 to the Mintlify
// docs, but Mintlify's page advertises a transparent apple-touch icon, which
// Google's favicon service then flattens onto black (a JPEG at 48/64px that the
// Claude clients render as a black square). Serving our own root page keeps that
// apple-touch out of Google's view so it uses the transparent favicon instead.
const LANDING_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>Rewind</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body>
<h1>Rewind</h1>
<p>Personal data aggregation API. Syncs and serves data from the services that track your life.</p>
<p><a href="${DOCS_ORIGIN}/">Read the docs &rarr;</a></p>
</body></html>`;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/':
        return new Response(LANDING_HTML, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
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
      // Intentionally 404. A transparent apple-touch-icon makes Google's favicon
      // service flatten it onto black at 48/64px. We serve none so Google uses the
      // transparent favicon.ico / favicon.svg at every size.
      case '/apple-touch-icon.png':
      case '/apple-touch-icon-precomposed.png':
        return new Response(null, { status: 404 });
    }

    // Deep links still forward to the docs.
    return Response.redirect(DOCS_ORIGIN + url.pathname + url.search, 302);
  },
};
