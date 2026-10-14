import { z } from '@hono/zod-openapi';

export const DISCMAN_ALBUM_LIMIT = 12;

export const DiscmanImage = z
  .object({
    thumbhash: z.string().nullable(),
    dominant_color: z.string().nullable(),
    accent_color: z.string().nullable(),
    urls: z.object({
      thumbnail: z.string().url().openapi({ description: '64px square' }),
      small: z.string().url().openapi({ description: '150px square' }),
      medium: z.string().url().openapi({ description: '300px square' }),
      large: z.string().url().openapi({ description: '600px square' }),
    }),
  })
  .openapi('DiscmanImage');

export const DiscmanTrack = z
  .object({
    position: z
      .number()
      .int()
      .positive()
      .openapi({ description: '1-based play order within the album' }),
    disc_number: z.number().int().positive().nullable(),
    track_number: z.number().int().positive().nullable(),
    name: z.string(),
    duration_ms: z.number().int().positive().nullable(),
    isrc: z.string().nullable(),
    apple_music_id: z.number().int().nullable(),
    apple_music_url: z.string().url().nullable(),
    preview_url: z.string().url().nullable(),
    track_id: z.number().int().nullable().openapi({
      description: 'Listening track id when this song has been played',
    }),
    play_count: z.number().int().nonnegative(),
    last_played_at: z.string().datetime().nullable(),
  })
  .openapi('DiscmanTrack');

export const DiscmanAlbum = z
  .object({
    id: z.number().int(),
    name: z.string(),
    url: z.string().nullable(),
    apple_music_id: z.number().int().nullable(),
    apple_music_url: z.string().url().nullable(),
    released_year: z.number().int().nullable(),
    total_tracks: z.number().int().nullable(),
    image: DiscmanImage.nullable(),
    artist: z.object({
      id: z.number().int(),
      name: z.string(),
      url: z.string().nullable(),
      apple_music_id: z.number().int().nullable(),
      apple_music_url: z.string().url().nullable(),
      genre: z.string().nullable(),
      image: DiscmanImage.nullable(),
    }),
    last_played_at: z.string().datetime(),
    play_count: z.number().int().nonnegative().openapi({
      description: 'All-time plays attributed to this album',
    }),
    tracklist_source: z.enum(['catalog', 'listens']).openapi({
      description:
        'catalog: the released tracklist in disc/track order. listens: only songs played from this album, in first-heard order, when no catalog tracklist is stored.',
    }),
    tracks: z.array(DiscmanTrack),
  })
  .openapi('DiscmanAlbum');

export const DiscmanSnapshot = z
  .object({
    schema_version: z.literal(1),
    built_at: z.string().datetime(),
    albums: z.array(DiscmanAlbum).max(DISCMAN_ALBUM_LIMIT),
  })
  .openapi('DiscmanSnapshot');

export type DiscmanSnapshot = z.infer<typeof DiscmanSnapshot>;
export type DiscmanAlbum = z.infer<typeof DiscmanAlbum>;
export type DiscmanTrack = z.infer<typeof DiscmanTrack>;
export type DiscmanImage = z.infer<typeof DiscmanImage>;
