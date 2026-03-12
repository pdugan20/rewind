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
  IMAGE_TRANSFORMS: ImagesBinding;
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
  searchHints: string | null;
}

/**
 * Serialize search hints from pipeline params for storage.
 * Enables CDN on-demand resolution without needing to look up domain tables.
 */
function serializeSearchHints(params: SourceSearchParams): string | null {
  const hints: Record<string, string> = {};
  if (params.artistName) hints.artistName = params.artistName;
  if (params.albumName) hints.albumName = params.albumName;
  if (params.mbid) hints.mbid = params.mbid;
  if (params.tmdbId) hints.tmdbId = params.tmdbId;
  return Object.keys(hints).length > 0 ? JSON.stringify(hints) : null;
}

/**
 * Deserialize stored search hints back into pipeline params.
 */
export function deserializeSearchHints(
  hintsJson: string | null,
  domain: string,
  entityType: string,
  entityId: string
): SourceSearchParams {
  const params: SourceSearchParams = { domain, entityType, entityId };
  if (!hintsJson) return params;
  try {
    const hints = JSON.parse(hintsJson);
    if (hints.artistName) params.artistName = hints.artistName;
    if (hints.albumName) params.albumName = hints.albumName;
    if (hints.mbid) params.mbid = hints.mbid;
    if (hints.tmdbId) params.tmdbId = hints.tmdbId;
  } catch {
    // Ignore malformed hints
  }
  return params;
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
 * Returns all candidates in priority order so the pipeline can skip oversized files.
 */
export async function resolveImage(
  params: SourceSearchParams,
  env: PipelineEnv
): Promise<ImageResult[]> {
  const clients = getSourceClients(params.domain, params.entityType, env);
  const candidates: ImageResult[] = [];

  for (const client of clients) {
    try {
      const results = await client.search(params);
      if (results.length > 0) {
        candidates.push(...results);
      }
    } catch (error) {
      console.log(
        `[ERROR] Source ${client.name} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return candidates;
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
 * Decode image to RGBA pixels via Cloudflare Images binding.
 * Resizes to 100x100 for ThumbHash (spec limit) and color extraction.
 * Offloads all decoding to Cloudflare's native image processor — no JS CPU cost.
 */
async function decodeViaBinding(
  binding: ImagesBinding,
  bytes: ArrayBuffer
): Promise<{ pixels: Uint8Array; width: number; height: number } | null> {
  const TARGET_SIZE = 100;

  try {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });

    const result = await binding
      .input(stream)
      .transform({ width: TARGET_SIZE, height: TARGET_SIZE, fit: 'cover' })
      .output({ format: 'rgba' });

    const rgbaBuffer = await result.response().arrayBuffer();
    const pixels = new Uint8Array(rgbaBuffer);

    // Infer dimensions from pixel count (width * height * 4 = total bytes)
    const totalPixels = pixels.length / 4;
    // Since we requested cover fit at 100x100, output is exactly 100x100
    // unless the source is smaller
    const side = Math.round(Math.sqrt(totalPixels));
    const width = side;
    const height = totalPixels / side;

    return { pixels, width, height };
  } catch (error) {
    console.log(
      `[ERROR] Images binding decode failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
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
  const candidates = await resolveImage(params, env);
  if (candidates.length === 0) {
    console.log(
      `[INFO] No image found for ${domain}/${entityType}/${entityId}`
    );
    return null;
  }

  // Fetch the first candidate that succeeds
  let imageResult: ImageResult | null = null;
  let fetched: { bytes: ArrayBuffer; contentType: string } | null = null;

  for (const candidate of candidates) {
    const result = await fetchImageBytes(candidate.url);
    if (result) {
      imageResult = candidate;
      fetched = result;
      break;
    }
  }

  if (!imageResult || !fetched) {
    console.log(
      `[INFO] No fetchable image for ${domain}/${entityType}/${entityId}`
    );
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

  // Generate ThumbHash and extract colors via Cloudflare Images binding
  let thumbhash: string | null = null;
  let dominantColor: string | null = null;
  let accentColor: string | null = null;

  const decoded = await decodeViaBinding(env.IMAGE_TRANSFORMS, fetched.bytes);
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

  // Serialize search hints for future on-demand CDN resolution
  const searchHints = serializeSearchHints(params);

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
        searchHints,
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
      searchHints,
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

  const decoded = await decodeViaBinding(env.IMAGE_TRANSFORMS, imageBytes);
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
