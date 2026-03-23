import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { readingItems, readingHighlights } from '../db/schema/reading.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';

const testEnv = env as any;

// Helper to run raw SQL
async function dbRun(sql: string, ...params: unknown[]) {
  return testEnv.DB.prepare(sql)
    .bind(...params)
    .run();
}

describe('reading routes', () => {
  let token: string;

  beforeAll(async () => {
    await setupTestDb();
    token = await createTestApiKey({ name: 'reading-test', scope: 'admin' });
  });

  beforeEach(async () => {
    const db = drizzle(env.DB);
    await db.delete(readingHighlights);
    await db.delete(readingItems);
  });

  // ─── Seed helpers ───────────────────────────────────────────────────

  async function seedArticle(overrides: Record<string, unknown> = {}) {
    const defaults = {
      user_id: 1,
      item_type: 'article',
      source: 'instapaper',
      source_id: `src-${Date.now()}-${Math.random()}`,
      title: 'Test Article',
      author: 'Test Author',
      url: 'https://example.com/article',
      domain: 'example.com',
      site_name: 'Example',
      description: 'A test article description',
      word_count: 2000,
      estimated_read_min: 8,
      status: 'unread',
      progress: 0.0,
      starred: 0,
      folder: 'unread',
      tags: '["technology"]',
      saved_at: '2025-06-01T10:00:00.000Z',
      created_at: '2025-06-01T10:00:00.000Z',
      updated_at: '2025-06-01T10:00:00.000Z',
    };

    const row = { ...defaults, ...overrides };
    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO reading_items (${cols.join(', ')}) VALUES (${placeholders})`;
    const result = await dbRun(sql, ...Object.values(row));
    return result.meta.last_row_id;
  }

  async function seedHighlight(
    itemId: number,
    overrides: Record<string, unknown> = {}
  ) {
    const defaults = {
      user_id: 1,
      item_id: itemId,
      source_id: `hl-${Date.now()}-${Math.random()}`,
      text: 'A highlighted passage from the article.',
      note: null,
      position: 0,
      created_at: '2025-06-01T12:00:00.000Z',
    };

    const row = { ...defaults, ...overrides };
    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO reading_highlights (${cols.join(', ')}) VALUES (${placeholders})`;
    const result = await dbRun(sql, ...Object.values(row));
    return result.meta.last_row_id;
  }

  function authFetch(path: string) {
    return SELF.fetch(`http://localhost${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  // ─── GET /v1/reading/recent ─────────────────────────────────────────

  describe('GET /v1/reading/recent', () => {
    it('returns empty data when no articles exist', async () => {
      const res = await authFetch('/v1/reading/recent');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toEqual([]);
    });

    it('returns articles ordered by saved_at desc', async () => {
      await seedArticle({
        source_id: 'recent-1',
        title: 'Older Article',
        saved_at: '2025-01-01T00:00:00.000Z',
      });
      await seedArticle({
        source_id: 'recent-2',
        title: 'Newer Article',
        saved_at: '2025-06-15T00:00:00.000Z',
      });

      const res = await authFetch('/v1/reading/recent');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(2);
      expect(body.data[0].title).toBe('Newer Article');
      expect(body.data[1].title).toBe('Older Article');
    });

    it('returns correct article shape', async () => {
      await seedArticle({ source_id: 'shape-1' });

      const res = await authFetch('/v1/reading/recent');
      const body = (await res.json()) as any;
      const article = body.data[0];

      expect(article).toHaveProperty('id');
      expect(article).toHaveProperty('title');
      expect(article).toHaveProperty('author');
      expect(article).toHaveProperty('url');
      expect(article).toHaveProperty('domain');
      expect(article).toHaveProperty('site_name');
      expect(article).toHaveProperty('description');
      expect(article).toHaveProperty('word_count');
      expect(article).toHaveProperty('estimated_read_min');
      expect(article).toHaveProperty('status');
      expect(article).toHaveProperty('progress');
      expect(article).toHaveProperty('starred');
      expect(article).toHaveProperty('tags');
      expect(article).toHaveProperty('source');
      expect(article).toHaveProperty('image');
      expect(article).toHaveProperty('saved_at');
      expect(article).toHaveProperty('started_at');
      expect(article).toHaveProperty('finished_at');
      expect(typeof article.starred).toBe('boolean');
      expect(Array.isArray(article.tags)).toBe(true);
    });

    it('respects limit parameter', async () => {
      await seedArticle({ source_id: 'limit-1' });
      await seedArticle({ source_id: 'limit-2' });
      await seedArticle({ source_id: 'limit-3' });

      const res = await authFetch('/v1/reading/recent?limit=2');
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(2);
    });

    it('requires auth', async () => {
      const res = await SELF.fetch('http://localhost/v1/reading/recent');
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /v1/reading/articles ───────────────────────────────────────

  describe('GET /v1/reading/articles', () => {
    it('returns empty paginated results', async () => {
      const res = await authFetch('/v1/reading/articles');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 0,
        total_pages: 0,
      });
    });

    it('returns paginated articles', async () => {
      await seedArticle({ source_id: 'art-1', title: 'Article One' });
      await seedArticle({ source_id: 'art-2', title: 'Article Two' });
      await seedArticle({ source_id: 'art-3', title: 'Article Three' });

      const res = await authFetch('/v1/reading/articles?limit=2');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(3);
      expect(body.pagination.total_pages).toBe(2);
    });

    it('filters by status=finished', async () => {
      await seedArticle({
        source_id: 'fin-1',
        title: 'Finished Article',
        status: 'finished',
        progress: 1.0,
        finished_at: '2025-06-10T00:00:00.000Z',
      });
      await seedArticle({
        source_id: 'unr-1',
        title: 'Unread Article',
        status: 'unread',
      });

      const res = await authFetch('/v1/reading/articles?status=finished');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe('Finished Article');
      expect(body.data[0].status).toBe('finished');
      expect(body.pagination.total).toBe(1);
    });

    it('filters by domain', async () => {
      await seedArticle({
        source_id: 'dom-1',
        title: 'Atlantic Article',
        domain: 'theatlantic.com',
      });
      await seedArticle({
        source_id: 'dom-2',
        title: 'Wired Article',
        domain: 'wired.com',
      });

      const res = await authFetch(
        '/v1/reading/articles?domain=theatlantic.com'
      );
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].domain).toBe('theatlantic.com');
    });

    it('filters by starred', async () => {
      await seedArticle({
        source_id: 'star-1',
        title: 'Starred Article',
        starred: 1,
      });
      await seedArticle({
        source_id: 'star-2',
        title: 'Normal Article',
        starred: 0,
      });

      const res = await authFetch('/v1/reading/articles?starred=1');
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].starred).toBe(true);
    });

    it('supports page 2', async () => {
      await seedArticle({
        source_id: 'pg-1',
        saved_at: '2025-01-03T00:00:00.000Z',
      });
      await seedArticle({
        source_id: 'pg-2',
        saved_at: '2025-01-02T00:00:00.000Z',
      });
      await seedArticle({
        source_id: 'pg-3',
        saved_at: '2025-01-01T00:00:00.000Z',
      });

      const res = await authFetch('/v1/reading/articles?page=2&limit=2');
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.pagination.page).toBe(2);
    });
  });

  // ─── GET /v1/reading/articles/:id ───────────────────────────────────

  describe('GET /v1/reading/articles/:id', () => {
    it('returns article detail with highlights', async () => {
      const articleId = await seedArticle({
        source_id: 'detail-1',
        title: 'Detail Article',
      });

      await seedHighlight(articleId, {
        source_id: 'hl-detail-1',
        text: 'Important passage',
        note: 'My note',
        position: 1,
      });
      await seedHighlight(articleId, {
        source_id: 'hl-detail-2',
        text: 'Another passage',
        position: 2,
      });

      const res = await authFetch(`/v1/reading/articles/${articleId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.title).toBe('Detail Article');
      expect(body.highlights).toHaveLength(2);
      expect(body.highlights[0]).toHaveProperty('id');
      expect(body.highlights[0]).toHaveProperty('text');
      expect(body.highlights[0]).toHaveProperty('note');
      expect(body.highlights[0]).toHaveProperty('position');
      expect(body.highlights[0]).toHaveProperty('chapter');
      expect(body.highlights[0]).toHaveProperty('page');
      expect(body.highlights[0]).toHaveProperty('created_at');
      expect(body.highlights[0].text).toBe('Important passage');
      expect(body.highlights[0].note).toBe('My note');
    });

    it('returns article with empty highlights array', async () => {
      const articleId = await seedArticle({
        source_id: 'no-hl-1',
        title: 'No Highlights',
      });

      const res = await authFetch(`/v1/reading/articles/${articleId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.highlights).toEqual([]);
    });

    it('returns 404 for nonexistent article', async () => {
      const res = await authFetch('/v1/reading/articles/99999');
      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid id', async () => {
      const res = await authFetch('/v1/reading/articles/abc');
      expect(res.status).toBe(400);
    });
  });

  // ─── GET /v1/reading/highlights ─────────────────────────────────────

  describe('GET /v1/reading/highlights', () => {
    it('returns empty paginated highlights', async () => {
      const res = await authFetch('/v1/reading/highlights');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 0,
        total_pages: 0,
      });
    });

    it('returns highlights with article context', async () => {
      const articleId = await seedArticle({
        source_id: 'hl-ctx-1',
        title: 'Context Article',
        author: 'Context Author',
        domain: 'context.com',
        url: 'https://context.com/article',
      });
      await seedHighlight(articleId, {
        source_id: 'hl-ctx-h1',
        text: 'Highlighted text',
        note: 'A note',
      });

      const res = await authFetch('/v1/reading/highlights');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.data).toHaveLength(1);
      const highlight = body.data[0];
      expect(highlight.text).toBe('Highlighted text');
      expect(highlight.note).toBe('A note');
      expect(highlight.article).toBeDefined();
      expect(highlight.article.id).toBe(articleId);
      expect(highlight.article.title).toBe('Context Article');
      expect(highlight.article.author).toBe('Context Author');
      expect(highlight.article.domain).toBe('context.com');
      expect(highlight.article.url).toBe('https://context.com/article');
      expect(body.pagination.total).toBe(1);
    });

    it('orders highlights by created_at desc', async () => {
      const articleId = await seedArticle({ source_id: 'hl-order-1' });
      await seedHighlight(articleId, {
        source_id: 'hl-old',
        text: 'Old highlight',
        created_at: '2025-01-01T00:00:00.000Z',
      });
      await seedHighlight(articleId, {
        source_id: 'hl-new',
        text: 'New highlight',
        created_at: '2025-06-01T00:00:00.000Z',
      });

      const res = await authFetch('/v1/reading/highlights');
      const body = (await res.json()) as any;
      expect(body.data[0].text).toBe('New highlight');
      expect(body.data[1].text).toBe('Old highlight');
    });
  });

  // ─── GET /v1/reading/stats ──────────────────────────────────────────

  describe('GET /v1/reading/stats', () => {
    it('returns zeroed stats when no data', async () => {
      const res = await authFetch('/v1/reading/stats');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.total_articles).toBe(0);
      expect(body.finished_count).toBe(0);
      expect(body.currently_reading_count).toBe(0);
      expect(body.total_highlights).toBe(0);
      expect(body.total_word_count).toBe(0);
      expect(body.avg_estimated_read_min).toBe(0);
    });

    it('returns aggregate stats', async () => {
      await seedArticle({
        source_id: 'stat-1',
        status: 'finished',
        word_count: 3000,
        estimated_read_min: 12,
      });
      await seedArticle({
        source_id: 'stat-2',
        status: 'reading',
        word_count: 2000,
        estimated_read_min: 8,
      });
      await seedArticle({
        source_id: 'stat-3',
        status: 'unread',
        word_count: 1000,
        estimated_read_min: 4,
      });

      const articleId = await seedArticle({
        source_id: 'stat-4',
        status: 'finished',
        word_count: 4000,
        estimated_read_min: 16,
      });
      await seedHighlight(articleId, { source_id: 'stat-hl-1' });
      await seedHighlight(articleId, { source_id: 'stat-hl-2' });

      const res = await authFetch('/v1/reading/stats');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.total_articles).toBe(4);
      expect(body.finished_count).toBe(2);
      expect(body.currently_reading_count).toBe(1);
      expect(body.total_highlights).toBe(2);
      expect(body.total_word_count).toBe(10000);
      expect(body.avg_estimated_read_min).toBe(10);
    });
  });

  // ─── GET /v1/reading/domains ────────────────────────────────────────

  describe('GET /v1/reading/domains', () => {
    it('returns empty domain list', async () => {
      const res = await authFetch('/v1/reading/domains');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toEqual([]);
    });

    it('returns domain breakdown sorted by count', async () => {
      await seedArticle({
        source_id: 'dom-a1',
        domain: 'theatlantic.com',
      });
      await seedArticle({
        source_id: 'dom-a2',
        domain: 'theatlantic.com',
      });
      await seedArticle({
        source_id: 'dom-b1',
        domain: 'wired.com',
      });

      const res = await authFetch('/v1/reading/domains');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.data).toHaveLength(2);
      expect(body.data[0].domain).toBe('theatlantic.com');
      expect(body.data[0].count).toBe(2);
      expect(body.data[1].domain).toBe('wired.com');
      expect(body.data[1].count).toBe(1);
    });

    it('respects limit parameter', async () => {
      await seedArticle({ source_id: 'domlim-1', domain: 'a.com' });
      await seedArticle({ source_id: 'domlim-2', domain: 'b.com' });
      await seedArticle({ source_id: 'domlim-3', domain: 'c.com' });

      const res = await authFetch('/v1/reading/domains?limit=2');
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(2);
    });
  });

  // ─── GET /v1/reading/archive ────────────────────────────────────────

  describe('GET /v1/reading/archive', () => {
    it('returns only finished articles', async () => {
      await seedArticle({
        source_id: 'arch-1',
        title: 'Finished',
        status: 'finished',
        finished_at: '2025-06-10T00:00:00.000Z',
      });
      await seedArticle({
        source_id: 'arch-2',
        title: 'Unread',
        status: 'unread',
      });

      const res = await authFetch('/v1/reading/archive');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe('Finished');
      expect(body.pagination.total).toBe(1);
    });
  });

  // ─── GET /v1/reading/tags ───────────────────────────────────────────

  describe('GET /v1/reading/tags', () => {
    it('returns empty tags list', async () => {
      const res = await authFetch('/v1/reading/tags');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toEqual([]);
    });
  });

  // ─── GET /v1/reading/streaks ────────────────────────────────────────

  describe('GET /v1/reading/streaks', () => {
    it('returns zeroed streaks when no data', async () => {
      const res = await authFetch('/v1/reading/streaks');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.current.days).toBe(0);
      expect(body.current.start_date).toBeNull();
      expect(body.longest.days).toBe(0);
      expect(body.longest.start_date).toBeNull();
      expect(body.longest.end_date).toBeNull();
    });
  });

  // ─── GET /v1/reading/currently-reading ──────────────────────────────

  describe('GET /v1/reading/currently-reading', () => {
    it('returns articles with reading status', async () => {
      await seedArticle({
        source_id: 'curr-1',
        title: 'Reading Now',
        status: 'reading',
        progress: 0.3,
        progress_updated_at: '2025-06-15T00:00:00.000Z',
      });
      await seedArticle({
        source_id: 'curr-2',
        title: 'Unread',
        status: 'unread',
      });

      const res = await authFetch('/v1/reading/currently-reading');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe('Reading Now');
      expect(body.data[0].status).toBe('reading');
    });
  });

  // ─── Cache-Control headers ──────────────────────────────────────────

  describe('Cache-Control headers', () => {
    it('sets short cache for recent', async () => {
      const res = await authFetch('/v1/reading/recent');
      expect(res.headers.get('Cache-Control')).toContain('max-age=');
    });

    it('sets medium cache for articles', async () => {
      const res = await authFetch('/v1/reading/articles');
      expect(res.headers.get('Cache-Control')).toContain('max-age=');
    });

    it('sets medium cache for stats', async () => {
      const res = await authFetch('/v1/reading/stats');
      expect(res.headers.get('Cache-Control')).toContain('max-age=');
    });
  });
});
