/**
 * Image route handler.
 * GET /v1/images/:domain/:entity_type/:entity_id/:size -- serve image via CDN redirect
 * GET /v1/admin/images/:domain/:entity_type/:entity_id/alternatives -- browse sources
 * PUT /v1/admin/images/:domain/:entity_type/:entity_id -- set override
 * DELETE /v1/admin/images/:domain/:entity_type/:entity_id/override -- revert override
 */

import { Hono } from 'hono';
import type { Env } from '../types/env.js';
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

const imagesRoute = new Hono<{ Bindings: Env }>();

// Read auth for GET endpoints
imagesRoute.use('/images/*', requireAuth('read'));

/**
 * GET /v1/images/:domain/:entity_type/:entity_id/:size
 * Serve image via CDN redirect. Triggers pipeline on cache miss.
 */
imagesRoute.get('/images/:domain/:entity_type/:entity_id/:size', async (c) => {
  const { domain, entity_type, entity_id, size } = c.req.param();

  // Validate params
  if (!VALID_DOMAINS.includes(domain)) {
    return badRequest(c, `Invalid domain: ${domain}`);
  }
  if (!VALID_ENTITY_TYPES.includes(entity_type)) {
    return badRequest(c, `Invalid entity type: ${entity_type}`);
  }
  if (!VALID_SIZES.includes(size)) {
    return badRequest(
      c,
      `Invalid size: ${size}. Valid sizes: ${VALID_SIZES.join(', ')}`
    );
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
      return notFound(c, 'No image available for this entity');
    }

    // Fetch the newly created record
    record = await getImageRecord(db, domain, entity_type, entity_id);
    if (!record) {
      return serverError(c, 'Failed to create image record');
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
        return serverError(c, 'Failed to refresh image record');
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
imagesRoute.get(
  '/admin/images/:domain/:entity_type/:entity_id/alternatives',
  async (c) => {
    const { domain, entity_type, entity_id } = c.req.param();

    if (!VALID_DOMAINS.includes(domain)) {
      return badRequest(c, `Invalid domain: ${domain}`);
    }
    if (!VALID_ENTITY_TYPES.includes(entity_type)) {
      return badRequest(c, `Invalid entity type: ${entity_type}`);
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
  }
);

/**
 * PUT /v1/admin/images/:domain/:entity_type/:entity_id
 * Set an image override from a URL or upload.
 */
imagesRoute.put('/admin/images/:domain/:entity_type/:entity_id', async (c) => {
  const { domain, entity_type, entity_id } = c.req.param();

  if (!VALID_DOMAINS.includes(domain)) {
    return badRequest(c, `Invalid domain: ${domain}`);
  }
  if (!VALID_ENTITY_TYPES.includes(entity_type)) {
    return badRequest(c, `Invalid entity type: ${entity_type}`);
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
      return badRequest(c, 'Missing image file in form data');
    }

    imageBytes = await file.arrayBuffer();
    imageContentType = file.type || 'image/jpeg';
  } else {
    // Option A: JSON with source_url
    let body: { source_url?: string };
    try {
      body = await c.req.json();
    } catch {
      return badRequest(c, 'Invalid JSON body');
    }

    if (!body.source_url) {
      return badRequest(c, 'Missing source_url in request body');
    }

    sourceUrl = body.source_url;

    // Fetch the image
    const response = await fetch(sourceUrl, {
      headers: { 'User-Agent': 'RewindAPI/1.0' },
    });

    if (!response.ok) {
      return badRequest(c, `Failed to fetch image from ${sourceUrl}`);
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
    return serverError(c, 'Failed to process image override');
  }
});

/**
 * DELETE /v1/admin/images/:domain/:entity_type/:entity_id/override
 * Revert an override and re-run automatic pipeline.
 */
// eslint-disable-next-line drizzle/enforce-delete-with-where -- this is a Hono HTTP DELETE route, not a Drizzle delete
imagesRoute.delete(
  '/admin/images/:domain/:entity_type/:entity_id/override',
  async (c) => {
    const { domain, entity_type, entity_id } = c.req.param();

    if (!VALID_DOMAINS.includes(domain)) {
      return badRequest(c, `Invalid domain: ${domain}`);
    }
    if (!VALID_ENTITY_TYPES.includes(entity_type)) {
      return badRequest(c, `Invalid entity type: ${entity_type}`);
    }

    const db = createDb(c.env.DB);

    // Check if the image exists and is overridden
    const existing = await getImageRecord(db, domain, entity_type, entity_id);
    if (!existing) {
      return notFound(c, 'No image record found for this entity');
    }
    if (existing.isOverride !== 1) {
      return badRequest(c, 'Image is not overridden');
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
      );
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
  }
);

export default imagesRoute;
