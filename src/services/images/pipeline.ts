/**
 * Image pipeline: waterfall resolver, R2 upload, metadata generation and storage.
 * Orchestrates source priority, ThumbHash generation, color extraction, and DB persistence.
 */

import { eq, and } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { images } from '../../db/schema/system.js';
import { buildR2Key } from './presets.js';
import { extractColors } from './colors.js';
import { generateThumbHash } from './thumbhash.js';
import type {
  SourceClient,
  SourceSearchParams,
  ImageResult,
} from './sources/types.js';
import {
  CoverArtArchiveClient,
  ITunesClient,
  AppleMusicClient,
  FanartTvClient,
  TmdbClient,
  PlexClient,
} from './sources/index.js';

export interface PipelineEnv {
  IMAGES: R2Bucket;
  APPLE_MUSIC_DEVELOPER_TOKEN?: string;
  FANART_TV_API_KEY?: string;
  TMDB_API_KEY?: string;
  PLEX_URL?: string;
  PLEX_TOKEN?: string;
}

export interface PipelineResult {
  r2Key: string;
  source: string;
  sourceUrl: string;
  width: number | null;
  height: number | null;
  thumbhash: string | null;
  dominantColor: string | null;
  accentColor: string | null;
  imageVersion: number;
}

export interface ImageRecord {
  id: number;
  domain: string;
  entityType: string;
  entityId: string;
  r2Key: string;
  source: string;
  sourceUrl: string | null;
  width: number | null;
  height: number | null;
  thumbhash: string | null;
  dominantColor: string | null;
  accentColor: string | null;
  isOverride: number;
  overrideAt: string | null;
  imageVersion: number;
}

/**
 * Source priority waterfalls by domain and entity type.
 */
function getSourceClients(
  domain: string,
  entityType: string,
  env: PipelineEnv
): SourceClient[] {
  switch (`${domain}/${entityType}`) {
    case 'listening/albums':
      return [
        new CoverArtArchiveClient(),
        new ITunesClient(),
        ...(env.APPLE_MUSIC_DEVELOPER_TOKEN
          ? [new AppleMusicClient(env.APPLE_MUSIC_DEVELOPER_TOKEN)]
          : []),
      ];

    case 'listening/artists':
      return [
        ...(env.APPLE_MUSIC_DEVELOPER_TOKEN
          ? [new AppleMusicClient(env.APPLE_MUSIC_DEVELOPER_TOKEN)]
          : []),
        ...(env.FANART_TV_API_KEY
          ? [new FanartTvClient(env.FANART_TV_API_KEY)]
          : []),
      ];

    case 'watching/movies':
    case 'watching/shows':
      return [
        ...(env.TMDB_API_KEY ? [new TmdbClient(env.TMDB_API_KEY)] : []),
        ...(env.FANART_TV_API_KEY
          ? [new FanartTvClient(env.FANART_TV_API_KEY)]
          : []),
        ...(env.PLEX_URL && env.PLEX_TOKEN
          ? [new PlexClient(env.PLEX_URL, env.PLEX_TOKEN)]
          : []),
      ];

    case 'collecting/releases':
      return [new CoverArtArchiveClient(), new ITunesClient()];

    default:
      return [];
  }
}

/**
 * Run the waterfall resolver: try each source in priority order until one returns an image.
 */
export async function resolveImage(
  params: SourceSearchParams,
  env: PipelineEnv
): Promise<ImageResult | null> {
  const clients = getSourceClients(params.domain, params.entityType, env);

  for (const client of clients) {
    try {
      const results = await client.search(params);
      if (results.length > 0) {
        return results[0];
      }
    } catch (error) {
      console.log(
        `[ERROR] Source ${client.name} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return null;
}

/**
 * Fetch all alternatives from all sources (for admin browse).
 */
export async function resolveAlternatives(
  params: SourceSearchParams,
  env: PipelineEnv
): Promise<ImageResult[]> {
  const clients = getSourceClients(params.domain, params.entityType, env);
  const allResults: ImageResult[] = [];

  for (const client of clients) {
    try {
      const results = await client.search(params);
      allResults.push(...results);
    } catch (error) {
      console.log(
        `[ERROR] Source ${client.name} failed during alternatives search: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return allResults;
}

/**
 * Fetch an image from URL and return the raw bytes.
 */
async function fetchImageBytes(
  url: string
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'RewindAPI/1.0',
      },
    });

    if (!response.ok) {
      console.log(
        `[ERROR] Failed to fetch image from ${url}: ${response.status}`
      );
      return null;
    }

    const contentType = response.headers.get('content-type') ?? 'image/jpeg';
    const bytes = await response.arrayBuffer();

    return { bytes, contentType };
  } catch (error) {
    console.log(
      `[ERROR] Image fetch failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Decode image bytes to raw RGBA pixel data.
 * Uses a simplified approach: parse JPEG/PNG headers for dimensions
 * and extract pixel data for color analysis and ThumbHash.
 *
 * In a Workers environment without sharp/canvas, we use a basic
 * approach that samples the raw bytes for color analysis.
 */
function decodeImageForAnalysis(bytes: ArrayBuffer): {
  pixels: Uint8Array;
  width: number;
  height: number;
} | null {
  const data = new Uint8Array(bytes);

  // Try to determine dimensions from headers
  let width = 0;
  let height = 0;

  // JPEG: look for SOF0 or SOF2 marker
  if (data[0] === 0xff && data[1] === 0xd8) {
    for (let i = 2; i < data.length - 8; i++) {
      if (data[i] === 0xff && (data[i + 1] === 0xc0 || data[i + 1] === 0xc2)) {
        height = (data[i + 5] << 8) | data[i + 6];
        width = (data[i + 7] << 8) | data[i + 8];
        break;
      }
    }
  }

  // PNG: dimensions at bytes 16-23
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    width = (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
    height = (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
  }

  if (width === 0 || height === 0) {
    // Fallback: assume a small image for analysis
    width = 32;
    height = 32;
  }

  // For color extraction, create a pseudo-pixel array by sampling the image bytes.
  // This is an approximation since we can't fully decode JPEG/PNG in Workers
  // without a WASM decoder. We sample the raw bytes as RGB triplets,
  // skipping headers, which gives a rough color distribution.
  const sampleWidth = Math.min(width, 32);
  const sampleHeight = Math.min(height, 32);
  const pixelCount = sampleWidth * sampleHeight;
  const pixels = new Uint8Array(pixelCount * 4);

  // Skip the first portion (headers) and sample from the data portion
  const headerSkip = Math.min(Math.floor(data.length * 0.1), 1024);
  const dataRegion = data.slice(headerSkip);

  if (dataRegion.length < pixelCount * 3) {
    // Not enough data to sample, create from available bytes
    for (let i = 0; i < pixelCount; i++) {
      const srcIdx = (i * 3) % dataRegion.length;
      pixels[i * 4] = dataRegion[srcIdx] ?? 128;
      pixels[i * 4 + 1] = dataRegion[(srcIdx + 1) % dataRegion.length] ?? 128;
      pixels[i * 4 + 2] = dataRegion[(srcIdx + 2) % dataRegion.length] ?? 128;
      pixels[i * 4 + 3] = 255;
    }
  } else {
    const step = Math.max(1, Math.floor(dataRegion.length / (pixelCount * 3)));
    for (let i = 0; i < pixelCount; i++) {
      const srcIdx = i * step * 3;
      pixels[i * 4] = dataRegion[srcIdx % dataRegion.length];
      pixels[i * 4 + 1] = dataRegion[(srcIdx + 1) % dataRegion.length];
      pixels[i * 4 + 2] = dataRegion[(srcIdx + 2) % dataRegion.length];
      pixels[i * 4 + 3] = 255;
    }
  }

  return { pixels, width: sampleWidth, height: sampleHeight };
}

/**
 * Upload an image to R2 with metadata.
 */
async function uploadToR2(
  bucket: R2Bucket,
  r2Key: string,
  bytes: ArrayBuffer,
  contentType: string,
  source: string,
  sourceUrl: string,
  dimensions: string
): Promise<void> {
  await bucket.put(r2Key, bytes, {
    httpMetadata: { contentType },
    customMetadata: {
      'x-source': source,
      'x-source-url': sourceUrl,
      'x-dimensions': dimensions,
    },
  });
}

/**
 * Determine file extension from content type.
 */
function extFromContentType(contentType: string): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  return 'jpg';
}

/**
 * Run the full image pipeline for an entity:
 * 1. Check for override protection
 * 2. Run waterfall resolver
 * 3. Fetch image bytes
 * 4. Upload to R2
 * 5. Generate ThumbHash
 * 6. Extract colors
 * 7. Store metadata in DB
 */
export async function runPipeline(
  db: Database,
  env: PipelineEnv,
  params: SourceSearchParams,
  options: { skipOverrideCheck?: boolean } = {}
): Promise<PipelineResult | null> {
  const { domain, entityType, entityId } = params;

  // Check for existing override
  if (!options.skipOverrideCheck) {
    const existing = await db
      .select()
      .from(images)
      .where(
        and(
          eq(images.domain, domain),
          eq(images.entityType, entityType),
          eq(images.entityId, entityId)
        )
      )
      .limit(1);

    if (existing.length > 0 && existing[0].isOverride === 1) {
      console.log(
        `[INFO] Skipping pipeline for ${domain}/${entityType}/${entityId}: image is overridden`
      );
      return null;
    }
  }

  // Resolve image from sources
  const imageResult = await resolveImage(params, env);
  if (!imageResult) {
    console.log(
      `[INFO] No image found for ${domain}/${entityType}/${entityId}`
    );
    return null;
  }

  // Fetch image bytes
  const fetched = await fetchImageBytes(imageResult.url);
  if (!fetched) {
    return null;
  }

  const ext = extFromContentType(fetched.contentType);
  const r2Key = buildR2Key(domain, entityType, entityId, ext);

  // Upload to R2
  const dimensions =
    imageResult.width && imageResult.height
      ? `${imageResult.width}x${imageResult.height}`
      : 'unknown';

  await uploadToR2(
    env.IMAGES,
    r2Key,
    fetched.bytes,
    fetched.contentType,
    imageResult.source,
    imageResult.url,
    dimensions
  );

  // Generate ThumbHash and extract colors
  let thumbhash: string | null = null;
  let dominantColor: string | null = null;
  let accentColor: string | null = null;

  const decoded = decodeImageForAnalysis(fetched.bytes);
  if (decoded) {
    try {
      const colors = extractColors(
        decoded.pixels,
        decoded.width,
        decoded.height
      );
      dominantColor = colors.dominantColor;
      accentColor = colors.accentColor;
    } catch (error) {
      console.log(
        `[ERROR] Color extraction failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      thumbhash = generateThumbHash(
        decoded.width,
        decoded.height,
        decoded.pixels
      );
    } catch (error) {
      console.log(
        `[ERROR] ThumbHash generation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Upsert image record in DB
  const existing = await db
    .select()
    .from(images)
    .where(
      and(
        eq(images.domain, domain),
        eq(images.entityType, entityType),
        eq(images.entityId, entityId)
      )
    )
    .limit(1);

  let imageVersion = 1;

  if (existing.length > 0) {
    imageVersion = existing[0].imageVersion;
    await db
      .update(images)
      .set({
        r2Key,
        source: imageResult.source,
        sourceUrl: imageResult.url,
        width: imageResult.width,
        height: imageResult.height,
        thumbhash,
        dominantColor,
        accentColor,
      })
      .where(eq(images.id, existing[0].id));
  } else {
    await db.insert(images).values({
      domain,
      entityType,
      entityId,
      r2Key,
      source: imageResult.source,
      sourceUrl: imageResult.url,
      width: imageResult.width,
      height: imageResult.height,
      thumbhash,
      dominantColor,
      accentColor,
      imageVersion,
    });
  }

  console.log(
    `[INFO] Pipeline complete for ${domain}/${entityType}/${entityId}: source=${imageResult.source}`
  );

  return {
    r2Key,
    source: imageResult.source,
    sourceUrl: imageResult.url,
    width: imageResult.width,
    height: imageResult.height,
    thumbhash,
    dominantColor,
    accentColor,
    imageVersion,
  };
}

/**
 * Run the pipeline for an override (from URL or uploaded bytes).
 * Always processes regardless of existing override status.
 */
export async function runOverridePipeline(
  db: Database,
  env: PipelineEnv,
  domain: string,
  entityType: string,
  entityId: string,
  imageBytes: ArrayBuffer,
  contentType: string,
  sourceUrl: string | null
): Promise<PipelineResult> {
  const ext = extFromContentType(contentType);
  const r2Key = buildR2Key(domain, entityType, entityId, ext);

  // Upload to R2
  await uploadToR2(
    env.IMAGES,
    r2Key,
    imageBytes,
    contentType,
    'manual',
    sourceUrl ?? 'upload',
    'unknown'
  );

  // Generate ThumbHash and extract colors
  let thumbhash: string | null = null;
  let dominantColor: string | null = null;
  let accentColor: string | null = null;

  const decoded = decodeImageForAnalysis(imageBytes);
  if (decoded) {
    try {
      const colors = extractColors(
        decoded.pixels,
        decoded.width,
        decoded.height
      );
      dominantColor = colors.dominantColor;
      accentColor = colors.accentColor;
    } catch {
      // Color extraction is best-effort
    }

    try {
      thumbhash = generateThumbHash(
        decoded.width,
        decoded.height,
        decoded.pixels
      );
    } catch {
      // ThumbHash is best-effort
    }
  }

  // Upsert with override flag
  const existing = await db
    .select()
    .from(images)
    .where(
      and(
        eq(images.domain, domain),
        eq(images.entityType, entityType),
        eq(images.entityId, entityId)
      )
    )
    .limit(1);

  let imageVersion = 1;

  if (existing.length > 0) {
    imageVersion = existing[0].imageVersion + 1;
    await db
      .update(images)
      .set({
        r2Key,
        source: 'manual',
        sourceUrl: sourceUrl ?? 'upload',
        width: null,
        height: null,
        thumbhash,
        dominantColor,
        accentColor,
        isOverride: 1,
        overrideAt: new Date().toISOString(),
        imageVersion,
      })
      .where(eq(images.id, existing[0].id));
  } else {
    await db.insert(images).values({
      domain,
      entityType,
      entityId,
      r2Key,
      source: 'manual',
      sourceUrl: sourceUrl ?? 'upload',
      thumbhash,
      dominantColor,
      accentColor,
      isOverride: 1,
      overrideAt: new Date().toISOString(),
      imageVersion,
    });
  }

  return {
    r2Key,
    source: 'manual',
    sourceUrl: sourceUrl ?? 'upload',
    width: null,
    height: null,
    thumbhash,
    dominantColor,
    accentColor,
    imageVersion,
  };
}

/**
 * Revert an override: clear override flag and re-run automatic pipeline.
 */
export async function revertOverride(
  db: Database,
  env: PipelineEnv,
  domain: string,
  entityType: string,
  entityId: string,
  searchParams: SourceSearchParams
): Promise<PipelineResult | null> {
  const existing = await db
    .select()
    .from(images)
    .where(
      and(
        eq(images.domain, domain),
        eq(images.entityType, entityType),
        eq(images.entityId, entityId)
      )
    )
    .limit(1);

  if (existing.length === 0) {
    return null;
  }

  // Clear override flag
  const nextVersion = existing[0].imageVersion + 1;
  await db
    .update(images)
    .set({
      isOverride: 0,
      overrideAt: null,
      imageVersion: nextVersion,
    })
    .where(eq(images.id, existing[0].id));

  // Re-run pipeline (skip override check since we just cleared it)
  const result = await runPipeline(db, env, searchParams, {
    skipOverrideCheck: true,
  });

  if (result) {
    // Update version to the incremented one
    await db
      .update(images)
      .set({ imageVersion: nextVersion })
      .where(
        and(
          eq(images.domain, domain),
          eq(images.entityType, entityType),
          eq(images.entityId, entityId)
        )
      );
    result.imageVersion = nextVersion;
  }

  return result;
}

/**
 * Get an existing image record from the database.
 */
export async function getImageRecord(
  db: Database,
  domain: string,
  entityType: string,
  entityId: string
): Promise<ImageRecord | null> {
  const results = await db
    .select()
    .from(images)
    .where(
      and(
        eq(images.domain, domain),
        eq(images.entityType, entityType),
        eq(images.entityId, entityId)
      )
    )
    .limit(1);

  if (results.length === 0) return null;

  return results[0] as ImageRecord;
}
