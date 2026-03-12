/**
 * Image route handler.
 * GET /v1/images/:domain/:entity_type/:entity_id/:size -- serve image via CDN redirect
 * GET /v1/admin/images/:domain/:entity_type/:entity_id/alternatives -- browse sources
 * PUT /v1/admin/images/:domain/:entity_type/:entity_id -- set override
 * DELETE /v1/admin/images/:domain/:entity_type/:entity_id/override -- revert override
 */

import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses } from '../lib/schemas/common.js';
import { createDb } from '../db/client.js';
import { badRequest, notFound, serverError } from '../lib/errors.js';
import { requireAuth } from '../lib/auth.js';
import {
  buildCdnUrl,
  VALID_SIZES,
  IMAGE_CACHE_CONTROL,
} from '../services/images/presets.js';
import {
  getImageRecord,
  runPipeline,
  runOverridePipeline,
  revertOverride,
  resolveAlternatives,
  deserializeSearchHints,
} from '../services/images/pipeline.js';
import type { SourceSearchParams } from '../services/images/sources/types.js';

const VALID_DOMAINS = ['listening', 'watching', 'collecting'];
const VALID_ENTITY_TYPES = ['albums', 'artists', 'movies', 'shows', 'releases'];

const imagesRoute = createOpenAPIApp();

// Read auth for GET endpoints
imagesRoute.use('/images/*', requireAuth('read'));

// ─── Schemas ────────────────────────────────────────────────────────

const DomainParam = z
  .enum(['listening', 'watching', 'collecting'])
  .openapi({ example: 'listening' });

const EntityTypeParam = z
  .enum(['albums', 'artists', 'movies', 'shows', 'releases'])
  .openapi({ example: 'albums' });

const EntityIdParam = z.string().min(1).openapi({ example: 'album-123' });

const SizeParam = z
  .enum(VALID_SIZES as [string, ...string[]])
  .openapi({ example: 'medium' });

const SearchHintsQuery = z.object({
  artist_name: z.string().optional().openapi({ example: 'Radiohead' }),
  album_name: z
    .string()
    .optional()
    .openapi({ example: 'OK Computer' }),
  mbid: z.string().optional().openapi({ example: 'a1b2c3d4-...' }),
  tmdb_id: z.string().optional().openapi({ example: '12345' }),
});

const ImageResultResponse = z
  .object({
    domain: z.string(),
    entity_type: z.string(),
    entity_id: z.string(),
    image_url: z.string().url(),
    source: z.string(),
    is_override: z.boolean(),
    image_version: z.number().int(),
    thumbhash: z.string().nullable(),
    dominant_color: z.string().nullable(),
    accent_color: z.string().nullable(),
  })
  .openapi('ImageResultResponse');

const AlternativeItem = z.object({
  source: z.string().openapi({ example: 'cover-art-archive' }),
  url: z.string().url(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});

const AlternativesResponse = z
  .object({
    entity: z.object({
      domain: z.string(),
      entity_type: z.string(),
      entity_id: z.string(),
    }),
    current_source: z.string().nullable(),
    is_override: z.boolean(),
    alternatives: z.array(AlternativeItem),
  })
  .openapi('ImageAlternativesResponse');

// ─── Routes ─────────────────────────────────────────────────────────

/**
 * GET /v1/images/:domain/:entity_type/:entity_id/:size
 * Serve image via CDN redirect. Triggers pipeline on cache miss.
 */
const getImageRoute = createRoute({
  method: 'get',
  path: '/images/{domain}/{entity_type}/{entity_id}/{size}',
  tags: ['Images'],
  summary: 'Get image by entity',
  description:
    'Serve image via CDN redirect. Triggers the image pipeline on cache miss. Returns a 302 redirect to the CDN URL with metadata in response headers.',
  request: {
    params: z.object({
      domain: DomainParam,
      entity_type: EntityTypeParam,
      entity_id: EntityIdParam,
      size: SizeParam,
    }),
    query: SearchHintsQuery,
  },
  responses: {
    302: {
      description:
        'Redirect to CDN image URL. Metadata returned via X-ThumbHash, X-Dominant-Color, X-Accent-Color headers.',
    },
    ...errorResponses(400, 401, 404, 500),
  },
});

imagesRoute.openapi(getImageRoute, async (c) => {
  const { domain, entity_type, entity_id, size } = c.req.valid('param');

  // Validate params
  if (!VALID_DOMAINS.includes(domain)) {
    return badRequest(c, `Invalid domain: ${domain}`) as any;
  }
  if (!VALID_ENTITY_TYPES.includes(entity_type)) {
    return badRequest(c, `Invalid entity type: ${entity_type}`) as any;
  }
  if (!VALID_SIZES.includes(size)) {
    return badRequest(
      c,
      `Invalid size: ${size}. Valid sizes: ${VALID_SIZES.join(', ')}`
    ) as any;
  }

  const db = createDb(c.env.DB);

  // Check for existing image record
  let record = await getImageRecord(db, domain, entity_type, entity_id);

  if (!record) {
    // Cache miss: build search params from query hints
    const searchParams: SourceSearchParams = {
      domain,
      entityType: entity_type,
      entityId: entity_id,
    };

    // Accept search hints as query params for on-demand resolution
    const artistName = c.req.query('artist_name');
    const albumName = c.req.query('album_name');
    const mbid = c.req.query('mbid');
    const tmdbId = c.req.query('tmdb_id');

    if (artistName) searchParams.artistName = artistName;
    if (albumName) searchParams.albumName = albumName;
    if (mbid) searchParams.mbid = mbid;
    if (tmdbId) searchParams.tmdbId = tmdbId;

    const result = await runPipeline(db, c.env, searchParams);
    if (!result) {
      return notFound(c, 'No image available for this entity') as any;
    }

    // Fetch the newly created record
    record = await getImageRecord(db, domain, entity_type, entity_id);
    if (!record) {
      return serverError(c, 'Failed to create image record') as any;
    }
  } else if (!record.r2Key && record.searchHints) {
    // Record exists but needs reprocessing -- use stored search hints
    const searchParams = deserializeSearchHints(
      record.searchHints,
      domain,
      entity_type,
      entity_id
    );

    const result = await runPipeline(db, c.env, searchParams);
    if (result) {
      record = await getImageRecord(db, domain, entity_type, entity_id);
      if (!record) {
        return serverError(c, 'Failed to refresh image record') as any;
      }
    }
  }

  // Build CDN URL with size transform and cache busting
  const cdnUrl = buildCdnUrl(record.r2Key, size, record.imageVersion);

  // Set metadata headers
  c.header('Cache-Control', IMAGE_CACHE_CONTROL);
  if (record.thumbhash) {
    c.header('X-ThumbHash', record.thumbhash);
  }
  if (record.dominantColor) {
    c.header('X-Dominant-Color', record.dominantColor);
  }
  if (record.accentColor) {
    c.header('X-Accent-Color', record.accentColor);
  }

  // Redirect to CDN
  return c.redirect(cdnUrl, 302);
});

/**
 * GET /v1/admin/images/:domain/:entity_type/:entity_id/alternatives
 * Browse available images from all sources.
 */
const getAlternativesRoute = createRoute({
  method: 'get',
  path: '/admin/images/{domain}/{entity_type}/{entity_id}/alternatives',
  tags: ['Images', 'Admin'],
  summary: 'Browse image alternatives',
  description:
    'Browse available images from all configured sources for an entity. Shows the current source and whether it is an override.',
  request: {
    params: z.object({
      domain: DomainParam,
      entity_type: EntityTypeParam,
      entity_id: EntityIdParam,
    }),
    query: SearchHintsQuery,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AlternativesResponse } },
      description: 'List of available image alternatives',
    },
    ...errorResponses(400, 401),
  },
});

imagesRoute.openapi(getAlternativesRoute, async (c) => {
  const { domain, entity_type, entity_id } = c.req.valid('param');

  if (!VALID_DOMAINS.includes(domain)) {
    return badRequest(c, `Invalid domain: ${domain}`) as any;
  }
  if (!VALID_ENTITY_TYPES.includes(entity_type)) {
    return badRequest(c, `Invalid entity type: ${entity_type}`) as any;
  }

  const db = createDb(c.env.DB);
  const searchParams: SourceSearchParams = {
    domain,
    entityType: entity_type,
    entityId: entity_id,
  };

  // Parse optional search hints from query params
  const artistName = c.req.query('artist_name');
  const albumName = c.req.query('album_name');
  const mbid = c.req.query('mbid');
  const tmdbId = c.req.query('tmdb_id');

  if (artistName) searchParams.artistName = artistName;
  if (albumName) searchParams.albumName = albumName;
  if (mbid) searchParams.mbid = mbid;
  if (tmdbId) searchParams.tmdbId = tmdbId;

  const alternatives = await resolveAlternatives(searchParams, c.env);

  // Get current image info
  const current = await getImageRecord(db, domain, entity_type, entity_id);

  return c.json({
    entity: {
      domain,
      entity_type,
      entity_id,
    },
    current_source: current?.source ?? null,
    is_override: current ? current.isOverride === 1 : false,
    alternatives: alternatives.map((alt) => ({
      source: alt.source,
      url: alt.url,
      width: alt.width,
      height: alt.height,
    })),
  });
});

/**
 * PUT /v1/admin/images/:domain/:entity_type/:entity_id
 * Set an image override from a URL or upload.
 */
const putOverrideRoute = createRoute({
  method: 'put',
  path: '/admin/images/{domain}/{entity_type}/{entity_id}',
  tags: ['Images', 'Admin'],
  summary: 'Set image override',
  description:
    'Set an image override for an entity. Accepts either a JSON body with source_url or a multipart/form-data upload with an image file.',
  request: {
    params: z.object({
      domain: DomainParam,
      entity_type: EntityTypeParam,
      entity_id: EntityIdParam,
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ImageResultResponse } },
      description: 'Image override applied successfully',
    },
    ...errorResponses(400, 401, 500),
  },
});

imagesRoute.openapi(putOverrideRoute, async (c) => {
  const { domain, entity_type, entity_id } = c.req.valid('param');

  if (!VALID_DOMAINS.includes(domain)) {
    return badRequest(c, `Invalid domain: ${domain}`) as any;
  }
  if (!VALID_ENTITY_TYPES.includes(entity_type)) {
    return badRequest(c, `Invalid entity type: ${entity_type}`) as any;
  }

  const db = createDb(c.env.DB);
  const contentType = c.req.header('content-type') ?? '';

  let imageBytes: ArrayBuffer;
  let imageContentType: string;
  let sourceUrl: string | null = null;

  if (contentType.includes('multipart/form-data')) {
    // Option B: file upload
    const formData = await c.req.formData();
    const file = formData.get('image');

    if (!file || !(file instanceof File)) {
      return badRequest(c, 'Missing image file in form data') as any;
    }

    imageBytes = await file.arrayBuffer();
    imageContentType = file.type || 'image/jpeg';
  } else {
    // Option A: JSON with source_url
    let body: { source_url?: string };
    try {
      body = await c.req.json();
    } catch {
      return badRequest(c, 'Invalid JSON body') as any;
    }

    if (!body.source_url) {
      return badRequest(c, 'Missing source_url in request body') as any;
    }

    sourceUrl = body.source_url;

    // Fetch the image
    const response = await fetch(sourceUrl, {
      headers: { 'User-Agent': 'RewindAPI/1.0' },
    });

    if (!response.ok) {
      return badRequest(c, `Failed to fetch image from ${sourceUrl}`) as any;
    }

    imageBytes = await response.arrayBuffer();
    imageContentType = response.headers.get('content-type') ?? 'image/jpeg';
  }

  try {
    const result = await runOverridePipeline(
      db,
      c.env,
      domain,
      entity_type,
      entity_id,
      imageBytes,
      imageContentType,
      sourceUrl
    );

    return c.json({
      domain,
      entity_type,
      entity_id,
      image_url: buildCdnUrl(result.r2Key, 'original', result.imageVersion),
      source: result.source,
      is_override: true,
      image_version: result.imageVersion,
      thumbhash: result.thumbhash,
      dominant_color: result.dominantColor,
      accent_color: result.accentColor,
    });
  } catch (error) {
    console.log(
      `[ERROR] Override pipeline failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return serverError(c, 'Failed to process image override') as any;
  }
});

/**
 * DELETE /v1/admin/images/:domain/:entity_type/:entity_id/override
 * Revert an override and re-run automatic pipeline.
 */
const deleteOverrideRoute = createRoute({
  method: 'delete',
  path: '/admin/images/{domain}/{entity_type}/{entity_id}/override',
  tags: ['Images', 'Admin'],
  summary: 'Revert image override',
  description:
    'Revert an image override and re-run the automatic pipeline to select the best available source.',
  request: {
    params: z.object({
      domain: DomainParam,
      entity_type: EntityTypeParam,
      entity_id: EntityIdParam,
    }),
    query: SearchHintsQuery,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ImageResultResponse } },
      description: 'Override reverted successfully',
    },
    ...errorResponses(400, 401, 404, 500),
  },
});

// eslint-disable-next-line drizzle/enforce-delete-with-where -- this is a Hono HTTP DELETE route, not a Drizzle delete
imagesRoute.openapi(deleteOverrideRoute, async (c) => {
  const { domain, entity_type, entity_id } = c.req.valid('param');

  if (!VALID_DOMAINS.includes(domain)) {
    return badRequest(c, `Invalid domain: ${domain}`) as any;
  }
  if (!VALID_ENTITY_TYPES.includes(entity_type)) {
    return badRequest(c, `Invalid entity type: ${entity_type}`) as any;
  }

  const db = createDb(c.env.DB);

  // Check if the image exists and is overridden
  const existing = await getImageRecord(db, domain, entity_type, entity_id);
  if (!existing) {
    return notFound(c, 'No image record found for this entity') as any;
  }
  if (existing.isOverride !== 1) {
    return badRequest(c, 'Image is not overridden') as any;
  }

  const searchParams: SourceSearchParams = {
    domain,
    entityType: entity_type,
    entityId: entity_id,
  };

  // Parse optional search hints from query params
  const artistName = c.req.query('artist_name');
  const albumName = c.req.query('album_name');
  const mbid = c.req.query('mbid');
  const tmdbId = c.req.query('tmdb_id');

  if (artistName) searchParams.artistName = artistName;
  if (albumName) searchParams.albumName = albumName;
  if (mbid) searchParams.mbid = mbid;
  if (tmdbId) searchParams.tmdbId = tmdbId;

  const result = await revertOverride(
    db,
    c.env,
    domain,
    entity_type,
    entity_id,
    searchParams
  );

  if (!result) {
    return serverError(
      c,
      'Failed to revert override -- no sources available'
    ) as any;
  }

  return c.json({
    domain,
    entity_type,
    entity_id,
    image_url: buildCdnUrl(result.r2Key, 'original', result.imageVersion),
    source: result.source,
    is_override: false,
    image_version: result.imageVersion,
    thumbhash: result.thumbhash,
    dominant_color: result.dominantColor,
    accent_color: result.accentColor,
  });
});

export default imagesRoute;
