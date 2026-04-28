/**
 * One-shot backfill: ingest Instapaper bookmarks that aren't yet in
 * Rewind's `reading_items`. Reads the canonical Instapaper CSV export
 * (instapaper.com/user → Download .CSV file) plus optional manual IDs,
 * inserts missing rows via D1, and runs the inline-enrichment pieces
 * each row needs to be readable + searchable. Image enrichment and
 * embeddings get triggered through existing admin endpoints once the
 * inserts land.
 *
 * Why not extend the live sync? Instapaper's `bookmarks/list` is
 * hard-capped at 500 per folder, so anything older or "orphaned" (in
 * the user's account but not in any folder list) can never be reached
 * by sync. `bookmarks/get_text` works on any bookmark id the account
 * owns, which is exactly the path this script takes.
 *
 * Modes:
 *   --csv path/to/instapaper-export.csv
 *       Parse the canonical export; auto-detect bookmark_id (or
 *       extract from a `URL` column when the CSV uses the
 *       https://instapaper.com/read/{id} form).
 *
 *   --ids 1026945010,1234567,...
 *       For testing or surgical recovery. Looks up url+title from
 *       Instapaper's getText response; metadata is best-effort.
 *
 *   --dry-run
 *       Print what would happen, write nothing.
 *
 *   --limit N
 *       Cap the number of bookmarks processed. Useful for staged
 *       runs and cost control on the first pass.
 *
 * Pre-reqs:
 *   - .dev.vars at the repo root with the Instapaper OAuth quad
 *     (CONSUMER_KEY/SECRET, ACCESS_TOKEN/SECRET) plus REWIND_ADMIN_KEY
 *   - A live Cloudflare API token: either `npx wrangler login` (the
 *     script reads ~/Library/Preferences/.wrangler/config/default.toml)
 *     or CLOUDFLARE_API_TOKEN env var
 *
 * Post-run:
 *   The script triggers three admin endpoints in sequence so the new
 *   rows reach feature parity with cron-synced ones in one shot:
 *     - POST /v1/reading/admin/backfill-images   (image pipeline)
 *     - POST /v1/admin/reembed-reading           (Voyage embeddings)
 *     - POST /v1/admin/reindex-search            (FTS5 index)
 *   These are idempotent — re-running is safe.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as crypto from 'node:crypto';

const CF_ACCOUNT_ID = '46bcea726724fbab7d60f236f151f3d3';
const CF_DATABASE_ID = '35a4edf8-0d4f-4cbe-9a6e-6f1525716774';
const D1_API_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_DATABASE_ID}/query`;
const REWIND_API = 'https://api.rewind.rest';

// Halved from the original conservative pacing. Production live sync
// uses RATE_LIMIT_MS=200 (src/services/instapaper/client.ts) without
// hitting Instapaper rate limits, so 100ms between our own additional
// calls leaves headroom and matches that cadence.
const BOOKMARKS_ADD_DELAY_MS = 100;
const GET_TEXT_DELAY_MS = 200;
const OG_FETCH_DELAY_MS = 100;
const WORDS_PER_MINUTE = 238;

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
  for (const k of [
    'INSTAPAPER_CONSUMER_KEY',
    'INSTAPAPER_CONSUMER_SECRET',
    'INSTAPAPER_ACCESS_TOKEN',
    'INSTAPAPER_ACCESS_TOKEN_SECRET',
    'REWIND_ADMIN_KEY',
  ]) {
    if (!env[k]) throw new Error(`Missing ${k} in .dev.vars`);
  }
  return env;
}
const ENV = loadEnv();

function getCfApiToken(): string {
  // Prefer the long-lived `CLOUDFLARE_API_TOKEN` from .dev.vars (or
  // env) over the wrangler OAuth token, because the wrangler one
  // expires every 24h and would silently 401 mid-run on long
  // backfills. The wrangler-config fallback stays so dev scripts
  // that haven't been pointed at a custom token still work.
  if (ENV.CLOUDFLARE_API_TOKEN) return ENV.CLOUDFLARE_API_TOKEN;
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
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
    const m = content.match(/oauth_token\s*=\s*"([^"]+)"/);
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

// ─── instapaper oauth ──────────────────────────────────────────────

function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(
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
  const auth =
    'OAuth ' +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
      .join(', ');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    throw new Error(
      `Instapaper ${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`
    );
  }
  return res.text();
}

// ─── og fetch (mirrors src/services/instapaper/sync.ts:fetchOgMetadata) ─

interface OgResult {
  ogImage: string | null;
  ogDescription: string | null;
  siteName: string | null;
  author: string | null;
  publishedAt: string | null;
  articleSection: string | null;
  articleTags: string[] | null;
}

async function fetchOgMetadata(url: string): Promise<OgResult> {
  const empty: OgResult = {
    ogImage: null,
    ogDescription: null,
    siteName: null,
    author: null,
    publishedAt: null,
    articleSection: null,
    articleTags: null,
  };
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!res.ok) return empty;
    const html = (await res.text()).slice(0, 60_000);
    const head = (html.match(/<head[^>]*>([\s\S]*?)<\/head>/i) ?? [, html])[1];
    const meta = (re: RegExp): string | null => {
      const m = head.match(re);
      return m ? m[1].trim() : null;
    };
    const tags: string[] = [];
    const tagRe =
      /<meta[^>]+(?:property|name)="article:tag"[^>]+content="([^"]+)"/gi;
    let tm: RegExpExecArray | null;
    while ((tm = tagRe.exec(head)) !== null) tags.push(tm[1].trim());

    return {
      ogImage: meta(
        /<meta[^>]+(?:property|name)="og:image(?::secure_url)?"[^>]+content="([^"]+)"/i
      ),
      ogDescription: meta(
        /<meta[^>]+(?:property|name)="og:description"[^>]+content="([^"]+)"/i
      ),
      siteName: meta(
        /<meta[^>]+(?:property|name)="og:site_name"[^>]+content="([^"]+)"/i
      ),
      author: meta(
        /<meta[^>]+(?:property|name)="article:author"[^>]+content="([^"]+)"/i
      ),
      publishedAt: meta(
        /<meta[^>]+(?:property|name)="article:published_time"[^>]+content="([^"]+)"/i
      ),
      articleSection: meta(
        /<meta[^>]+(?:property|name)="article:section"[^>]+content="([^"]+)"/i
      ),
      articleTags: tags.length ? tags : null,
    };
  } catch {
    return empty;
  }
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

function computeWordCount(html: string): {
  wordCount: number;
  estimatedReadMin: number;
} {
  const text = htmlToText(html);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return {
    wordCount,
    estimatedReadMin: Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE)),
  };
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── csv parsing ───────────────────────────────────────────────────

interface BookmarkRecord {
  bookmarkId: number; // 0 if not yet resolved (CSV row, no id column)
  url: string;
  title: string;
  folder: string | null; // raw folder string from CSV
  savedAtSec: number | null; // unix seconds
  csvDescription?: string;
  starred?: boolean;
  progress?: number;
  sourceHash?: string;
}

function parseCsv(content: string): Record<string, string>[] {
  // Minimal RFC4180-ish parser — handles quoted fields with embedded
  // commas, escaped quotes, CRLF. Good enough for Instapaper's export.
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inQuote) {
      if (c === '"' && content[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuote = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') {
        cur.push(field);
        field = '';
      } else if (c === '\n') {
        cur.push(field);
        rows.push(cur);
        cur = [];
        field = '';
      } else if (c === '\r') {
        // ignore
      } else {
        field += c;
      }
    }
  }
  if (field || cur.length) {
    cur.push(field);
    rows.push(cur);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

function recordsFromCsv(content: string): BookmarkRecord[] {
  const rows = parseCsv(content);
  if (!rows.length) return [];

  // Auto-detect column names — Instapaper has changed export format
  // over the years; we tolerate a few synonyms.
  const sample = rows[0];
  const keys = Object.keys(sample);
  const find = (...cands: string[]) =>
    keys.find((k) => cands.some((c) => k.toLowerCase() === c.toLowerCase())) ??
    null;
  const urlKey = find('URL', 'Url', 'url');
  const titleKey = find('Title', 'title');
  const folderKey = find('Folder', 'folder');
  const timeKey = find('Timestamp', 'time', 'Time');
  const idKey = find('bookmark_id', 'BookmarkId', 'id');

  const out: BookmarkRecord[] = [];
  for (const row of rows) {
    let bookmarkId: number | 0 = 0;
    if (idKey && row[idKey]) bookmarkId = Number(row[idKey]) || 0;
    if (!bookmarkId && urlKey) {
      // Some Instapaper exports use the read URL form; extract the id.
      const m = row[urlKey].match(/instapaper\.com\/read\/(\d+)/i);
      if (m) bookmarkId = Number(m[1]);
    }
    const url = (urlKey && row[urlKey]) || '';
    const title = (titleKey && row[titleKey]) || '';
    const folder = (folderKey && row[folderKey]) || null;
    const ts = timeKey && row[timeKey] ? Number(row[timeKey]) : null;
    if (!url && !bookmarkId) continue; // need at least one
    out.push({
      bookmarkId,
      url,
      title,
      folder,
      savedAtSec: Number.isFinite(ts) ? (ts as number) : null,
    });
  }
  return out;
}

// ─── existing-row check ────────────────────────────────────────────

async function fetchExistingState(): Promise<{
  ids: Set<number>;
  urls: Set<string>;
}> {
  // Query D1 directly — one round trip, no pagination, no
  // rate-limit window. The Rewind /v1/reading/articles endpoint we
  // were using has a sliding-window 60-RPM limiter and ~73 pages
  // (3K+ rows / 50 page) tripped it instantly. The CF API token
  // path has no equivalent quota.
  const rows = await d1Query<{ source_id: string; url: string | null }>(
    `SELECT source_id, url
       FROM reading_items
      WHERE source = 'instapaper' AND user_id = 1`
  );
  const ids = new Set<number>();
  const urls = new Set<string>();
  for (const r of rows) {
    const id = Number(r.source_id);
    if (Number.isFinite(id)) ids.add(id);
    if (r.url) urls.add(normalizeUrl(r.url));
  }
  return { ids, urls };
}

function normalizeUrl(u: string): string {
  return u
    .toLowerCase()
    .replace(/\/$/, '')
    .replace(/^https?:\/\//, ''); // strip protocol so http vs https drift doesn't fool the dedup
}

// ─── per-bookmark ingest ───────────────────────────────────────────

interface IngestResult {
  bookmarkId: number;
  status: 'inserted' | 'skipped' | 'failed';
  reason?: string;
}

interface AddedBookmark {
  bookmark_id: number;
  url: string;
  title: string;
  description: string;
  starred: string; // "0" or "1"
  progress: number;
  hash: string;
  time: number;
  tags: { id: number; name: string }[];
}

// Idempotent URL → bookmark_id resolver. Instapaper's bookmarks/list is
// capped at 500/folder, but bookmarks/add returns the existing
// bookmark for any URL already saved, including orphaned ones not in
// any folder list. We pass `archived=1` for non-Unread CSV rows so
// the bookmark lands directly in Archive — eliminates the Unread
// folder pollution + iOS push notifications that the old two-call
// (add → archive) pattern caused. Confirmed empirically that the
// Unread folder count is unchanged across an `add archived=1` call.
async function bookmarksAdd(
  url: string,
  archived = true
): Promise<AddedBookmark | null> {
  const body: Record<string, string> = { url };
  if (archived) body.archived = '1';
  const res = await instapaperRequest('/1/bookmarks/add', body);
  const items = JSON.parse(res) as Array<Record<string, unknown>>;
  const bm = items.find((it) => it.type === 'bookmark') as unknown as
    | AddedBookmark
    | undefined;
  return bm ?? null;
}

async function ingestBookmark(
  rec: BookmarkRecord,
  existingIds: Set<number>,
  dryRun: boolean
): Promise<IngestResult> {
  // 0. Resolve URL → bookmark_id. The CSV does not expose
  // bookmark_id, so we round-trip through bookmarks/add (idempotent
  // for already-saved URLs).
  if (!rec.bookmarkId) {
    if (!rec.url) {
      return {
        bookmarkId: 0,
        status: 'failed',
        reason: 'no url and no bookmark_id in record',
      };
    }
    try {
      // Pass archived=1 unless the CSV says this row is genuinely in
      // Unread — that single bit determines whether the bookmark
      // lands in Archive (default) or stays in Unread.
      const wantArchived = !rec.folder || rec.folder.toLowerCase() !== 'unread';
      const bm = await bookmarksAdd(rec.url, wantArchived);
      if (!bm) {
        return {
          bookmarkId: 0,
          status: 'failed',
          reason: 'bookmarks/add returned no bookmark',
        };
      }
      rec.bookmarkId = bm.bookmark_id;
      // Prefer Instapaper's current canonical metadata over the CSV's
      // historical snapshot — title can differ when Instapaper later
      // resolves a server-side title that wasn't ready at save time.
      if (bm.title) rec.title = bm.title;
      if (bm.description) rec.csvDescription = bm.description;
      rec.starred = bm.starred === '1';
      rec.progress = bm.progress;
      rec.sourceHash = bm.hash;
      rec.savedAtSec = bm.time;
    } catch (e) {
      return {
        bookmarkId: 0,
        status: 'failed',
        reason: `bookmarks/add: ${(e as Error).message}`,
      };
    }
    await sleep(BOOKMARKS_ADD_DELAY_MS);
    if (existingIds.has(rec.bookmarkId)) {
      // We had a row by bookmark_id even though the URL didn't match
      // (URL drift between CSV and what we synced). Skip — already
      // ingested.
      return {
        bookmarkId: rec.bookmarkId,
        status: 'skipped',
        reason: 'bookmark_id already in DB',
      };
    }
  }

  // 1. getText — Instapaper can't always generate body text (dead
  // links, image-only pages, paywalled content with no scrape
  // fallback). Error 1550 is the canonical "no text available" code.
  // Rather than skip these, we insert a placeholder row with
  // enrichment_status='no_body' so the bookmark is preserved in the
  // user's archive and won't be re-fetched on subsequent runs (the
  // bookmark_id will be in existingIds next time).
  let body: string;
  let noBody = false;
  try {
    body = await instapaperRequest('/1/bookmarks/get_text', {
      bookmark_id: String(rec.bookmarkId),
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('error_code": 1550') || msg.includes('error_code":1550')) {
      noBody = true;
      body = '';
    } else {
      return {
        bookmarkId: rec.bookmarkId,
        status: 'failed',
        reason: `getText: ${msg.slice(0, 120)}`,
      };
    }
  }
  if (!body || body.length < 20) {
    if (!noBody) {
      // Empty body without the documented 1550 — treat as no_body too.
      noBody = true;
      body = '';
    }
  }

  await sleep(GET_TEXT_DELAY_MS);

  // 2. word count + body excerpt (3000 chars matches sync.ts). When
  // we have no body, both end up empty/0 — the row still preserves
  // metadata from the OG fetch (title, image, description).
  const { wordCount, estimatedReadMin } = noBody
    ? { wordCount: 0, estimatedReadMin: 0 }
    : computeWordCount(body);
  const bodyExcerpt = noBody ? '' : htmlToText(body).slice(0, 3000);

  // 3. og fetch (best-effort — failures leave fields null)
  let og: OgResult = {
    ogImage: null,
    ogDescription: null,
    siteName: null,
    author: null,
    publishedAt: null,
    articleSection: null,
    articleTags: null,
  };
  if (rec.url) {
    og = await fetchOgMetadata(rec.url);
    await sleep(OG_FETCH_DELAY_MS);
  }

  const domain = rec.url ? extractDomain(rec.url) : null;
  const folder = rec.folder?.toLowerCase() || 'archive';
  const status =
    folder === 'unread'
      ? 'unread'
      : folder === 'starred'
        ? 'reading'
        : 'finished';
  // Date columns in reading_items are TEXT (ISO 8601), not integers.
  const savedAtIso = rec.savedAtSec
    ? new Date(rec.savedAtSec * 1000).toISOString()
    : new Date().toISOString();
  const nowIso = new Date().toISOString();

  if (dryRun) {
    console.log(
      `[DRY] would insert ${rec.bookmarkId}: ${rec.title.slice(0, 50)} (${wordCount}w, og=${og.ogImage ? 'yes' : 'no'})`
    );
    return { bookmarkId: rec.bookmarkId, status: 'inserted' };
  }

  // 4. INSERT — leave sourceHash null; live sync reconciles on next run
  // if Instapaper later returns this bookmark in any folder list.
  // enrichmentStatus='completed' since we did the full inline pass.
  // Schema reference: src/db/schema/reading.ts. No `article_section`
  // column exists; section meta tag is captured but not persisted.
  await d1Query(
    `INSERT INTO reading_items (
       user_id, item_type, source, source_id, source_hash,
       url, title, description, domain,
       status, progress, starred, folder, tags,
       saved_at, started_at, finished_at,
       content, body_excerpt, word_count, estimated_read_min,
       site_name, author, published_at, og_image_url, og_description,
       article_tags,
       enrichment_status, enrichment_error,
       created_at, updated_at
     ) VALUES (?, 'article', 'instapaper', ?, NULL,
       ?, ?, ?, ?,
       ?, ?, ?, ?, NULL,
       ?, NULL, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?,
       ?, ?,
       ?, ?)
     ON CONFLICT(source, source_id, user_id) DO UPDATE SET
       content = excluded.content,
       body_excerpt = excluded.body_excerpt,
       word_count = excluded.word_count,
       estimated_read_min = excluded.estimated_read_min,
       og_image_url = excluded.og_image_url,
       og_description = excluded.og_description,
       site_name = excluded.site_name,
       author = excluded.author,
       published_at = excluded.published_at,
       article_tags = excluded.article_tags,
       enrichment_status = 'completed',
       enrichment_error = NULL,
       updated_at = excluded.updated_at`,
    [
      1, // user_id
      String(rec.bookmarkId), // source_id
      rec.url || '',
      rec.title || '(untitled)',
      og.ogDescription, // description (Instapaper list-API gives one, but we don't have it here)
      domain,
      status,
      status === 'finished' ? 1.0 : 0.0,
      0, // starred — live sync corrects on next run
      folder,
      savedAtIso,
      status === 'finished' ? savedAtIso : null,
      body,
      bodyExcerpt,
      wordCount,
      estimatedReadMin,
      og.siteName,
      og.author,
      og.publishedAt,
      og.ogImage,
      og.ogDescription,
      og.articleTags ? JSON.stringify(og.articleTags) : null,
      noBody ? 'no_body' : 'completed',
      noBody ? 'Instapaper getText 1550: no text available' : null,
      nowIso,
      nowIso,
    ]
  );

  // 5. Highlights — fetch any highlights this bookmark has and insert
  // them. Highlights are searchable separately from the body and
  // surface in the reading-detail UI; missing them would leave the
  // ingest "complete on body, partial on annotations".
  await ingestHighlights(rec.bookmarkId);

  // No re-archive step needed — bookmarks/add was called with
  // `archived=1` for non-Unread rows, so the bookmark already
  // landed in the right folder. Saves one API call + one rate-limit
  // tick per article. Custom-folder items still flatten to Archive
  // (known limitation, ~31 articles, user can re-categorize after).

  return { bookmarkId: rec.bookmarkId, status: 'inserted' };
}

interface InstapaperHighlight {
  highlight_id: number;
  bookmark_id: number;
  text: string;
  note: string | null;
  position: number;
  time: number;
}

async function ingestHighlights(bookmarkId: number): Promise<void> {
  let highlights: InstapaperHighlight[] = [];
  try {
    const res = await instapaperRequest(
      `/1.1/bookmarks/${bookmarkId}/highlights`
    );
    highlights = JSON.parse(res) as InstapaperHighlight[];
  } catch {
    // Some bookmarks 404 the highlights endpoint; treat as "no highlights".
    return;
  }
  if (!Array.isArray(highlights) || highlights.length === 0) return;

  // Resolve the freshly-inserted reading_items row to get its primary key
  // — reading_highlights needs item_id (the autoincrement id), not the
  // Instapaper bookmark_id.
  const rows = await d1Query<{ id: number }>(
    `SELECT id FROM reading_items WHERE source = 'instapaper' AND source_id = ? AND user_id = 1 LIMIT 1`,
    [String(bookmarkId)]
  );
  const itemId = rows[0]?.id;
  if (!itemId) return;

  for (const h of highlights) {
    await d1Query(
      `INSERT INTO reading_highlights (
         user_id, item_id, source_id, text, note, position, created_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id, user_id) DO NOTHING`,
      [
        itemId,
        String(h.highlight_id),
        h.text,
        h.note,
        h.position ?? 0,
        new Date((h.time || Date.now() / 1000) * 1000).toISOString(),
      ]
    );
  }
}

// ─── post-run reembed + reindex ────────────────────────────────────

async function triggerAdmin(path: string, body = '{}'): Promise<void> {
  const res = await fetch(`${REWIND_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ENV.REWIND_ADMIN_KEY}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  if (!res.ok) {
    console.error(`  ${path} failed: ${res.status} ${await res.text()}`);
    return;
  }
  const data = (await res.json()) as Record<string, unknown>;
  console.log(`  ${path} ok: ${JSON.stringify(data).slice(0, 200)}`);
}

// ─── main ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let csv: string | null = null;
  let ids: number[] = [];
  let dryRun = false;
  let limit: number | null = null;
  let skipFollowup = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--csv') csv = args[++i];
    else if (a === '--ids')
      ids = args[++i]
        .split(',')
        .map(Number)
        .filter((n) => !Number.isNaN(n));
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--limit') limit = Number(args[++i]);
    else if (a === '--skip-followup') skipFollowup = true;
  }
  return { csv, ids, dryRun, limit, skipFollowup };
}

async function main() {
  const { csv, ids, dryRun, limit, skipFollowup } = parseArgs();
  if (!csv && !ids.length) {
    console.error(
      'Usage: --csv path | --ids id1,id2,... [--dry-run] [--limit N] [--skip-followup]'
    );
    process.exit(2);
  }

  console.log('Loading existing reading_items state from Rewind API...');
  const { ids: existingIds, urls: existingUrls } = await fetchExistingState();
  console.log(
    `  ${existingIds.size} bookmark_ids in DB, ${existingUrls.size} unique source URLs`
  );

  let records: BookmarkRecord[] = [];
  if (csv) {
    const path = resolve(csv);
    if (!existsSync(path)) throw new Error(`CSV not found: ${path}`);
    const content = readFileSync(path, 'utf-8');
    records = recordsFromCsv(content);
    console.log(`  ${records.length} parsed from CSV (${path})`);
  }
  for (const id of ids) {
    if (records.find((r) => r.bookmarkId === id)) continue;
    records.push({
      bookmarkId: id,
      url: '',
      title: '',
      folder: null,
      savedAtSec: null,
    });
  }

  // Two-stage filter: drop rows whose bookmark_id OR URL is already
  // in DB. The URL pre-filter is the big win — saves a bookmarks/add
  // call per dupe URL.
  const todo = records.filter((r) => {
    if (r.bookmarkId && existingIds.has(r.bookmarkId)) return false;
    if (r.url && existingUrls.has(normalizeUrl(r.url))) return false;
    return true;
  });
  console.log(
    `  ${todo.length} to ingest (${records.length - todo.length} already in DB)`
  );

  const work = limit ? todo.slice(0, limit) : todo;
  if (limit && todo.length > limit) {
    console.log(
      `  --limit ${limit}: processing first ${work.length} of ${todo.length}`
    );
  }

  // Concurrency=4: four articles in flight at once. Each worker pulls
  // the next index off a shared cursor and processes that article
  // sequentially (add → getText → OG → archive). Network latency
  // (~3-5s per article) is the bottleneck, not Instapaper rate
  // limits, so this gives a near-linear 4x speedup. If we start
  // seeing 429s, drop CONCURRENCY and we're back to safe pacing.
  const CONCURRENCY = 4;
  const results: IngestResult[] = [];
  let cursor = 0;
  let completed = 0;
  const start = Date.now();
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= work.length) return;
      const rec = work[idx];
      const tag = `[${idx + 1}/${work.length}]`;
      try {
        const r = await ingestBookmark(rec, existingIds, dryRun);
        results.push(r);
        completed++;
        if (completed % 25 === 0 || r.status === 'failed') {
          const rate = (completed / ((Date.now() - start) / 1000)).toFixed(2);
          process.stderr.write(
            `${tag} ${r.status} ${rec.bookmarkId || '(unresolved)'} ${rec.title.slice(0, 40)} — ${completed} done @ ${rate}/s\n`
          );
        }
      } catch (e) {
        results.push({
          bookmarkId: rec.bookmarkId,
          status: 'failed',
          reason: (e as Error).message,
        });
        completed++;
        process.stderr.write(
          `${tag} FAILED ${rec.bookmarkId} ${rec.title.slice(0, 40)}: ${(e as Error).message.slice(0, 80)}\n`
        );
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const inserted = results.filter((r) => r.status === 'inserted').length;
  const failed = results.filter((r) => r.status === 'failed');
  console.log(`\n=== Done ===`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Failed:   ${failed.length}`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed.slice(0, 30)) {
      console.log(`  ${f.bookmarkId}  ${f.reason}`);
    }
    if (failed.length > 30) console.log(`  ... + ${failed.length - 30} more`);
  }

  if (!dryRun && inserted && !skipFollowup) {
    console.log(`\nTriggering downstream enrichment...`);
    // Order matters: images first so embeddings + FTS pick up the
    // image keys; embeddings before reindex so the FTS pass sees
    // any text adjustments from embed-side normalization.
    await triggerAdmin(
      '/v1/reading/admin/backfill-images',
      JSON.stringify({ limit: Math.max(50, inserted * 2) })
    );
    await triggerAdmin('/v1/admin/reembed-reading');
    await triggerAdmin('/v1/admin/reindex-search');
  }
}

main().catch((e) => {
  console.error('backfill-from-csv failed:', e);
  process.exit(1);
});
