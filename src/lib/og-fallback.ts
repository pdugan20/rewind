/**
 * Third-party OG metadata fallbacks.
 *
 * Used when direct fetch fails or returns empty OG tags (DataDome on
 * NYT/Reuters, PerimeterX on Bloomberg, etc). Ported from claudenotes
 * `lib/content/og-metadata.ts`.
 *
 * Tier 3: ScraperAPI (headless-Chrome proxy)
 * Tier 4: OpenGraph.io (handles some sites ScraperAPI can't)
 *
 * Both require secrets:
 *   - SCRAPER_API_KEY
 *   - OPENGRAPH_IO_KEY
 *
 * Module-level queue serializes third-party calls to avoid free-tier
 * concurrency limits. Direct fetches remain fully parallel.
 */

export interface OgFallbackResult {
  image?: string;
  description?: string;
}

/**
 * Allow up to MAX_CONCURRENT third-party scraper calls at once. Matches
 * the ScraperAPI Hobby-tier concurrency (5). If a caller tries to run
 * more in parallel, the extra ones wait their turn.
 *
 * Replaces the single-file promise chain from claudenotes — that pattern
 * was safe for free-tier concurrency=1 but becomes a 5x throughput
 * tax on the Hobby plan and up.
 */
const MAX_CONCURRENT = 5;
let inFlight = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}

function releaseSlot(): void {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

async function enqueueFallback<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

/** Strip query/fragment for cleaner scraper URLs. Keeps path so that
 *  slug-based routing still hits the right page. */
function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return raw;
  }
}

function extractMeta(html: string, property: string): string | undefined {
  const escaped = property.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const m1 = html.match(
    new RegExp(
      `<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
      'i'
    )
  );
  if (m1) return decodeEntities(m1[1]);
  const m2 = html.match(
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`,
      'i'
    )
  );
  if (m2) return decodeEntities(m2[1]);
  return undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function extractOg(html: string): OgFallbackResult {
  const out: OgFallbackResult = {};
  out.image =
    extractMeta(html, 'og:image') ??
    extractMeta(html, 'og:image:secure_url') ??
    extractMeta(html, 'twitter:image');
  out.description =
    extractMeta(html, 'og:description') ??
    extractMeta(html, 'twitter:description');
  return {
    ...(out.image && { image: out.image }),
    ...(out.description && { description: out.description }),
  };
}

function hasMetadata(m: OgFallbackResult): boolean {
  return !!(m.image || m.description);
}

/**
 * Tier 3: ScraperAPI. Headless Chrome render via proxy. Rescues
 * DataDome (NYT, Reuters) and PerimeterX (Bloomberg). Client timeout
 * 70s per ScraperAPI docs (they retry internally across proxies).
 */
export async function fetchViaScraperApi(
  url: string,
  apiKey: string | undefined
): Promise<OgFallbackResult | null> {
  if (!apiKey) return null;
  return enqueueFallback(async () => {
    try {
      const cleaned = cleanUrl(url);
      const encoded = encodeURIComponent(cleaned);
      const apiUrl =
        `https://api.scraperapi.com?api_key=${apiKey}&url=${encoded}` +
        `&render=true`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 70_000);
      const res = await fetch(apiUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        console.log(`[OG] ScraperAPI ${res.status} for ${url}`);
        return null;
      }
      const html = await res.text();
      const md = extractOg(html);
      return hasMetadata(md) ? md : null;
    } catch (err) {
      console.log(
        `[OG] ScraperAPI err for ${url}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  });
}

/**
 * Tier 4: OpenGraph.io. Different backend than ScraperAPI — sometimes
 * succeeds where ScraperAPI's free tier fails (e.g. WSJ).
 */
export async function fetchViaOpenGraphIo(
  url: string,
  apiKey: string | undefined
): Promise<OgFallbackResult | null> {
  if (!apiKey) return null;
  return enqueueFallback(async () => {
    try {
      const cleaned = cleanUrl(url);
      const encoded = encodeURIComponent(cleaned);
      const apiUrl = `https://opengraph.io/api/1.1/site/${encoded}?app_id=${apiKey}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(apiUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        console.log(`[OG] OpenGraph.io ${res.status} for ${url}`);
        return null;
      }
      const json = (await res.json()) as {
        hybridGraph?: { image?: string; description?: string };
      };
      const g = json?.hybridGraph;
      if (!g) return null;
      const md: OgFallbackResult = {};
      if (g.image) md.image = g.image;
      if (g.description) md.description = g.description;
      return hasMetadata(md) ? md : null;
    } catch (err) {
      console.log(
        `[OG] OpenGraph.io err for ${url}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  });
}

/**
 * Try tier 3, then tier 4. Returns the first one that yields image or
 * description. Returns null if neither works or neither key is set.
 */
export async function fetchOgFallback(
  url: string,
  env: { SCRAPER_API_KEY?: string; OPENGRAPH_IO_KEY?: string }
): Promise<OgFallbackResult | null> {
  const scraper = await fetchViaScraperApi(url, env.SCRAPER_API_KEY);
  if (scraper) return scraper;
  const ogio = await fetchViaOpenGraphIo(url, env.OPENGRAPH_IO_KEY);
  if (ogio) return ogio;
  return null;
}
