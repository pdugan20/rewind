/**
 * Cloudflare Pages middleware.
 * Redirects docs.rewind.rest to /docs/ (the Scalar API reference).
 */
export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);

  if (url.hostname === 'docs.rewind.rest' && url.pathname === '/') {
    return Response.redirect(`${url.origin}/docs/`, 302);
  }

  return context.next();
};
