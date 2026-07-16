const TRANSFORM_PREFIX = '/cdn-cgi/image/';

export function rewriteCdnImageUrl(url: string, transform: string): string {
  try {
    const parsed = new URL(url);
    let sourcePath = parsed.pathname;
    if (sourcePath.startsWith(TRANSFORM_PREFIX)) {
      const optionsEnd = sourcePath.indexOf('/', TRANSFORM_PREFIX.length);
      if (optionsEnd === -1) return url;
      sourcePath = sourcePath.slice(optionsEnd);
    }

    const version = parsed.searchParams.get('v');
    const versionSuffix = version ? `?v=${version}` : '';
    return `${parsed.origin}${TRANSFORM_PREFIX}${transform}${sourcePath}${versionSuffix}`;
  } catch {
    return url;
  }
}
