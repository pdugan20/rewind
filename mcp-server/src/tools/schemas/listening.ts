/**
 * Output schemas for the listening-domain tools.
 *
 * Spike stage (issue #105): only the two tools in the spike are covered
 * -- get_recent_listens and get_listening_stats. The remaining listening
 * tools are filled in during Phase 1.
 *
 * Schemas are the source of truth: where a tool file currently hand-
 * writes a matching `type`, that type can later become
 * `z.infer<typeof ...Schema>` to remove the duplication.
 *
 * Object schemas use `.passthrough()` -- see schemas/shared.ts.
 */
import { z } from 'zod';
import { imageSchema } from './shared.js';

/** A single scrobble as returned in the get_recent_listens list. */
export const scrobbleSchema = z
  .object({
    track: z
      .object({
        id: z.number(),
        name: z.string(),
        url: z.string().nullable(),
        apple_music_url: z.string().nullable(),
        preview_url: z.string().nullable(),
      })
      .passthrough(),
    artist: z.object({ id: z.number(), name: z.string() }).passthrough(),
    album: z
      .object({
        id: z.number().nullable(),
        name: z.string().nullable(),
        image: imageSchema,
      })
      .passthrough(),
    scrobbled_at: z.string(),
  })
  .passthrough();

/**
 * outputSchema for get_recent_listens. The empty-state branch returns
 * `{ items: [] }`, which satisfies the same schema -- no union needed.
 */
export const recentListensOutputSchema = z
  .object({ items: z.array(scrobbleSchema) })
  .passthrough();

/** outputSchema for get_listening_stats (flat stats object). */
export const listeningStatsOutputSchema = z
  .object({
    total_scrobbles: z.number(),
    unique_artists: z.number(),
    unique_albums: z.number(),
    unique_tracks: z.number(),
    registered_date: z.string().nullable(),
    years_tracking: z.number(),
    scrobbles_per_day: z.number(),
  })
  .passthrough();
