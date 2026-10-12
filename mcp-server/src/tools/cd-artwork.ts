import { z } from 'zod';
import type { RewindClient } from '../client.js';
export const cdArtworkSchema = z
  .object({
    album_id: z.number(),
    asset_id: z.string().regex(/^[a-f0-9]{64}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    image_url: z.string().url(),
    source_kind: z.enum(['retail', 'cover']),
    release_id: z.string().uuid().nullable(),
    medium_position: z.number().int().positive().nullable(),
    identity_type: z
      .enum(['representative_release', 'reviewed_source'])
      .optional(),
    source: z.string().url(),
    geometry: z
      .object({
        canvas: z.literal(1024),
        center: z.literal(512),
        outer_radius: z.literal(480),
        hole_radius: z.literal(60),
      })
      .passthrough(),
    alpha: z.literal('material'),
    review: z.literal('accepted'),
    thumbhash: z.string().nullable(),
    dominant_color: z.string().nullable(),
    accent_color: z.string().nullable(),
  })
  .passthrough();
export async function albumCdArtwork(client: RewindClient, albumId: number) {
  try {
    const response = await client.get<{ artwork: unknown }>(
      `/listening/cd-artwork/albums/${albumId}`,
      undefined,
      { signal: AbortSignal.timeout(1500) }
    );
    const parsed = cdArtworkSchema.safeParse(response.artwork);
    if (
      !parsed.success ||
      parsed.data.album_id !== albumId ||
      parsed.data.image_url !==
        `https://api.rewind.rest/v1/listening/cd-artwork/assets/${parsed.data.sha256}.png`
    )
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}
