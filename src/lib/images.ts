/**
 * Shared image attachment utility.
 * Centralizes image metadata lookups for all domain route handlers,
 * replacing duplicate getImageMeta/getImageMetaBatch helpers.
 */

import { eq, and, inArray } from 'drizzle-orm';
import type { createDb } from '../db/client.js';
import { images } from '../db/schema/system.js';
import { buildCdnUrl } from '../services/images/presets.js';

type Database = ReturnType<typeof createDb>;

export interface ImageAttachment {
  cdn_url: string;
  thumbhash: string | null;
  dominant_color: string | null;
  accent_color: string | null;
}

/**
 * Look up image metadata for a single entity.
 * Returns a standardized ImageAttachment or null if no image exists.
 */
export async function getImageAttachment(
  db: Database,
  domain: string,
  entityType: string,
  entityId: string,
  size = 'medium'
): Promise<ImageAttachment | null> {
  const [row] = await db
    .select({
      r2Key: images.r2Key,
      thumbhash: images.thumbhash,
      dominantColor: images.dominantColor,
      accentColor: images.accentColor,
      imageVersion: images.imageVersion,
    })
    .from(images)
    .where(
      and(
        eq(images.domain, domain),
        eq(images.entityType, entityType),
        eq(images.entityId, entityId)
      )
    )
    .limit(1);

  if (!row || !row.r2Key) return null;

  return {
    cdn_url: buildCdnUrl(row.r2Key, size, row.imageVersion),
    thumbhash: row.thumbhash,
    dominant_color: row.dominantColor,
    accent_color: row.accentColor,
  };
}

/**
 * Look up image metadata for multiple entities in a single query.
 * Returns a map of entityId -> ImageAttachment.
 */
export async function getImageAttachmentBatch(
  db: Database,
  domain: string,
  entityType: string,
  entityIds: string[],
  size = 'medium'
): Promise<Map<string, ImageAttachment>> {
  if (entityIds.length === 0) return new Map();

  const rows = await db
    .select({
      entityId: images.entityId,
      r2Key: images.r2Key,
      thumbhash: images.thumbhash,
      dominantColor: images.dominantColor,
      accentColor: images.accentColor,
      imageVersion: images.imageVersion,
    })
    .from(images)
    .where(
      and(
        eq(images.domain, domain),
        eq(images.entityType, entityType),
        inArray(images.entityId, entityIds)
      )
    );

  const map = new Map<string, ImageAttachment>();
  for (const row of rows) {
    if (!row.r2Key) continue;
    map.set(row.entityId, {
      cdn_url: buildCdnUrl(row.r2Key, size, row.imageVersion),
      thumbhash: row.thumbhash,
      dominant_color: row.dominantColor,
      accent_color: row.accentColor,
    });
  }
  return map;
}
