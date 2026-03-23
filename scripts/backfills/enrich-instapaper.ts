/**
 * Instapaper Enrichment Script
 *
 * Enriches existing reading_items with OG metadata and word count.
 * Runs against the remote D1 database. Tracks enrichment status per article
 * so it can be resumed and re-run without redoing completed items.
 *
 * Extracts:
 *   - og:image URL (for image pipeline)
 *   - og:site_name ("Wired", "The New York Times")
 *   - article:author
 *   - article:published_time (original publish date)
 *   - og:description (fallback if Instapaper description is empty)
 *   - article:section / article:tag (publisher categorization)
 *   - Word count + estimated read time (from Instapaper get_text)
 *   - Full article content (for future full-text search)
 *
 * Tracks failures per article so we know which domains block scraping.
 *
 * Usage:
 *   npx tsx scripts/backfills/enrich-instapaper.ts
 *
 * Skip get_text (OG metadata only):
 *   npx tsx scripts/backfills/enrich-instapaper.ts --skip-text
 *
 * Retry previously failed articles:
 *   npx tsx scripts/backfills/enrich-instapaper.ts --retry-failed
 *
 * Report only (show failure stats without enriching):
 *   npx tsx scripts/backfills/enrich-instapaper.ts --report
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import crypto from 'node:crypto';
import querystring from 'node:querystring';
import https from 'node:https';

// --- Config ---

const CF_ACCOUNT_ID = '46bcea726724fbab7d60f236f151f3d3';
const CF_DATABASE_ID = '35a4edf8-0d4f-4cbe-9a6e-6f1525716774';
const D1_API_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_DATABASE_ID}/query`;

const OG_FETCH_DELAY_MS = 300;
const GET_TEXT_DELAY_MS = 500;
const WORDS_PER_MINUTE = 238;

// --- Load env ---

function loadEnv(): Record<string, string> {
  const envFile = resolve(import.meta.dirname ?? '.', '../../.dev.vars');
  const content = readFileSync(envFile, 'utf-8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^([^=]+)=(.+)$/);
    if (match) env[match[1].trim()] = match[2].trim();
  }
  return env;
}

const ENV = loadEnv();

// --- CF API Token ---

function getCfApiToken(): string {
  const macPath = resolve(
    process.env.HOME || '~',
    'Library/Preferences/.wrangler/config/default.toml'
  );
  const linuxPath = resolve(
    process.env.XDG_CONFIG_HOME || resolve(process.env.HOME || '~', '.config'),
    'wrangler/config/default.toml'
  );
  const tokenFile = existsSync(macPath) ? macPath : linuxPath;
  if (existsSync(tokenFile)) {
    const content = readFileSync(tokenFile, 'utf-8');
    const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  throw new Error('No Cloudflare API token found.');
}

// --- D1 ---

async function d1Query(
  sql: string,
  params: unknown[] = []
): Promise<unknown[]> {
  const token = getCfApiToken();
  const response = await fetch(D1_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `D1 query failed (${response.status}): ${text.slice(0, 300)}`
    );
  }
  const data = (await response.json()) as {
    result: { results: unknown[] }[];
  };
  return data.result?.[0]?.results ?? [];
}

// --- OAuth 1.0a ---

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function generateSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string
): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
  const base = `${method}&${percentEncode(url)}&${percentEncode(sorted)}`;
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', key).update(base).digest('base64');
}

async function instapaperRequest(
  path: string,
  body: Record<string, string> = {}
): Promise<string> {
  const url = `https://www.instapaper.com/api${path}`;
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: ENV.INSTAPAPER_CONSUMER_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: ENV.INSTAPAPER_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  oauthParams.oauth_signature = generateSignature(
    'POST',
    url,
    { ...oauthParams, ...body },
    ENV.INSTAPAPER_CONSUMER_SECRET,
    ENV.INSTAPAPER_ACCESS_TOKEN_SECRET
  );
  const authHeader =
    'OAuth ' +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
      .join(', ');
  const postBody = querystring.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'www.instapaper.com',
        path: `/api${path}`,
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postBody),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          } else {
            resolve(data);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(postBody);
    req.end();
  });
}

// --- OG metadata ---

interface OgResult {
  ogImage: string | null;
  siteName: string | null;
  author: string | null;
  publishedAt: string | null;
  ogDescription: string | null;
  articleTags: string | null;
  error: string | null;
}

async function fetchOgMetadata(url: string): Promise<OgResult> {
  const result: OgResult = {
    ogImage: null,
    siteName: null,
    author: null,
    publishedAt: null,
    ogDescription: null,
    articleTags: null,
    error: null,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      result.error = `HTTP ${response.status}`;
      return result;
    }

    const html = await response.text();
    const headEnd = html.indexOf('</head>');
    const head = html.slice(0, headEnd > 0 ? headEnd + 7 : 50000);

    // Helper to extract meta content
    const getMeta = (property: string): string | null => {
      const re1 = new RegExp(
        `<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']+)["']`,
        'i'
      );
      const re2 = new RegExp(
        `<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${property}["']`,
        'i'
      );
      return head.match(re1)?.[1] ?? head.match(re2)?.[1] ?? null;
    };

    result.ogImage = getMeta('og:image');
    result.siteName = getMeta('og:site_name');
    result.ogDescription = getMeta('og:description');
    result.publishedAt =
      getMeta('article:published_time') ??
      getMeta('datePublished') ??
      getMeta('date');
    result.author =
      getMeta('author') ?? getMeta('article:author') ?? getMeta('byl'); // NYT uses 'byl'

    // Article tags/section
    const section = getMeta('article:section');
    const tags: string[] = [];
    if (section) tags.push(section);
    // Collect all article:tag meta tags
    const tagRegex =
      /<meta[^>]*(?:property|name)=["']article:tag["'][^>]*content=["']([^"']+)["']/gi;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(head)) !== null) {
      tags.push(tagMatch[1]);
    }
    result.articleTags = tags.length > 0 ? JSON.stringify(tags) : null;
  } catch (err) {
    result.error =
      err instanceof Error
        ? err.name === 'AbortError'
          ? 'timeout'
          : err.message
        : String(err);
  }

  return result;
}

// --- Word count ---

function computeWordCount(html: string): {
  wordCount: number;
  estimatedReadMin: number;
} {
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const wordCount = text ? text.split(' ').length : 0;
  return {
    wordCount,
    estimatedReadMin: Math.ceil(wordCount / WORDS_PER_MINUTE),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const skipText = args.includes('--skip-text');
  const retryFailed = args.includes('--retry-failed');
  const reportOnly = args.includes('--report');

  // Report mode — just show stats
  if (reportOnly) {
    const stats = (await d1Query(`
      SELECT
        enrichment_status,
        COUNT(*) as count
      FROM reading_items
      WHERE item_type = 'article'
      GROUP BY enrichment_status
    `)) as { enrichment_status: string | null; count: number }[];

    console.log('[INFO] Enrichment status breakdown:');
    for (const s of stats) {
      console.log(`  ${s.enrichment_status ?? 'pending'}: ${s.count}`);
    }

    const errors = (await d1Query(`
      SELECT
        enrichment_error,
        domain,
        COUNT(*) as count
      FROM reading_items
      WHERE enrichment_status = 'failed'
      GROUP BY enrichment_error, domain
      ORDER BY count DESC
      LIMIT 20
    `)) as { enrichment_error: string; domain: string; count: number }[];

    if (errors.length > 0) {
      console.log('\n[INFO] Top failure reasons:');
      for (const e of errors) {
        console.log(`  ${e.count}x ${e.domain}: ${e.enrichment_error}`);
      }
    }

    const domainFailures = (await d1Query(`
      SELECT
        domain,
        COUNT(*) as total,
        SUM(CASE WHEN enrichment_status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM reading_items
      WHERE item_type = 'article' AND url IS NOT NULL
      GROUP BY domain
      HAVING failed > 0
      ORDER BY failed DESC
      LIMIT 20
    `)) as { domain: string; total: number; failed: number }[];

    if (domainFailures.length > 0) {
      console.log('\n[INFO] Domains with failures:');
      for (const d of domainFailures) {
        const pct = ((d.failed / d.total) * 100).toFixed(0);
        console.log(`  ${d.domain}: ${d.failed}/${d.total} failed (${pct}%)`);
      }
    }

    return;
  }

  // Get articles to enrich
  let whereClause: string;
  if (retryFailed) {
    whereClause = `WHERE item_type = 'article' AND url IS NOT NULL AND enrichment_status = 'failed'`;
  } else {
    whereClause = `WHERE item_type = 'article' AND url IS NOT NULL AND (enrichment_status = 'pending' OR enrichment_status IS NULL)`;
  }

  const articles = (await d1Query(
    `SELECT id, source_id, url, domain, title FROM reading_items ${whereClause} ORDER BY id`
  )) as {
    id: number;
    source_id: string;
    url: string;
    domain: string;
    title: string;
  }[];

  console.log(`[INFO] Found ${articles.length} articles to enrich`);
  if (skipText) console.log('[INFO] Skipping get_text (--skip-text)');

  let enriched = 0;
  let failed = 0;
  let ogSuccess = 0;
  let textSuccess = 0;

  for (const article of articles) {
    // OG metadata
    await sleep(OG_FETCH_DELAY_MS);
    const og = await fetchOgMetadata(article.url);

    if (og.error) {
      failed++;
      await d1Query(
        `UPDATE reading_items SET
          enrichment_status = 'failed',
          enrichment_error = ?,
          updated_at = datetime('now')
        WHERE id = ?`,
        [og.error, article.id]
      );

      if (failed % 10 === 0) {
        console.log(`[WARN] ${failed} failures so far`);
      }
    } else {
      ogSuccess++;

      // Word count via get_text
      let wordCount: number | null = null;
      let estimatedReadMin: number | null = null;
      let content: string | null = null;

      if (!skipText) {
        try {
          await sleep(GET_TEXT_DELAY_MS);
          const html = await instapaperRequest(`/1/bookmarks/get_text`, {
            bookmark_id: article.source_id,
          });
          const wc = computeWordCount(html);
          wordCount = wc.wordCount;
          estimatedReadMin = wc.estimatedReadMin;
          content = html;
          textSuccess++;
        } catch {
          // Non-fatal — article may have been deleted from Instapaper
        }
      }

      await d1Query(
        `UPDATE reading_items SET
          site_name = COALESCE(?, site_name),
          author = COALESCE(?, author),
          published_at = COALESCE(?, published_at),
          og_image_url = COALESCE(?, og_image_url),
          og_description = COALESCE(?, og_description),
          article_tags = COALESCE(?, article_tags),
          word_count = COALESCE(?, word_count),
          estimated_read_min = COALESCE(?, estimated_read_min),
          content = COALESCE(?, content),
          description = CASE WHEN description IS NULL OR description = '' THEN COALESCE(?, description) ELSE description END,
          enrichment_status = 'completed',
          enrichment_error = NULL,
          updated_at = datetime('now')
        WHERE id = ?`,
        [
          og.siteName,
          og.author,
          og.publishedAt,
          og.ogImage,
          og.ogDescription,
          og.articleTags,
          wordCount,
          estimatedReadMin,
          content,
          og.ogDescription,
          article.id,
        ]
      );

      enriched++;
    }

    if ((enriched + failed) % 50 === 0) {
      console.log(
        `[INFO] Progress: ${enriched + failed}/${articles.length} (${enriched} enriched, ${failed} failed, OG: ${ogSuccess}, text: ${textSuccess})`
      );
    }
  }

  console.log('\n[INFO] === Enrichment complete ===');
  console.log(`[INFO] Total processed: ${enriched + failed}`);
  console.log(`[INFO] Enriched: ${enriched}`);
  console.log(`[INFO] Failed: ${failed}`);
  console.log(`[INFO] OG metadata: ${ogSuccess} succeeded`);
  console.log(`[INFO] get_text: ${textSuccess} succeeded`);
  console.log('\n[INFO] Run with --report to see failure breakdown by domain');
}

main().catch((err) => {
  console.error(`[ERROR] Enrichment failed: ${err.message}`);
  process.exit(1);
});
