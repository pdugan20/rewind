/**
 * Instapaper Historical Import Script
 *
 * One-time script to import full Instapaper bookmark history into the remote D1
 * database. Fetches bookmarks from all folders, enriches with OG metadata and
 * word count via get_text, and imports highlights.
 *
 * Supports checkpoint/resume for interrupted imports.
 *
 * Prerequisites:
 *   1. .dev.vars contains INSTAPAPER_CONSUMER_KEY, INSTAPAPER_CONSUMER_SECRET,
 *      INSTAPAPER_ACCESS_TOKEN, INSTAPAPER_ACCESS_TOKEN_SECRET
 *   2. Ensure wrangler is authenticated (`npx wrangler login`).
 *   3. Migration 0022_reading_domain.sql applied to remote D1.
 *
 * Usage:
 *   npx tsx scripts/imports/import-instapaper.ts
 *
 * Resume from checkpoint:
 *   npx tsx scripts/imports/import-instapaper.ts --resume
 *
 * Skip enrichment (bookmarks only, no get_text or OG):
 *   npx tsx scripts/imports/import-instapaper.ts --skip-enrich
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import crypto from 'node:crypto';
import querystring from 'node:querystring';
import https from 'node:https';

// --- Config ---

const CF_ACCOUNT_ID = '46bcea726724fbab7d60f236f151f3d3';
const CF_DATABASE_ID = '35a4edf8-0d4f-4cbe-9a6e-6f1525716774';
const D1_API_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_DATABASE_ID}/query`;

const CHECKPOINT_FILE = resolve(
  import.meta.dirname ?? '.',
  '.instapaper-checkpoint.json'
);

const RATE_LIMIT_MS = 300;
const GET_TEXT_DELAY_MS = 500;
const OG_FETCH_DELAY_MS = 200;
const FINISHED_THRESHOLD = 0.75;
const WORDS_PER_MINUTE = 238;

// --- Load env from .dev.vars ---

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

// --- Cloudflare API Token ---

function getCfApiToken(): string {
  // macOS: ~/Library/Preferences/.wrangler/config/default.toml
  // Linux: ~/.config/wrangler/config/default.toml
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
  throw new Error(
    'No Cloudflare API token found. Run `npx wrangler login` first.'
  );
}

// --- D1 query helper ---

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

// --- OAuth 1.0a helpers ---

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

// --- Types ---

interface Bookmark {
  type: 'bookmark';
  bookmark_id: number;
  url: string;
  title: string;
  description: string;
  time: number;
  starred: string;
  hash: string;
  progress: number;
  progress_timestamp: number;
  tags: { id: number; name: string }[];
}

interface Highlight {
  highlight_id: number;
  bookmark_id: number;
  text: string;
  position: number;
  time: number;
}

interface Checkpoint {
  folders_done: string[];
  bookmarks_imported: number;
  highlights_imported: number;
  enriched: number;
}

// --- Helpers ---

function deriveStatus(folder: string, progress: number): string {
  if (progress >= FINISHED_THRESHOLD) return 'finished';
  if (folder === 'archive' && progress === 0) return 'skipped';
  if (folder === 'archive' && progress > 0) return 'abandoned';
  if (progress > 0) return 'reading';
  return 'unread';
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function fetchOgMetadata(url: string): Promise<{
  ogImage: string | null;
  siteName: string | null;
  author: string | null;
}> {
  const result = {
    ogImage: null as string | null,
    siteName: null as string | null,
    author: null as string | null,
  };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': 'Rewind/1.0' },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return result;

    const html = await response.text();
    const headEnd = html.indexOf('</head>');
    const head = html.slice(0, headEnd > 0 ? headEnd + 7 : 50000);

    result.ogImage =
      head.match(
        /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i
      )?.[1] ??
      head.match(
        /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i
      )?.[1] ??
      null;
    result.siteName =
      head.match(
        /<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i
      )?.[1] ??
      head.match(
        /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i
      )?.[1] ??
      null;
    result.author =
      head.match(
        /<meta[^>]*(?:name|property)=["'](?:author|article:author)["'][^>]*content=["']([^"']+)["']/i
      )?.[1] ??
      head.match(
        /<meta[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["'](?:author|article:author)["']/i
      )?.[1] ??
      null;
  } catch {
    // Non-fatal
  }
  return result;
}

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

function loadCheckpoint(): Checkpoint {
  if (existsSync(CHECKPOINT_FILE)) {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'));
  }
  return {
    folders_done: [],
    bookmarks_imported: 0,
    highlights_imported: 0,
    enriched: 0,
  };
}

function saveCheckpoint(cp: Checkpoint): void {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const resume = args.includes('--resume');
  const skipEnrich = args.includes('--skip-enrich');

  const cp = resume
    ? loadCheckpoint()
    : {
        folders_done: [],
        bookmarks_imported: 0,
        highlights_imported: 0,
        enriched: 0,
      };

  console.log(
    `[INFO] Starting Instapaper import${resume ? ' (resuming)' : ''}`
  );
  if (skipEnrich) console.log('[INFO] Skipping enrichment (--skip-enrich)');

  const folders = ['unread', 'starred', 'archive'];

  for (const folder of folders) {
    if (cp.folders_done.includes(folder)) {
      console.log(`[INFO] Skipping ${folder} (already done)`);
      continue;
    }

    console.log(`\n[INFO] === Fetching ${folder} bookmarks ===`);

    await sleep(RATE_LIMIT_MS);
    const raw = await instapaperRequest('/1/bookmarks/list', {
      folder_id: folder,
      limit: '500',
    });
    const items = JSON.parse(raw) as (Bookmark | { type: string })[];
    const bookmarks = items.filter((i): i is Bookmark => i.type === 'bookmark');

    console.log(`[INFO] Got ${bookmarks.length} bookmarks from ${folder}`);

    for (const bm of bookmarks) {
      const savedAt = new Date(bm.time * 1000).toISOString();
      const progressUpdatedAt =
        bm.progress_timestamp > 0
          ? new Date(bm.progress_timestamp * 1000).toISOString()
          : null;
      const status = deriveStatus(folder, bm.progress);
      const domain = extractDomain(bm.url);
      const tags =
        bm.tags?.length > 0 ? JSON.stringify(bm.tags.map((t) => t.name)) : null;

      // Upsert bookmark
      await d1Query(
        `INSERT INTO reading_items (
          user_id, item_type, source, source_id, url, title, description,
          domain, status, progress, progress_updated_at, starred, folder,
          tags, saved_at, started_at, finished_at, created_at, updated_at
        ) VALUES (1, 'article', 'instapaper', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(source, source_id, user_id) DO UPDATE SET
          status = excluded.status,
          progress = excluded.progress,
          progress_updated_at = excluded.progress_updated_at,
          starred = excluded.starred,
          folder = excluded.folder,
          tags = excluded.tags,
          updated_at = datetime('now')`,
        [
          String(bm.bookmark_id),
          bm.url || null,
          bm.title || 'Untitled',
          bm.description || null,
          domain,
          status,
          bm.progress,
          progressUpdatedAt,
          bm.starred === '1' ? 1 : 0,
          folder,
          tags,
          savedAt,
          bm.progress > 0 ? progressUpdatedAt : null,
          status === 'finished' ? (progressUpdatedAt ?? savedAt) : null,
        ]
      );
      cp.bookmarks_imported++;

      // Fetch highlights
      try {
        await sleep(RATE_LIMIT_MS);
        const hlRaw = await instapaperRequest(
          `/1.1/bookmarks/${bm.bookmark_id}/highlights`
        );
        const highlights = JSON.parse(hlRaw) as Highlight[];
        for (const hl of highlights) {
          const rows = (await d1Query(
            `SELECT id FROM reading_items WHERE source = 'instapaper' AND source_id = ? AND user_id = 1`,
            [String(bm.bookmark_id)]
          )) as { id: number }[];
          if (rows.length === 0) continue;

          await d1Query(
            `INSERT INTO reading_highlights (user_id, item_id, source_id, text, position, created_at)
             VALUES (1, ?, ?, ?, ?, ?)
             ON CONFLICT(source_id, user_id) DO NOTHING`,
            [
              rows[0].id,
              String(hl.highlight_id),
              hl.text,
              hl.position,
              new Date(hl.time * 1000).toISOString(),
            ]
          );
          cp.highlights_imported++;
        }
      } catch {
        // Non-fatal
      }

      // Enrichment
      if (!skipEnrich && bm.url) {
        try {
          await sleep(OG_FETCH_DELAY_MS);
          const og = await fetchOgMetadata(bm.url);

          let wordCount: number | null = null;
          let estimatedReadMin: number | null = null;
          let content: string | null = null;
          try {
            await sleep(GET_TEXT_DELAY_MS);
            const html = await instapaperRequest('/1/bookmarks/get_text', {
              bookmark_id: String(bm.bookmark_id),
            });
            const wc = computeWordCount(html);
            wordCount = wc.wordCount;
            estimatedReadMin = wc.estimatedReadMin;
            content = html;
          } catch {
            // Non-fatal
          }

          const rows = (await d1Query(
            `SELECT id FROM reading_items WHERE source = 'instapaper' AND source_id = ? AND user_id = 1`,
            [String(bm.bookmark_id)]
          )) as { id: number }[];
          if (rows.length > 0) {
            await d1Query(
              `UPDATE reading_items SET
                site_name = COALESCE(?, site_name),
                author = COALESCE(?, author),
                word_count = COALESCE(?, word_count),
                estimated_read_min = COALESCE(?, estimated_read_min),
                content = COALESCE(?, content),
                updated_at = datetime('now')
              WHERE id = ?`,
              [
                og.siteName,
                og.author,
                wordCount,
                estimatedReadMin,
                content,
                rows[0].id,
              ]
            );
            cp.enriched++;
          }
        } catch {
          // Non-fatal
        }
      }

      if (cp.bookmarks_imported % 50 === 0) {
        console.log(
          `[INFO] Progress: ${cp.bookmarks_imported} bookmarks, ${cp.highlights_imported} highlights, ${cp.enriched} enriched`
        );
        saveCheckpoint(cp);
      }
    }

    cp.folders_done.push(folder);
    saveCheckpoint(cp);
    console.log(`[INFO] Completed ${folder} folder`);
  }

  console.log('\n[INFO] === Import complete ===');
  console.log(`[INFO] Bookmarks: ${cp.bookmarks_imported}`);
  console.log(`[INFO] Highlights: ${cp.highlights_imported}`);
  console.log(`[INFO] Enriched: ${cp.enriched}`);
  saveCheckpoint(cp);
}

main().catch((err) => {
  console.error(`[ERROR] Import failed: ${err.message}`);
  process.exit(1);
});
