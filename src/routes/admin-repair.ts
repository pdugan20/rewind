/**
 * Admin maintenance endpoints for the album-attribution-repair project:
 *
 *   POST /v1/admin/repair-album-attribution           — dry run, returns CSV
 *   POST /v1/admin/repair-album-attribution?apply=true — execute the repair
 *
 * See docs/projects/album-attribution-repair/README.md for the full plan.
 * Live application requires the admin scope (enforced by the global
 * middleware on the /v1/admin/ prefix) and a current DB snapshot.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { createDb } from '../db/client.js';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses } from '../lib/schemas/common.js';
import {
  applyRepair,
  planRepair,
  planToCsv,
} from '../services/lastfm/repair-attribution.js';

const adminRepair = createOpenAPIApp();

const repairResponse = z.object({
  mode: z.enum(['dry_run', 'applied']),
  total: z.number().int(),
  by_action: z.object({
    KEEP_AS_VA: z.number().int(),
    COLLAPSE_TO_PRIMARY: z.number().int(),
    SPLIT_PER_ARTIST: z.number().int(),
  }),
  albums_created: z.number().int().nullable(),
  tracks_moved: z.number().int().nullable(),
  audit_rows_written: z.number().int().nullable(),
});

const repairRoute = createRoute({
  method: 'post',
  path: '/repair-album-attribution',
  operationId: 'repairAlbumAttribution',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Repair album attribution',
  description:
    'Splits or collapses comp-flagged Last.fm albums per the dominant-cluster heuristic. Dry-run by default (pass ?apply=true to execute). Always returns a CSV in the `Content-Type: text/csv` mode when called without `apply`.',
  request: {
    query: z.object({
      apply: z.enum(['true', 'false']).optional().default('false').openapi({
        description: 'When true, executes the plan. Otherwise returns CSV.',
      }),
    }),
  },
  responses: {
    200: {
      description: 'Repair plan (dry run) or applied summary',
      content: {
        'application/json': {
          schema: repairResponse,
        },
        'text/csv': {
          schema: { type: 'string' },
        },
      },
    },
    ...errorResponses(401, 403),
  },
});

adminRepair.openapi(repairRoute, async (c) => {
  const db = createDb(c.env.DB);
  const apply = c.req.query('apply') === 'true';

  if (!apply) {
    const plan = await planRepair(db);
    const counts = plan.reduce(
      (acc, p) => {
        acc[p.action]++;
        return acc;
      },
      {
        KEEP_AS_VA: 0,
        COLLAPSE_TO_PRIMARY: 0,
        SPLIT_PER_ARTIST: 0,
      } as Record<
        'KEEP_AS_VA' | 'COLLAPSE_TO_PRIMARY' | 'SPLIT_PER_ARTIST',
        number
      >
    );

    // CSV when explicitly requested, JSON otherwise. The shell wrapper
    // scripts/backfills/repair-album-attribution.sh sets Accept: text/csv.
    const accept = c.req.header('accept') ?? '';
    if (accept.includes('text/csv')) {
      const csv = planToCsv(plan);
      return c.body(csv, 200, { 'Content-Type': 'text/csv; charset=utf-8' });
    }

    return c.json({
      mode: 'dry_run' as const,
      total: plan.length,
      by_action: counts,
      albums_created: null,
      tracks_moved: null,
      audit_rows_written: null,
    });
  }

  console.log('[REPAIR] Applying album attribution repair…');
  const summary = await applyRepair(db);
  console.log('[REPAIR] Done', summary);

  return c.json({
    mode: 'applied' as const,
    total: summary.total,
    by_action: summary.byAction,
    albums_created: summary.albumsCreated,
    tracks_moved: summary.tracksMoved,
    audit_rows_written: summary.auditRowsWritten,
  });
});

export default adminRepair;
