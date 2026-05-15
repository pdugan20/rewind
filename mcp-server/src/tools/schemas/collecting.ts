/**
 * Output schemas for the collecting-domain tools (issue #105).
 *
 * These schemas are the source of truth for the collecting tools' return
 * shapes: `collecting.ts` derives its `VinylItem` / `MediaItem` /
 * `CollectingStats` types from them via `z.infer`, so the declared schema
 * and the TypeScript type cannot drift.
 *
 * Every object schema uses `.passthrough()` so the JSON Schema advertised
 * to clients stays `additionalProperties`-open -- a field the Rewind API
 * adds later does not break client-side validation. See schemas/shared.ts.
 */
import { z } from 'zod';
import { imageSchema, paginationSchema } from './shared.js';

// --- Element schemas ------------------------------------------------------

/** A single vinyl/CD/cassette record, as listed by get_vinyl_collection. */
export const vinylItemSchema = z
  .object({
    id: z.number(),
    discogs_id: z.number(),
    title: z.string(),
    artists: z.array(z.string()),
    year: z.number().nullable(),
    format: z.string(),
    format_detail: z.string(),
    label: z.string(),
    genres: z.array(z.string()),
    styles: z.array(z.string()),
    image: imageSchema(),
    date_added: z.string().nullable(),
    rating: z.number().nullable(),
    discogs_url: z.string().nullable(),
  })
  .passthrough();

/** A single physical-media item, as listed by get_physical_media. */
export const mediaItemSchema = z
  .object({
    id: z.number(),
    title: z.string(),
    year: z.number().nullable(),
    tmdb_id: z.number().nullable(),
    imdb_id: z.string().nullable(),
    image: imageSchema(),
    runtime: z.number().nullable(),
    tmdb_rating: z.number().nullable(),
    media_type: z.string(),
    resolution: z.string().nullable(),
    hdr: z.string().nullable(),
    audio: z.string().nullable(),
    audio_channels: z.string().nullable(),
    collected_at: z.string().nullable(),
  })
  .passthrough();

// --- Tool output schemas --------------------------------------------------

/**
 * outputSchema for get_vinyl_collection. The empty-state branch returns
 * `{ items: [], pagination }`, which satisfies the same schema -- no union
 * needed.
 */
export const vinylCollectionOutputSchema = z
  .object({
    items: z.array(vinylItemSchema),
    pagination: paginationSchema(),
  })
  .passthrough();

/**
 * outputSchema for get_collecting_stats (flat stats object passed through
 * verbatim from the API). `most_collected_artist` is an open-shaped field
 * the API may fill with an artist object or leave null -- typed as
 * unknown/nullable so it never blocks validation.
 */
export const collectingStatsOutputSchema = z
  .object({
    total_items: z.number(),
    by_format: z.record(z.number()),
    wantlist_count: z.number().nullable(),
    unique_artists: z.number().nullable(),
    estimated_value: z.number().nullable(),
    top_genre: z.string().nullable(),
    oldest_release_year: z.number().nullable(),
    newest_release_year: z.number().nullable(),
    most_collected_artist: z.unknown(),
    added_this_year: z.number().nullable(),
  })
  .passthrough();

/**
 * outputSchema for get_physical_media. The empty-state branch returns
 * `{ items: [], pagination }`, which satisfies the same schema -- no union
 * needed.
 */
export const physicalMediaOutputSchema = z
  .object({
    items: z.array(mediaItemSchema),
    pagination: paginationSchema(),
  })
  .passthrough();

/**
 * outputSchema for get_physical_media_stats. The tool builds a transformed
 * payload -- `total` is computed from the per-format counts, `formats` is
 * the raw API list.
 */
export const physicalMediaStatsOutputSchema = z
  .object({
    total: z.number(),
    formats: z.array(
      z.object({ name: z.string(), count: z.number() }).passthrough()
    ),
  })
  .passthrough();
