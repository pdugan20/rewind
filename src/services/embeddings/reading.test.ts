import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  composeArticleText,
  vectorIdForArticle,
  embedArticles,
  type ArticleForEmbedding,
} from './reading.js';
import type { Env } from '../../types/env.js';

function article(over: Partial<ArticleForEmbedding> = {}): ArticleForEmbedding {
  return {
    id: 1,
    title: 'Title',
    description: 'Description.',
    bodyExcerpt: 'Body.',
    status: 'unread',
    savedAt: '2026-04-01T00:00:00.000Z',
    domain: 'example.com',
    ...over,
  };
}

describe('composeArticleText', () => {
  it('joins non-null fields', () => {
    expect(
      composeArticleText(
        article({ title: 'T', description: 'D', bodyExcerpt: 'B' })
      )
    ).toBe('T\n\nD\n\nB');
  });

  it('omits null fields', () => {
    expect(
      composeArticleText(
        article({ title: 'T', description: null, bodyExcerpt: null })
      )
    ).toBe('T');
  });

  it('returns empty when all fields are null/blank', () => {
    expect(
      composeArticleText(
        article({ title: null, description: '   ', bodyExcerpt: null })
      )
    ).toBe('');
  });

  it('truncates at the char cap', () => {
    const big = 'x'.repeat(15000);
    expect(composeArticleText(article({ title: big })).length).toBe(12000);
  });
});

describe('vectorIdForArticle', () => {
  it('uses the reading:article: namespace', () => {
    expect(vectorIdForArticle(42)).toBe('reading:article:42');
  });
});

describe('embedArticles', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockEnv(): Env {
    const upsert = vi.fn().mockResolvedValue({ mutationId: 'test' });
    const deleteByIds = vi.fn().mockResolvedValue({});
    return {
      VECTORIZE_READING: {
        upsert,
        deleteByIds,
        query: vi.fn(),
      } as unknown as VectorizeIndex,
      VOYAGE_API_KEY: 'test-key',
    } as unknown as Env;
  }

  it('skips articles whose composed text is empty', async () => {
    const env = mockEnv();
    const result = await embedArticles(env, [
      article({ id: 1, title: null, description: null, bodyExcerpt: null }),
    ]);
    expect(result).toEqual({ embedded: 0, skipped: 1, tokens: 0 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(
      env.VECTORIZE_READING.upsert as ReturnType<typeof vi.fn>
    ).not.toHaveBeenCalled();
  });

  it('calls Voyage with document input type and upserts vectors', async () => {
    const env = mockEnv();
    const vec = new Array(512).fill(0.1);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ embedding: vec, index: 0 }],
          model: 'voyage-3-lite',
          usage: { total_tokens: 5 },
        }),
        { status: 200 }
      )
    );

    const result = await embedArticles(env, [
      article({ id: 7, title: 'Hello', description: null, bodyExcerpt: null }),
    ]);

    expect(result).toEqual({ embedded: 1, skipped: 0, tokens: 5 });

    const fetchArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const body = JSON.parse(fetchArgs[1].body as string);
    expect(body.input_type).toBe('document');
    expect(body.model).toBe('voyage-3-lite');
    expect(body.input).toEqual(['Hello']);

    const upsertCall = (
      env.VECTORIZE_READING.upsert as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(upsertCall).toHaveLength(1);
    expect(upsertCall[0].id).toBe('reading:article:7');
    expect(upsertCall[0].values).toEqual(vec);
    expect(upsertCall[0].metadata.article_id).toBe(7);
    expect(upsertCall[0].metadata.status).toBe('unread');
    expect(upsertCall[0].metadata.domain).toBe('example.com');
    expect(typeof upsertCall[0].metadata.saved_at).toBe('number');
  });

  it('throws on non-2xx Voyage response', async () => {
    const env = mockEnv();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('bad token', { status: 401 })
    );
    await expect(embedArticles(env, [article({ id: 1 })])).rejects.toThrow(
      /Voyage API 401/
    );
  });
});
