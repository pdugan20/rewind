/**
 * Phase 2 of the Instapaper backfill: recover article bodies for rows
 * stuck in `enrichment_status='no_body'`. These come from Phase 1 where
 * Instapaper's `bookmarks/get_text` returned 1550 ("no text available")
 * — typically because the source URL is paywalled, has dynamic content,
 * or returns a non-article landing page.
 *
 * Strategy:
 *   1. Fetch the source URL via ScraperAPI (1 credit, no JS render).
 *   2. Run Mozilla Readability over the HTML to extract clean article
 *      body text. If the extracted body is at least MIN_BODY_CHARS,
 *      treat it as a successful recovery.
 *   3. On a short / empty extraction, retry with `&render=true`
 *      (10 credits — invokes ScraperAPI's headless Chrome).
 *   4. On success, UPDATE reading_items: set content/body_excerpt/
 *      word_count/estimated_read_min, flip enrichment_status to
 *      'completed', clear enrichment_error.
 *   5. On final failure, leave enrichment_status='no_body' but set
 *      enrichment_error='scraperapi_failed: <reason>' so subsequent
 *      runs skip the row.
 *
 * Skipped:
 *   - Domains in WSJ_SKIP_DOMAINS (ScraperAPI cannot bypass WSJ's
 *     paywall — empirical 0/2 in earlier tests).
 *   - Rows with enrichment_error already starting 'scraperapi_'
 *     (already attempted).
 *
 * Credits & safety:
 *   - Tracks `X-RemainingCredits` from ScraperAPI response headers.
 *   - Halts if remaining credits drop below MIN_CREDIT_FLOOR (default
 *     10,000 — preserves headroom for routine OG fallbacks during the
 *     month).
 *
 * Flags:
 *   --limit N        cap rows processed
 *   --dry-run        do everything except UPDATE (no ScraperAPI cost
 *                    is saved by this — fetches still happen so the
 *                    extraction logic gets exercised)
 *   --concurrency N  worker pool size (default 5 — matches Hobby plan
 *                    concurrent-connection cap)
 *   --render-only    skip the static-first attempt; go straight to
 *                    &render=true. Useful for a follow-up pass over
 *                    the rows that failed static extraction.
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

const CF_ACCOUNT_ID = '46bcea726724fbab7d60f236f151f3d3';
const CF_DATABASE_ID = '35a4edf8-0d4f-4cbe-9a6e-6f1525716774';
const D1_API_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_DATABASE_ID}/query`;

// 1500 chars after Readability extraction is the floor for a "real"
// article body; below that, the page is almost always a paywall preview
// (headline + first paragraph) and should trigger a render retry.
const MIN_BODY_CHARS = 1500;
const WORDS_PER_MINUTE = 238;
const SCRAPERAPI_TIMEOUT_MS = 80_000; // ScraperAPI docs note 70s upstream
// ScraperAPI Hobby plan is request-limited, not credit-limited. The
// `sa-credit-cost` response header reports the number of requests this
// call consumed (1 for cheap static fetches, 10 for premium / render).
// We poll /account before the run to get baseline `requestCount` and
// halt if remaining drops below MIN_REQUEST_FLOOR.
const MIN_REQUEST_FLOOR = 10_000;

// Domains where ScraperAPI cannot bypass the paywall — confirmed
// empirically. WSJ and WaPo both serve a `meteredContent` stub that
// Readability extracts as ~500-800 chars regardless of `render=true`
// or `premium=true`. Skipping saves ~17K credits across ~2.4K articles.
const SKIP_DOMAINS = [
  'wsj.com',
  'online.wsj.com',
  'm.wsj.com',
  'washingtonpost.com',
];

// Domains that gate body content behind JS — static HTML is a paywall
// stub but `&render=true` (which executes the page's JS) returns the
// full article. Cost is 10 credits either way (these sites trigger
// ScraperAPI's premium-proxy auto-elevation), so going render-direct
// saves a wasted static call.
const RENDER_DIRECT_DOMAINS = [
  'nytimes.com',
  'bloomberg.com',
  'bloombergquint.com',
  'ft.com',
  'economist.com',
  'newyorker.com',
  'theatlantic.com',
];

// ─── env ────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const envFile = resolve(import.meta.dirname ?? '.', '../../.dev.vars');
  if (!existsSync(envFile))
    throw new Error(`.dev.vars not found at ${envFile}`);
  const env: Record<string, string> = {};
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.+)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  for (const k of ['SCRAPER_API_KEY']) {
    if (!env[k]) throw new Error(`Missing ${k} in .dev.vars`);
  }
  return env;
}
const ENV = loadEnv();

function getCfApiToken(): string {
  if (ENV.CLOUDFLARE_API_TOKEN) return ENV.CLOUDFLARE_API_TOKEN;
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const macPath = resolve(
    process.env.HOME || '~',
    'Library/Preferences/.wrangler/config/default.toml'
  );
  if (existsSync(macPath)) {
    const m = readFileSync(macPath, 'utf-8').match(
      /oauth_token\s*=\s*"([^"]+)"/
    );
    if (m) return m[1];
  }
  throw new Error(
    'No Cloudflare API token. Run `npx wrangler login` or set CLOUDFLARE_API_TOKEN.'
  );
}

// ─── d1 ────────────────────────────────────────────────────────────

async function d1Query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const token = getCfApiToken();
  const res = await fetch(D1_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) {
    throw new Error(
      `D1 query failed (${res.status}): ${(await res.text()).slice(0, 300)}`
    );
  }
  const data = (await res.json()) as { result: { results: T[] }[] };
  return data.result?.[0]?.results ?? [];
}

// ─── helpers ───────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function domainMatches(url: string, list: string[]): boolean {
  const d = extractDomain(url);
  return !!d && list.some((x) => d === x || d.endsWith('.' + x));
}

function shouldSkip(url: string): boolean {
  return domainMatches(url, SKIP_DOMAINS);
}

function shouldRenderDirect(url: string): boolean {
  return domainMatches(url, RENDER_DIRECT_DOMAINS);
}

// ─── ScraperAPI ────────────────────────────────────────────────────

interface ScrapeResult {
  ok: boolean;
  html?: string;
  status?: number;
  error?: string;
  creditsUsed: number;
}

async function scrape(url: string, render: boolean): Promise<ScrapeResult> {
  const apiUrl =
    `https://api.scraperapi.com?api_key=${ENV.SCRAPER_API_KEY}` +
    `&url=${encodeURIComponent(url)}` +
    (render ? '&render=true' : '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SCRAPERAPI_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl, { signal: ctrl.signal });
    clearTimeout(t);
    // sa-credit-cost is the actual number of requests ScraperAPI charged
    // for this single call. Premium / paywalled sites cost 10 even
    // without &render=true; cheap static pages cost 1. Header may be
    // absent on errors — fall back to the documented base price.
    const rawCost = res.headers.get('sa-credit-cost');
    const reportedCost = rawCost ? Number(rawCost) : NaN;
    const creditsUsed =
      Number.isFinite(reportedCost) && reportedCost > 0
        ? reportedCost
        : render
          ? 10
          : 1;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `http_${res.status}`,
        creditsUsed,
      };
    }
    const html = await res.text();
    return {
      ok: true,
      html,
      status: res.status,
      creditsUsed,
    };
  } catch (e) {
    clearTimeout(t);
    return {
      ok: false,
      error: (e as Error).message.slice(0, 200),
      creditsUsed: render ? 10 : 1,
    };
  }
}

interface AccountInfo {
  requestCount: number;
  requestLimit: number;
  failedRequestCount: number;
}

async function fetchAccountInfo(): Promise<AccountInfo> {
  const res = await fetch(
    `https://api.scraperapi.com/account?api_key=${ENV.SCRAPER_API_KEY}`,
    { signal: AbortSignal.timeout(15_000) }
  );
  if (!res.ok) throw new Error(`account fetch failed: ${res.status}`);
  return res.json() as Promise<AccountInfo>;
}

// ─── readability ────────────────────────────────────────────────────

interface ExtractedBody {
  contentHtml: string;
  textLength: number;
}

function extractBody(html: string, url: string): ExtractedBody | null {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (!article || !article.content) return null;
    const text = htmlToText(article.content);
    return { contentHtml: article.content, textLength: text.length };
  } catch {
    return null;
  }
}

// ─── recovery flow per row ─────────────────────────────────────────

interface NoBodyRow {
  id: number;
  url: string;
  title: string | null;
}

interface RecoveryOutcome {
  id: number;
  url: string;
  status: 'recovered' | 'failed' | 'skipped_paywalled' | 'skipped_invalid_url';
  reason?: string;
  bodyChars?: number;
  creditsUsed: number;
  tookMs: number;
}

async function recoverRow(
  row: NoBodyRow,
  opts: { dryRun: boolean; renderOnly: boolean }
): Promise<RecoveryOutcome> {
  const t0 = Date.now();
  if (!row.url || !/^https?:\/\//i.test(row.url)) {
    return {
      id: row.id,
      url: row.url ?? '',
      status: 'skipped_invalid_url',
      creditsUsed: 0,
      tookMs: Date.now() - t0,
    };
  }
  if (shouldSkip(row.url)) {
    return {
      id: row.id,
      url: row.url,
      status: 'skipped_paywalled',
      creditsUsed: 0,
      tookMs: Date.now() - t0,
    };
  }

  let totalCredits = 0;
  let extracted: ExtractedBody | null = null;
  // Skip the static-first attempt for known-paywalled-but-render-able
  // domains (NYT, etc) where static returns a stub.
  const renderDirect = opts.renderOnly || shouldRenderDirect(row.url);

  // Tier 1: static fetch (1 credit for cheap sites, 10 if ScraperAPI
  // auto-elevates the request to a premium proxy).
  if (!renderDirect) {
    const r = await scrape(row.url, false);
    totalCredits += r.creditsUsed;
    if (r.ok && r.html) {
      extracted = extractBody(r.html, row.url);
    }
  }

  // Tier 2: render fallback (10 credits) if static extraction was
  // empty / too short, or if the domain skips static.
  if (!extracted || extracted.textLength < MIN_BODY_CHARS) {
    const r = await scrape(row.url, true);
    totalCredits += r.creditsUsed;
    if (r.ok && r.html) {
      const e = extractBody(r.html, row.url);
      // Take whichever extraction was longer
      if (e && (!extracted || e.textLength > extracted.textLength)) {
        extracted = e;
      }
    }
  }

  if (!extracted || extracted.textLength < MIN_BODY_CHARS) {
    if (!opts.dryRun) {
      await d1Query(
        `UPDATE reading_items
         SET enrichment_error = ?, updated_at = ?
         WHERE id = ?`,
        [
          'scraperapi_failed: extracted_body_too_short',
          new Date().toISOString(),
          row.id,
        ]
      );
    }
    return {
      id: row.id,
      url: row.url,
      status: 'failed',
      reason: extracted ? `body_${extracted.textLength}c` : 'no_extraction',
      creditsUsed: totalCredits,
      tookMs: Date.now() - t0,
    };
  }

  const text = htmlToText(extracted.contentHtml);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const estimatedReadMin = Math.max(
    1,
    Math.round(wordCount / WORDS_PER_MINUTE)
  );
  const bodyExcerpt = text.slice(0, 3000);
  const nowIso = new Date().toISOString();

  if (!opts.dryRun) {
    await d1Query(
      `UPDATE reading_items
       SET content = ?,
           body_excerpt = ?,
           word_count = ?,
           estimated_read_min = ?,
           enrichment_status = 'completed',
           enrichment_error = NULL,
           updated_at = ?
       WHERE id = ?`,
      [
        extracted.contentHtml,
        bodyExcerpt,
        wordCount,
        estimatedReadMin,
        nowIso,
        row.id,
      ]
    );
  }

  return {
    id: row.id,
    url: row.url,
    status: 'recovered',
    bodyChars: extracted.textLength,
    creditsUsed: totalCredits,
    tookMs: Date.now() - t0,
  };
}

// ─── worker pool ────────────────────────────────────────────────────

async function runPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
  onResult?: (r: R, idx: number) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      const r = await fn(items[i], i);
      results[i] = r;
      onResult?.(r, i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// ─── main ───────────────────────────────────────────────────────────

interface CliOpts {
  limit: number;
  dryRun: boolean;
  concurrency: number;
  renderOnly: boolean;
  logPath: string;
}

function parseCli(argv: string[]): CliOpts {
  const opts: CliOpts = {
    limit: Number.MAX_SAFE_INTEGER,
    dryRun: false,
    concurrency: 5,
    renderOnly: false,
    logPath: '/tmp/recover-no-body.log',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i]);
    else if (a === '--render-only') opts.renderOnly = true;
    else if (a === '--log') opts.logPath = argv[++i];
  }
  return opts;
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  console.log(
    `[phase2] limit=${opts.limit === Number.MAX_SAFE_INTEGER ? 'all' : opts.limit} ` +
      `concurrency=${opts.concurrency} dry=${opts.dryRun} render-only=${opts.renderOnly} ` +
      `log=${opts.logPath}`
  );

  const rows = await d1Query<NoBodyRow>(
    `SELECT id, url, title FROM reading_items
     WHERE user_id = 1
       AND enrichment_status = 'no_body'
       AND url IS NOT NULL
       AND (enrichment_error IS NULL OR enrichment_error NOT LIKE 'scraperapi_%')
     ORDER BY id
     LIMIT ?`,
    [opts.limit]
  );

  console.log(`[phase2] candidates: ${rows.length}`);
  if (rows.length === 0) {
    console.log('[phase2] nothing to do');
    return;
  }

  const startInfo = await fetchAccountInfo();
  const startReqs = startInfo.requestCount;
  const requestLimit = startInfo.requestLimit;
  console.log(
    `[phase2] ScraperAPI account: requestCount=${startReqs}/${requestLimit} ` +
      `(remaining=${requestLimit - startReqs})`
  );

  appendFileSync(
    opts.logPath,
    `\n=== ${new Date().toISOString()} run started, ${rows.length} candidates, ` +
      `start_requests=${startReqs}/${requestLimit} ===\n`
  );

  const counts = {
    recovered: 0,
    failed: 0,
    skipped_paywalled: 0,
    skipped_invalid_url: 0,
  };
  let totalCredits = 0;
  let halted = false;
  let lastRequestCount = startReqs;
  let nextAccountCheck = 50; // poll /account after every 50 rows

  await runPool(
    rows,
    opts.concurrency,
    async (row) => {
      if (halted) {
        return {
          id: row.id,
          url: row.url,
          status: 'failed' as const,
          reason: 'halted',
          creditsUsed: 0,
          tookMs: 0,
        };
      }
      const r = await recoverRow(row, {
        dryRun: opts.dryRun,
        renderOnly: opts.renderOnly,
      });
      counts[r.status]++;
      totalCredits += r.creditsUsed;
      return r;
    },
    (r, idx) => {
      appendFileSync(
        opts.logPath,
        JSON.stringify({
          idx,
          id: r.id,
          url: r.url.slice(0, 100),
          status: r.status,
          ...(r.reason && { reason: r.reason }),
          ...(r.bodyChars !== undefined && { bodyChars: r.bodyChars }),
          creditsUsed: r.creditsUsed,
          tookMs: r.tookMs,
        }) + '\n'
      );

      // Periodic account poll + halt check
      if (idx + 1 >= nextAccountCheck && !halted) {
        nextAccountCheck = idx + 1 + 50;
        // fire-and-forget: don't block the worker; halt by side effect
        fetchAccountInfo()
          .then((info) => {
            lastRequestCount = info.requestCount;
            const remaining = info.requestLimit - info.requestCount;
            if (remaining < MIN_REQUEST_FLOOR) {
              halted = true;
              console.log(
                `[phase2] HALT: remaining=${remaining} below floor ${MIN_REQUEST_FLOOR}`
              );
            }
          })
          .catch((e) => {
            console.log(
              `[phase2] account-poll failed: ${(e as Error).message}`
            );
          });
      }

      if ((idx + 1) % 25 === 0) {
        const attempted = counts.recovered + counts.failed; // exclude skipped from rate
        const successRate = attempted ? counts.recovered / attempted : 0;
        const remaining = requestLimit - lastRequestCount;
        console.log(
          `[phase2] ${idx + 1}/${rows.length} ` +
            `recovered=${counts.recovered} ` +
            `failed=${counts.failed} ` +
            `skipped_paywalled=${counts.skipped_paywalled} ` +
            `skipped_invalid=${counts.skipped_invalid_url} ` +
            `success_rate=${(successRate * 100).toFixed(1)}% ` +
            `script_credits=${totalCredits} ` +
            `account_remaining=${remaining}`
        );
      }
    }
  );

  // Final account poll for the run summary
  let endInfo: AccountInfo | null = null;
  try {
    endInfo = await fetchAccountInfo();
  } catch {
    /* tolerate */
  }
  const endReqs = endInfo?.requestCount ?? lastRequestCount;
  const requestsConsumed = endReqs - startReqs;

  console.log(
    `\n[phase2] DONE recovered=${counts.recovered} ` +
      `failed=${counts.failed} ` +
      `skipped_paywalled=${counts.skipped_paywalled} ` +
      `skipped_invalid_url=${counts.skipped_invalid_url} ` +
      `script_credits=${totalCredits} ` +
      `account_requests_consumed=${requestsConsumed} ` +
      `account_remaining=${requestLimit - endReqs} ` +
      `halted=${halted}`
  );
  appendFileSync(
    opts.logPath,
    `=== ${new Date().toISOString()} run done. recovered=${counts.recovered} ` +
      `failed=${counts.failed} skipped_paywalled=${counts.skipped_paywalled} ` +
      `skipped_invalid=${counts.skipped_invalid_url} script_credits=${totalCredits} ` +
      `account_requests_consumed=${requestsConsumed} ===\n`
  );
}

main().catch((e) => {
  console.error('[phase2] fatal:', e);
  process.exit(1);
});
