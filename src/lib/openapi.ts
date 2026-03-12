import { OpenAPIHono } from '@hono/zod-openapi';
import type { Env } from '../types/env.js';

/**
 * Create an OpenAPIHono app instance with shared configuration.
 * Used by route files that define OpenAPI-annotated routes.
 */
export function createOpenAPIApp() {
  return new OpenAPIHono<{ Bindings: Env }>();
}

/**
 * OpenAPI document metadata. Used when generating the spec.
 */
export const openAPIConfig = {
  openapi: '3.1.0',
  info: {
    title: 'Rewind API',
    version: '1.0.0',
    description:
      'Personal data aggregation API. Syncs and serves data from Strava, Last.fm, Discogs, Plex, Letterboxd, and Trakt.',
    contact: {
      name: 'Pat Dugan',
      url: 'https://patdugan.me',
    },
  },
  servers: [
    {
      url: 'https://api.rewind.rest',
      description: 'Production',
    },
  ],
  security: [{ bearerAuth: [] as string[] }],
};

/**
 * Security scheme definition for Bearer token auth.
 */
export const securitySchemes = {
  bearerAuth: {
    type: 'http' as const,
    scheme: 'bearer',
    description:
      'API key. Read keys (rw_live_...) access GET endpoints. Admin keys (rw_admin_...) access all endpoints.',
  },
};
