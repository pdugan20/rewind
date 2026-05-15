/**
 * Output schemas for the reading-domain tools (issue #105).
 *
 * These schemas are the source of truth for the reading tools' return
 * shapes: `reading.ts` derives its `Article` / `Highlight` / `Related`
 * payload types from them via `z.infer`, so the declared schema and the
 * TypeScript type cannot drift.
 *
 * Every object schema uses `.passthrough()` so the JSON Schema advertised
 * to clients stays `additionalProperties`-open -- a field the Rewind API
 * adds later does not break client-side validation. See schemas/shared.ts.
 */
import { z } from 'zod';
import { imageSchema, highlightsPaginationSchema } from './shared.js';

// --- Element schemas ------------------------------------------------------

/** A saved article, as listed by get_recent_reads. */
export const articleSchema = z
  .object({
    id: z.number(),
    title: z.string(),
    author: z.string().nullable(),
    url: z.string().nullable(),
    // The list endpoint omits these keys entirely on some rows, so they
    // are optional (nullish), not merely nullable.
    instapaper_url: z.string().nullish(),
    instapaper_app_url: z.string().nullish(),
    domain: z.string().nullable(),
    description: z.string().nullish(),
    estimated_read_min: z.number().nullable(),
    status: z.string(),
    progress: z.number(),
    image: imageSchema(),
    saved_at: z.string(),
  })
  .passthrough();

/** The parent-article reference embedded in a highlight. */
const highlightArticleSchema = z
  .object({
    id: z.number().optional(),
    title: z.string(),
    author: z.string().nullable(),
    domain: z.string().nullable(),
    url: z.string().nullish(),
    instapaper_url: z.string().nullish(),
    instapaper_app_url: z.string().nullish(),
  })
  .passthrough();

/** A single highlight, as listed by get_reading_highlights / get_random_highlight. */
export const highlightSchema = z
  .object({
    text: z.string(),
    note: z.string().nullable(),
    created_at: z.string(),
    article: highlightArticleSchema,
  })
  .passthrough();

/** A related-article result from find_similar_articles. */
export const relatedArticleSchema = z
  .object({
    id: z.number(),
    title: z.string(),
    author: z.string().nullable(),
    url: z.string().nullable(),
    instapaper_url: z.string().nullable(),
    instapaper_app_url: z.string().nullable(),
    domain: z.string().nullable(),
    description: z.string().nullable(),
    score: z.number(),
  })
  .passthrough();

// --- Tool output schemas --------------------------------------------------

/**
 * outputSchema for get_recent_reads. The empty-state branch returns
 * `{ items: [] }`, which satisfies the same schema -- no union needed.
 */
export const recentReadsOutputSchema = z
  .object({ items: z.array(articleSchema) })
  .passthrough();

/**
 * outputSchema for get_reading_highlights. Both the populated and the
 * empty-state branch return `{ items, pagination }` -- the empty branch
 * just has `items: []`, so one schema covers both.
 */
export const readingHighlightsOutputSchema = z
  .object({
    items: z.array(highlightSchema),
    pagination: highlightsPaginationSchema(),
  })
  .passthrough();

/**
 * outputSchema for get_random_highlight. The tool returns the raw
 * highlight object unchanged as structuredContent.
 */
export const randomHighlightOutputSchema = highlightSchema;

/** outputSchema for get_reading_stats (flat stats object). */
export const readingStatsOutputSchema = z
  .object({
    total_articles: z.number(),
    finished_count: z.number(),
    currently_reading_count: z.number(),
    total_highlights: z.number(),
    total_word_count: z.number(),
    avg_estimated_read_min: z.number(),
  })
  .passthrough();

/**
 * outputSchema for find_similar_articles. The empty-state branch returns
 * `{ items: [] }`, which satisfies the same schema -- no union needed.
 */
export const similarArticlesOutputSchema = z
  .object({ items: z.array(relatedArticleSchema) })
  .passthrough();

/**
 * outputSchema for get_article. The tool builds a transformed, card-shaped
 * payload -- this schema describes that shape, not the raw
 * `/reading/articles/:id` API response. The full body is omitted from
 * structuredContent (it lives in the text content block); highlights are
 * capped at 5, with the true total surfaced via `highlight_count`.
 */
export const articleDetailOutputSchema = z
  .object({
    article: z
      .object({
        id: z.number(),
        title: z.string(),
        author: z.string().nullable(),
        url: z.string().nullable(),
        instapaper_url: z.string().nullable(),
        instapaper_app_url: z.string().nullable(),
        domain: z.string().nullable(),
        description: z.string().nullable(),
        word_count: z.number().nullable(),
        estimated_read_min: z.number().nullable(),
        status: z.string(),
        progress: z.number(),
        saved_at: z.string(),
        image: imageSchema(),
      })
      .passthrough(),
    highlights: z.array(
      z
        .object({
          id: z.number(),
          text: z.string(),
          note: z.string().nullable(),
          created_at: z.string(),
        })
        .passthrough()
    ),
    highlight_count: z.number(),
  })
  .passthrough();
