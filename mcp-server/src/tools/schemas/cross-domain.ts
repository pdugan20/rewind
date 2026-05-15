/**
 * Output schemas for the cross-domain tools (issue #105).
 *
 * These schemas are the source of truth for the cross-domain tools'
 * return shapes: `cross-domain.ts` derives its `SearchResult` /
 * `FeedItem` / `OnThisDay` types from them via `z.infer`, so the
 * declared schema and the TypeScript type cannot drift.
 *
 * Every object schema uses `.passthrough()` so the JSON Schema advertised
 * to clients stays `additionalProperties`-open -- a field the Rewind API
 * adds later does not break client-side validation. See schemas/shared.ts.
 */
import { z } from 'zod';
import {
  imageSchema,
  searchPaginationSchema,
  feedPaginationSchema,
} from './shared.js';

// --- Element schemas ------------------------------------------------------

/**
 * A single cross-domain search result, as listed by `search` and
 * `semantic_search`. The item mixes entries from every domain, so the
 * domain-specific URL fields (`url`, `instapaper_url`, etc.) are all
 * optional. `score` is present on semantic / hybrid results, optional on
 * keyword results.
 */
export const searchResultSchema = z
  .object({
    domain: z.string(),
    entity_type: z.string(),
    entity_id: z.string(),
    title: z.string(),
    subtitle: z.string().nullable(),
    image: imageSchema().optional(),
    url: z.string().nullish(),
    instapaper_url: z.string().nullish(),
    instapaper_app_url: z.string().nullish(),
    author: z.string().nullish(),
    score: z.number().optional(),
  })
  .passthrough();

/** A single entry in the unified activity feed, as listed by `get_feed`. */
export const feedItemSchema = z
  .object({
    domain: z.string(),
    event_type: z.string(),
    occurred_at: z.string(),
    title: z.string(),
    subtitle: z.string().nullable(),
  })
  .passthrough();

/** A single item inside an `get_on_this_day` year group. */
const onThisDayItemSchema = z
  .object({
    domain: z.string(),
    event_type: z.string(),
    title: z.string(),
    subtitle: z.string().nullable(),
  })
  .passthrough();

/** One year's worth of items inside an `get_on_this_day` response. */
const onThisDayYearSchema = z
  .object({
    year: z.number(),
    items: z.array(onThisDayItemSchema),
  })
  .passthrough();

// --- Tool output schemas --------------------------------------------------

/**
 * outputSchema for `search`. The empty-state branch returns
 * `{ items: [], pagination }`, which satisfies the same schema -- no
 * union needed.
 */
export const searchOutputSchema = z
  .object({
    items: z.array(searchResultSchema),
    pagination: searchPaginationSchema(),
  })
  .passthrough();

/**
 * outputSchema for `semantic_search`. Same shape as `search` -- both
 * return `{ items, pagination }` with cross-domain result items.
 */
export const semanticSearchOutputSchema = z
  .object({
    items: z.array(searchResultSchema),
    pagination: searchPaginationSchema(),
  })
  .passthrough();

/**
 * outputSchema for `get_feed`. The empty-state branch returns
 * `{ items: [], pagination }`, which satisfies the same schema.
 */
export const feedOutputSchema = z
  .object({
    items: z.array(feedItemSchema),
    pagination: feedPaginationSchema(),
  })
  .passthrough();

/**
 * outputSchema for `get_on_this_day`. The empty-state branch returns the
 * same `{ month, day, years: [] }` shape with an empty `years` array.
 */
export const onThisDayOutputSchema = z
  .object({
    month: z.number(),
    day: z.number(),
    years: z.array(onThisDayYearSchema),
  })
  .passthrough();
