/**
 * Output schemas for the listening-domain tools (issue #105, Phase 1).
 *
 * These schemas are the source of truth for the listening tools' return
 * shapes: `listening.ts` derives its `Scrobble` / `TopItem` / `NowPlaying`
 * / `AlbumDetail` types from them via `z.infer`, so the declared schema
 * and the TypeScript type cannot drift.
 *
 * Every object schema uses `.passthrough()` so the JSON Schema advertised
 * to clients stays `additionalProperties`-open -- a field the Rewind API
 * adds later does not break client-side validation. See schemas/shared.ts.
 */
import { z } from 'zod';
import { imageSchema } from './shared.js';

// --- Element schemas ------------------------------------------------------

/** A single scrobble, as listed by get_recent_listens. */
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
        image: imageSchema(),
      })
      .passthrough(),
    scrobbled_at: z.string(),
  })
  .passthrough();

/** A ranked entry in a get_top_artists / get_top_albums / get_top_tracks list. */
export const topItemSchema = z
  .object({
    rank: z.number(),
    id: z.number(),
    name: z.string(),
    detail: z.string(),
    playcount: z.number(),
    image: imageSchema(),
    url: z.string(),
    apple_music_url: z.string().nullable(),
    preview_url: z.string().nullish(),
    sparkline: z
      .object({
        granularity: z.enum(['day', 'week']),
        points: z.array(z.number()),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** The `track` payload inside get_now_playing (null when nothing is playing). */
const nowPlayingTrackSchema = z
  .object({
    name: z.string(),
    artist: z
      .object({
        id: z.number().nullable(),
        name: z.string(),
        apple_music_url: z.string().nullable(),
      })
      .passthrough(),
    album: z
      .object({
        id: z.number().nullable(),
        name: z.string().nullable(),
        image: imageSchema(),
      })
      .passthrough(),
    url: z.string().nullable(),
    apple_music_url: z.string().nullable(),
    preview_url: z.string().nullable(),
  })
  .passthrough();

// --- Tool output schemas --------------------------------------------------

/** outputSchema for get_now_playing. */
export const nowPlayingOutputSchema = z
  .object({
    is_playing: z.boolean(),
    track: nowPlayingTrackSchema.nullable(),
    scrobbled_at: z.string().nullable(),
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

/** outputSchema for get_top_artists and get_top_albums (same shape). */
export const topListOutputSchema = z
  .object({
    period: z.string(),
    data: z.array(topItemSchema),
  })
  .passthrough();

/** outputSchema for get_top_tracks (adds the artist_id filter context). */
export const topTracksOutputSchema = z
  .object({
    period: z.string(),
    artist_id: z.number().nullable(),
    data: z.array(topItemSchema),
  })
  .passthrough();

/** outputSchema for get_listening_streaks. */
export const listeningStreaksOutputSchema = z
  .object({
    current: z
      .object({
        days: z.number(),
        start_date: z.string().nullable(),
        total_scrobbles: z.number(),
      })
      .passthrough(),
    longest: z
      .object({
        days: z.number(),
        start_date: z.string().nullable(),
        end_date: z.string().nullable(),
        total_scrobbles: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

/** outputSchema for get_album_details. */
export const albumDetailsOutputSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    mbid: z.string().nullable(),
    url: z.string().nullable(),
    apple_music_url: z.string().nullable(),
    playcount: z.number(),
    image: imageSchema(),
    artist: z.object({ id: z.number(), name: z.string() }).passthrough(),
    tracks: z.array(
      z
        .object({
          id: z.number(),
          name: z.string(),
          scrobble_count: z.number(),
          apple_music_url: z.string().nullable(),
          preview_url: z.string().nullable(),
        })
        .passthrough()
    ),
  })
  .passthrough();

/** outputSchema for get_listening_genres (one row per grouped period). */
const genrePeriodSchema = z
  .object({
    period: z.string(),
    genres: z.record(z.number()),
    total: z.number(),
  })
  .passthrough();

export const listeningGenresOutputSchema = z
  .object({
    items: z.array(genrePeriodSchema),
    group_by: z.string(),
  })
  .passthrough();

/**
 * outputSchema for get_artist_details. The tool builds a transformed,
 * card-shaped payload -- this schema describes that shape, not the raw
 * `/listening/artists/:id` API response.
 */
export const artistDetailsOutputSchema = z
  .object({
    artist: z
      .object({
        id: z.number(),
        name: z.string(),
        mbid: z.string().nullable(),
        url: z.string().nullable(),
        apple_music_url: z.string().nullable(),
        apple_music_id: z.string().nullable(),
        genre: z.string().nullable(),
        tags: z.array(z.string()),
        bio_summary: z.string().nullable(),
        bio_content: z.string().nullable(),
        image: imageSchema(),
      })
      .passthrough(),
    listening_stats: z
      .object({
        total_scrobbles: z.number(),
        first_scrobble_at: z.string().nullable(),
        last_played_at: z.string().nullable(),
        all_time_rank: z.number().nullable(),
        distinct_tracks: z.number(),
        distinct_albums: z.number(),
      })
      .passthrough(),
    sparkline: z
      .object({
        granularity: z.enum(['day', 'week', 'month', 'year']),
        points: z.array(
          z.object({ at: z.string(), count: z.number() }).passthrough()
        ),
      })
      .passthrough()
      .nullable(),
    top_tracks: z.array(
      z
        .object({
          rank: z.number(),
          id: z.number(),
          name: z.string(),
          album_id: z.number().nullable(),
          album_name: z.string().nullable(),
          scrobble_count: z.number(),
          apple_music_url: z.string().nullable(),
          preview_url: z.string().nullable(),
          image: imageSchema(),
        })
        .passthrough()
    ),
    top_albums: z.array(
      z
        .object({
          rank: z.number(),
          id: z.number(),
          name: z.string(),
          playcount: z.number(),
          apple_music_url: z.string().nullable(),
          image: imageSchema(),
        })
        .passthrough()
    ),
    similar_artists: z.array(
      z
        .object({
          id: z.number(),
          name: z.string(),
          your_scrobble_count: z.number(),
          similarity_score: z.number(),
          image: imageSchema(),
        })
        .passthrough()
    ),
  })
  .passthrough();
