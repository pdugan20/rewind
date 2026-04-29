/**
 * Embed reading_items into Vectorize for semantic search + related-articles.
 *
 * What we embed: title + description + body_excerpt, truncated at ~3500
 * chars before the Voyage call (voyage-3-lite has a 16K token budget,
 * but shorter inputs are faster, cheaper, and retrieval-equivalent here).
 *
 * Vectorize id scheme: `reading:article:{id}`. Matches the search entity
 * id so one lookup table (`reading_items`) resolves both FTS and vector
 * hits.
 */

import { embedWithVoyage, type VoyageInputType } from './voyage.js';

/** Minimal subset of Env the embeddings module actually touches. */
export interface EmbeddingEnv {
  VOYAGE_API_KEY: string;
  VECTORIZE_READING: VectorizeIndex;
}

const MAX_INPUT_CHARS = 12000;

export interface ArticleForEmbedding {
  id: number;
  title: string | null;
  description: string | null;
  bodyExcerpt: string | null;
  status: string;
  savedAt: string;
  domain: string | null;
}

export function vectorIdForArticle(id: number): string {
  return `reading:article:${id}`;
}

/** Compose the text we embed for a single article. Null-safe. */
export function composeArticleText(a: ArticleForEmbedding): string {
  const parts = [a.title, a.description, a.bodyExcerpt].filter(
    (s): s is string => !!s && s.trim().length > 0
  );
  const joined = parts.join('\n\n');
  return joined.length > MAX_INPUT_CHARS
    ? joined.slice(0, MAX_INPUT_CHARS)
    : joined;
}

function metadataFor(a: ArticleForEmbedding): Record<string, string | number> {
  const savedAtUnix = Math.floor(new Date(a.savedAt).getTime() / 1000);
  return {
    article_id: a.id,
    saved_at: isFinite(savedAtUnix) ? savedAtUnix : 0,
    status: a.status,
    domain: a.domain ?? '',
  };
}

/**
 * Embed a batch of articles and upsert to Vectorize. Batches are sized
 * by the caller; Voyage accepts up to 1000 inputs or 120K tokens per
 * call, but ~10 is a good sweet spot to keep any single request under
 * a few seconds.
 *
 * Articles whose composed text is empty are skipped (no vector ingested).
 */
export async function embedArticles(
  env: EmbeddingEnv,
  articles: ArticleForEmbedding[]
): Promise<{ embedded: number; skipped: number; tokens: number }> {
  const eligible = articles
    .map((a) => ({ a, text: composeArticleText(a) }))
    .filter((x) => x.text.length > 0);

  if (eligible.length === 0) {
    return { embedded: 0, skipped: articles.length, tokens: 0 };
  }

  const { vectors, tokens } = await embedWithVoyage(
    env.VOYAGE_API_KEY,
    eligible.map((x) => x.text),
    { model: 'voyage-3-lite', inputType: 'document' }
  );

  const toUpsert = vectors.map((values, i) => ({
    id: vectorIdForArticle(eligible[i].a.id),
    values,
    metadata: metadataFor(eligible[i].a),
  }));

  await env.VECTORIZE_READING.upsert(toUpsert);

  return {
    embedded: vectors.length,
    skipped: articles.length - eligible.length,
    tokens,
  };
}

/** Delete a single article's vector. Called when an article is removed. */
export async function deleteArticleVector(
  env: EmbeddingEnv,
  id: number
): Promise<void> {
  await env.VECTORIZE_READING.deleteByIds([vectorIdForArticle(id)]);
}

/**
 * Embed a single query string (note: use 'query' input type, not 'document').
 * Returned as a single 512-dim vector.
 */
export async function embedQuery(
  env: EmbeddingEnv,
  query: string,
  inputType: VoyageInputType = 'query'
): Promise<number[]> {
  const { vectors } = await embedWithVoyage(
    env.VOYAGE_API_KEY,
    [query.slice(0, MAX_INPUT_CHARS)],
    { model: 'voyage-3-lite', inputType }
  );
  return vectors[0];
}
