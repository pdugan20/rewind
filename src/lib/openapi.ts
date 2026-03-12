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
    description: `Personal data aggregation API. Syncs and serves data from Strava, Last.fm, Discogs, Plex, Letterboxd, and Trakt.

## Domains

| Domain | Source | Description |
|--------|--------|-------------|
| **Listening** | Last.fm | Scrobbles, top artists/albums/tracks, streaks, stats |
| **Running** | Strava | Activities, splits, gear, personal records, year summaries |
| **Watching** | Plex, Letterboxd | Movies, TV shows, watch history, ratings, reviews |
| **Collecting** | Discogs, Trakt | Vinyl/CD collection, physical media, wantlist |

## Authentication

All endpoints require a Bearer token. There are two key types:

- **Read keys** (\`rw_live_...\`) — access all GET endpoints
- **Admin keys** (\`rw_admin_...\`) — access all endpoints including sync triggers and data management

Pass your key in the Authorization header: \`Authorization: Bearer rw_live_...\`

## Pagination

List endpoints return paginated responses:

\`\`\`json
{
  "data": [...],
  "pagination": { "page": 1, "limit": 20, "total": 150, "total_pages": 8 }
}
\`\`\`

The activity feed uses cursor-based pagination instead.`,
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
  tags: [
    { name: 'Listening', description: 'Last.fm scrobbles, top charts, streaks, and stats.' },
    { name: 'Running', description: 'Strava activities, splits, gear, records, and year summaries.' },
    { name: 'Watching', description: 'Movies, TV shows, watch history, ratings, and reviews from Plex and Letterboxd.' },
    { name: 'Collecting', description: 'Vinyl/CD collection from Discogs and physical media from Trakt.' },
    { name: 'Feed', description: 'Cross-domain activity feed with cursor-based pagination.' },
    { name: 'Search', description: 'Full-text search across all domains.' },
    { name: 'Images', description: 'Image proxy with on-the-fly transforms via Cloudflare Images.' },
    { name: 'System', description: 'Health checks and sync status.' },
    { name: 'Admin', description: 'API key management, sync triggers, and data administration. Requires admin key.' },
    { name: 'Webhooks', description: 'Inbound webhook receivers for Strava and Plex. No auth required.' },
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
