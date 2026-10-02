import { z } from '@hono/zod-openapi';

export const LatelyImage = z.object({
  cdn_url: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  thumbhash: z.string().nullable(),
  dominant_color: z.string().nullable(),
  accent_color: z.string().nullable(),
});

export const LatelyMusic = z.object({
  event_id: z.string(),
  track_id: z.number().int().nullable(),
  name: z.string(),
  artist: z.string(),
  album: z.string().nullable(),
  scrobbled_at: z.string().datetime(),
  image: LatelyImage.nullable(),
});

export const LatelyMovie = z.object({
  event_id: z.string(),
  movie_id: z.number().int(),
  title: z.string(),
  year: z.number().int().nullable(),
  directors: z.array(z.string()),
  content_rating: z.string().nullable(),
  runtime_minutes: z.number().int().nullable(),
  watched_at: z.string().datetime(),
  user_rating: z.number().nullable(),
  image: LatelyImage.nullable(),
});

export const LatelySnapshot = z
  .object({
    schema_version: z.literal(1),
    version: z.number().int().positive(),
    as_of: z.string().datetime(),
    music_checked_at: z.string().datetime().nullable(),
    movie_checked_at: z.string().datetime().nullable(),
    music: LatelyMusic.nullable(),
    movie: LatelyMovie.nullable(),
  })
  .openapi('LatelySnapshot');

export type MusicCard = z.infer<typeof LatelyMusic>;
export type MovieCard = z.infer<typeof LatelyMovie>;
export type Snapshot = z.infer<typeof LatelySnapshot>;
