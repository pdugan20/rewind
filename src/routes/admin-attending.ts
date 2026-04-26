// Phase 7 review surface for the attending domain.
//
// Workflow:
//   1. Run a dry-run sync to see what's flowing through
//      (POST /v1/admin/sync/attending {dry_run: true}).
//   2. Run a real sync to load high-confidence candidates
//      (POST /v1/admin/sync/attending {dry_run: false}).
//   3. List unloaded source rows that didn't make it
//      (GET /v1/admin/attending/pending).
//   4. For each, either promote (manually load it, optionally with
//      override fields) or reject (hard-delete the source row).

import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { attendedEventSources } from '../db/schema/attending.js';
import { enrichCandidate } from '../services/attending/enrich.js';
import { loadCanonicalEvent } from '../services/attending/load.js';
import {
  importManualAttending,
  type ManualEntry,
} from '../services/attending/manual-import.js';
import { reprocessPendingSources } from '../services/attending/reprocess.js';
import type { ParsedReservation } from '../services/attending/parse-jsonld.js';
import { setCache } from '../lib/cache.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses } from '../lib/schemas/common.js';

const adminAttending = createOpenAPIApp();

// ─── Schemas ────────────────────────────────────────────────────────

const PendingSourceSchema = z
  .object({
    id: z.number().int(),
    source_type: z.string(),
    source_ref: z.string(),
    raw_data: z.record(z.string(), z.any()).nullable(),
    match_confidence: z.number().nullable(),
    created_at: z.string(),
  })
  .openapi('AttendingPendingSource');

const PromoteBody = z
  .object({
    // Optional overrides — when present, they replace whatever the
    // source row's raw_data inferred. Useful when the parser mis-titled
    // a concert or got the wrong date.
    title: z.string().optional(),
    event_date: z.string().optional().openapi({ example: '2024-09-14' }),
    event_datetime: z.string().optional(),
    location: z.string().optional(),
    performers: z.array(z.string()).optional(),
  })
  .openapi('AttendingPromoteBody');

const PromoteResponse = z
  .object({
    status: z.literal('promoted'),
    event_id: z.number().int(),
    action: z.enum(['inserted', 'updated']),
    match_confidence: z.number(),
    match_notes: z.array(z.string()),
  })
  .openapi('AttendingPromoteResponse');

const RejectResponse = z
  .object({
    status: z.literal('rejected'),
    deleted: z.literal(true),
    source_ref: z.string(),
  })
  .openapi('AttendingRejectResponse');

const SourceIdParam = z.object({
  id: z.coerce
    .number()
    .int()
    .openapi({
      param: { name: 'id', in: 'path', required: true },
      example: 42,
    }),
});

// ─── GET /v1/admin/attending/pending ────────────────────────────────

const pendingRoute = createRoute({
  method: 'get',
  path: '/admin/attending/pending',
  operationId: 'adminAttendingPending',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'List source rows awaiting review',
  description:
    'Returns attended_event_sources rows that have not been linked to a canonical event yet. Use this to manually review parser failures or low-confidence candidates before promoting or rejecting them.',
  request: {
    query: z.object({
      source_type: z.enum(['gcal', 'gmail', 'manual']).optional(),
      source_ref: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(1000).optional().default(50),
    }),
  },
  responses: {
    200: {
      description: 'Pending source rows',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(PendingSourceSchema),
            count: z.number().int(),
          }),
        },
      },
    },
    ...errorResponses(401),
  },
});

adminAttending.openapi(pendingRoute, async (c) => {
  const db = createDb(c.env.DB);
  const { source_type, source_ref, limit } = c.req.valid('query');

  const rows = await db
    .select()
    .from(attendedEventSources)
    .where(
      and(
        eq(attendedEventSources.userId, 1),
        isNull(attendedEventSources.eventId),
        source_type
          ? eq(attendedEventSources.sourceType, source_type)
          : undefined,
        source_ref ? eq(attendedEventSources.sourceRef, source_ref) : undefined
      )
    )
    .orderBy(asc(attendedEventSources.createdAt))
    .limit(limit);

  setCache(c, 'none');
  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      source_type: r.sourceType,
      source_ref: r.sourceRef,
      raw_data: parseJson(r.rawData),
      match_confidence: r.matchConfidence,
      created_at: r.createdAt,
    })),
    count: rows.length,
  });
});

// ─── POST /v1/admin/attending/sources/:id/promote ───────────────────

const promoteRoute = createRoute({
  method: 'post',
  path: '/admin/attending/sources/{id}/promote',
  operationId: 'adminAttendingPromote',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Promote a pending source row to a canonical event',
  description:
    "Manually trigger enrich+load for a single source row. Optional body overrides individual fields when the parser got something wrong. The source row's raw_data supplies defaults for any field not overridden.",
  request: {
    params: SourceIdParam,
    body: {
      content: { 'application/json': { schema: PromoteBody } },
      required: false,
    },
  },
  responses: {
    200: {
      description: 'Source promoted',
      content: { 'application/json': { schema: PromoteResponse } },
    },
    ...errorResponses(400, 401, 404, 500),
  },
});

adminAttending.openapi(promoteRoute, async (c) => {
  const db = createDb(c.env.DB);
  const { id } = c.req.valid('param');

  const [source] = await db
    .select()
    .from(attendedEventSources)
    .where(
      and(eq(attendedEventSources.userId, 1), eq(attendedEventSources.id, id))
    )
    .limit(1);
  if (!source) return notFound(c, 'Source not found') as any;

  type PromoteOverride = {
    title?: string;
    event_date?: string;
    event_datetime?: string;
    location?: string;
    performers?: string[];
  };
  const body: PromoteOverride = await c.req
    .json<PromoteOverride>()
    .catch(() => ({}) as PromoteOverride);

  const raw = parseJson(source.rawData) ?? {};
  const inputs = buildCandidateFromSource(
    source.sourceType as 'gcal' | 'gmail' | 'manual',
    raw
  );

  const candidate = {
    source_ref: source.sourceRef,
    source_type: source.sourceType as 'gcal' | 'gmail' | 'manual',
    event_date: body.event_date ?? inputs.event_date,
    event_datetime: body.event_datetime ?? inputs.event_datetime,
    title: body.title ?? inputs.title,
    location: body.location ?? inputs.location,
    performers: body.performers ?? inputs.performers,
  };

  if (!candidate.event_date) {
    return badRequest(
      c,
      'event_date is required (not present in source data, override via body)'
    ) as any;
  }

  try {
    const enriched = await enrichCandidate(candidate, db, c.env);
    if (!enriched) {
      return badRequest(
        c,
        'enrichCandidate returned null (no event_date?)'
      ) as any;
    }

    const tickets: ParsedReservation[] =
      source.sourceType === 'gmail' && Array.isArray(raw.reservations)
        ? (raw.reservations as ParsedReservation[])
        : [];

    const result = await loadCanonicalEvent(
      enriched,
      tickets,
      [
        {
          source_type: source.sourceType as 'gcal' | 'gmail' | 'manual',
          source_ref: source.sourceRef,
        },
      ],
      db
    );

    return c.json({
      status: 'promoted' as const,
      event_id: result.event_id,
      action: result.action as 'inserted' | 'updated',
      match_confidence: enriched.match_confidence,
      match_notes: enriched.match_notes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `[ERROR] POST /admin/attending/sources/${id}/promote: ${message}`
    );
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// ─── POST /v1/admin/attending/sources/:id/reject ────────────────────

const rejectRoute = createRoute({
  method: 'post',
  path: '/admin/attending/sources/{id}/reject',
  operationId: 'adminAttendingReject',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Reject a pending source row (hard-delete)',
  description:
    "Removes the source row entirely. Useful for marketing/transfer/refund emails that slipped through the subject gate. The cron's syncToken means we won't re-extract the same row, so no need for a soft-delete flag.",
  request: { params: SourceIdParam },
  responses: {
    200: {
      description: 'Source rejected',
      content: { 'application/json': { schema: RejectResponse } },
    },
    ...errorResponses(401, 404),
  },
});

adminAttending.openapi(rejectRoute, async (c) => {
  const db = createDb(c.env.DB);
  const { id } = c.req.valid('param');

  const [source] = await db
    .select()
    .from(attendedEventSources)
    .where(
      and(eq(attendedEventSources.userId, 1), eq(attendedEventSources.id, id))
    )
    .limit(1);
  if (!source) return notFound(c, 'Source not found') as any;

  await db.delete(attendedEventSources).where(eq(attendedEventSources.id, id));

  return c.json({
    status: 'rejected' as const,
    deleted: true as const,
    source_ref: source.sourceRef,
  });
});

// ─── Helpers ────────────────────────────────────────────────────────

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface SourceBuiltInputs {
  title: string | null;
  location: string | null;
  event_date: string | null;
  event_datetime: string | null;
  performers?: string[];
}

/**
 * Reconstruct a CandidateInput from a stored source row's raw_data.
 * Each source_type stores a different shape; this normalizes them.
 */
function buildCandidateFromSource(
  sourceType: 'gcal' | 'gmail' | 'manual',
  raw: Record<string, unknown>
): SourceBuiltInputs {
  if (sourceType === 'gcal') {
    const start = raw.start as { dateTime?: string; date?: string } | undefined;
    const dt = start?.dateTime ?? null;
    const date = start?.date ?? (dt ? dt.slice(0, 10) : null);
    return {
      title: (raw.summary as string) ?? null,
      location: (raw.location as string) ?? null,
      event_date: date,
      event_datetime: dt,
    };
  }
  if (sourceType === 'gmail') {
    const reservations = (raw.reservations as ParsedReservation[]) ?? [];
    const first = reservations[0];
    if (first) {
      const dt = first.event_start;
      const date = dt && /^\d{4}-\d{2}-\d{2}/.test(dt) ? dt.slice(0, 10) : null;
      return {
        title: first.event_name ?? null,
        location: first.venue_address ?? first.venue_name ?? null,
        event_date: date,
        event_datetime: dt,
      };
    }
    return {
      title: (raw.subject as string) ?? null,
      location: null,
      event_date: null,
      event_datetime: null,
    };
  }
  return {
    title: null,
    location: null,
    event_date: null,
    event_datetime: null,
  };
}

// ─── POST /v1/admin/sync/attending/manual-import ────────────────────

const ManualEntrySchema = z.union([
  // Per-game format
  z.object({
    event_date: z.string().openapi({ example: '2008-09-13' }),
    event_type: z.enum([
      'mlb_game',
      'nfl_game',
      'nba_game',
      'wnba_game',
      'mls_game',
      'ncaaf_game',
      'ncaab_game',
    ]),
    team_id: z.number().int().openapi({ example: 264 }),
    opponent: z.string().optional(),
    is_home: z.boolean().optional(),
    notes: z.string().optional(),
    attended: z.union([z.literal(0), z.literal(1)]).optional(),
  }),
  // Season shorthand
  z.object({
    event_type: z.enum([
      'mlb_game',
      'nfl_game',
      'nba_game',
      'wnba_game',
      'mls_game',
      'ncaaf_game',
      'ncaab_game',
    ]),
    team_id: z.number().int(),
    season: z.number().int().openapi({ example: 2024 }),
    attendance: z.literal('all_home'),
    exceptions: z.array(z.string()).optional(),
  }),
]);

const ManualImportBody = z
  .object({
    events: z.array(ManualEntrySchema),
  })
  .openapi('AttendingManualImportBody');

const ManualImportResponse = z
  .object({
    status: z.literal('completed'),
    loaded: z.number().int(),
    inserted: z.number().int(),
    updated: z.number().int(),
    skipped_attended_zero: z.number().int(),
    unmatched: z.array(
      z.object({
        entry: z.any(),
        reason: z.string(),
      })
    ),
  })
  .openapi('AttendingManualImportResponse');

const manualImportRoute = createRoute({
  method: 'post',
  path: '/admin/sync/attending/manual-import',
  operationId: 'adminAttendingManualImport',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Bulk-import attended events from a hand-curated list',
  description:
    'Loads attended_events rows from per-game entries (UW football 2007–2010 from Wikipedia) or season-shorthand entries (`attendance: "all_home"` for friend\'s-season-tickets pattern). Hits MLB Stats API / ESPN to fetch canonical game records — no manual score-typing required.',
  request: {
    body: {
      content: { 'application/json': { schema: ManualImportBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Import completed',
      content: { 'application/json': { schema: ManualImportResponse } },
    },
    ...errorResponses(400, 401, 500),
  },
});

adminAttending.openapi(manualImportRoute, async (c) => {
  const db = createDb(c.env.DB);
  const { events } = c.req.valid('json');

  try {
    const result = await importManualAttending(
      db,
      c.env,
      events as ManualEntry[]
    );
    return c.json({
      status: 'completed' as const,
      loaded: result.loaded,
      inserted: result.inserted,
      updated: result.updated,
      skipped_attended_zero: result.skipped_attended_zero,
      unmatched: result.unmatched,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[ERROR] POST /admin/sync/attending/manual-import: ${message}`);
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// ─── POST /v1/admin/attending/reprocess ─────────────────────────────

const ReprocessBody = z
  .object({
    vendor: z.string().optional().openapi({ example: 'ticketclub.com' }),
    refetch_missing_body: z.boolean().optional().default(true),
    limit: z.number().int().min(1).max(2000).optional().default(1000),
    dry_run: z.boolean().optional().default(false),
    force_update_loaded: z.boolean().optional().default(false),
  })
  .openapi('AttendingReprocessBody');

const ReprocessResponse = z
  .object({
    status: z.literal('completed'),
    scanned: z.number().int(),
    refetched: z.number().int(),
    newly_parsed: z.number().int(),
    loaded: z.number().int(),
    updated_loaded: z.number().int(),
    failures: z.array(
      z.object({ source_id: z.number().int(), reason: z.string() })
    ),
  })
  .openapi('AttendingReprocessResponse');

const reprocessRoute = createRoute({
  method: 'post',
  path: '/admin/attending/reprocess',
  operationId: 'adminAttendingReprocess',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Re-run parsers + enrich+load over pending source rows',
  description:
    "After shipping a new vendor parser, this endpoint re-tries every pending source. With `refetch_missing_body: true` (default), Gmail messages whose body wasn't captured (early Phase 3 sources) get re-fetched and updated. Use `vendor` to scope to one domain.",
  request: {
    body: {
      content: { 'application/json': { schema: ReprocessBody } },
      required: false,
    },
  },
  responses: {
    200: {
      description: 'Reprocess completed',
      content: { 'application/json': { schema: ReprocessResponse } },
    },
    ...errorResponses(401, 500),
  },
});

adminAttending.openapi(reprocessRoute, async (c) => {
  const db = createDb(c.env.DB);
  type ReprocessOpts = {
    vendor?: string;
    refetch_missing_body?: boolean;
    limit?: number;
    dry_run?: boolean;
    force_update_loaded?: boolean;
  };
  const body: ReprocessOpts = await c.req
    .json<ReprocessOpts>()
    .catch(() => ({}) as ReprocessOpts);

  try {
    const result = await reprocessPendingSources(db, c.env, {
      vendor: body.vendor,
      refetchMissingBody: body.refetch_missing_body ?? true,
      limit: body.limit ?? 1000,
      dryRun: body.dry_run ?? false,
      forceUpdateLoaded: body.force_update_loaded ?? false,
    });
    return c.json({
      status: 'completed' as const,
      scanned: result.scanned,
      refetched: result.refetched,
      newly_parsed: result.newly_parsed,
      loaded: result.loaded,
      updated_loaded: result.updated_loaded,
      failures: result.failures,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[ERROR] POST /admin/attending/reprocess: ${message}`);
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// ─── POST /v1/admin/attending/enrich-boxscores ──────────────────────

const EnrichBoxScoresBody = z
  .object({
    game_pks: z.array(z.number().int()).optional(),
    skip_enriched: z.boolean().optional().default(true),
    limit: z.number().int().min(1).max(500).optional().default(100),
    dry_run: z.boolean().optional().default(false),
  })
  .openapi('AttendingEnrichBoxScoresBody');

const EnrichBoxScoresResponse = z
  .object({
    status: z.literal('completed'),
    scanned: z.number().int(),
    enriched: z.number().int(),
    players_inserted: z.number().int(),
    players_updated: z.number().int(),
    appearances_inserted: z.number().int(),
    appearances_updated: z.number().int(),
    failures: z.array(
      z.object({ event_id: z.number().int(), reason: z.string() })
    ),
  })
  .openapi('AttendingEnrichBoxScoresResponse');

const enrichBoxScoresRoute = createRoute({
  method: 'post',
  path: '/admin/attending/enrich-boxscores',
  operationId: 'adminAttendingEnrichBoxScores',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Backfill MLB box score data into attended events',
  description:
    'Pulls MLB Stats API box score + live feed for each attended MLB game, upserts every player who played, writes per-player appearance rows with batting/pitching lines, and merges game-level extras (attendance, weather, linescore, decisions) into attended_events.event_data. Idempotent — by default skips events already enriched. Use `skip_enriched: false` to force re-enrichment.',
  request: {
    body: {
      content: { 'application/json': { schema: EnrichBoxScoresBody } },
      required: false,
    },
  },
  responses: {
    200: {
      description: 'Enrichment completed',
      content: { 'application/json': { schema: EnrichBoxScoresResponse } },
    },
    ...errorResponses(401, 500),
  },
});

adminAttending.openapi(enrichBoxScoresRoute, async (c) => {
  const db = createDb(c.env.DB);
  type Opts = {
    game_pks?: number[];
    skip_enriched?: boolean;
    limit?: number;
    dry_run?: boolean;
  };
  const body: Opts = await c.req.json<Opts>().catch(() => ({}) as Opts);

  try {
    const { enrichAttendedBoxScores } =
      await import('../services/attending/enrich-boxscore.js');
    const result = await enrichAttendedBoxScores(db, {
      gamePks: body.game_pks,
      skipEnriched: body.skip_enriched ?? true,
      limit: body.limit ?? 100,
      dryRun: body.dry_run ?? false,
    });
    return c.json({
      status: 'completed' as const,
      scanned: result.scanned,
      enriched: result.enriched,
      players_inserted: result.players_inserted,
      players_updated: result.players_updated,
      appearances_inserted: result.appearances_inserted,
      appearances_updated: result.appearances_updated,
      failures: result.failures,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[ERROR] POST /admin/attending/enrich-boxscores: ${message}`);
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// ─── POST /v1/admin/attending/enrich-player-photos ──────────────────

const EnrichPlayerPhotosBody = z
  .object({
    player_ids: z.array(z.number().int()).optional(),
    skip_existing: z.boolean().optional().default(true),
    silo_only: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(2000).optional().default(1000),
  })
  .openapi('AttendingEnrichPlayerPhotosBody');

const EnrichPlayerPhotosResponse = z
  .object({
    status: z.literal('completed'),
    scanned: z.number().int(),
    silo_inserted: z.number().int(),
    silo_skipped: z.number().int(),
    silo_failed: z.number().int(),
    full_inserted: z.number().int(),
    full_skipped: z.number().int(),
    full_failed: z.number().int(),
    failures: z.array(
      z.object({ player_id: z.number().int(), reason: z.string() })
    ),
  })
  .openapi('AttendingEnrichPlayerPhotosResponse');

const enrichPlayerPhotosRoute = createRoute({
  method: 'post',
  path: '/admin/attending/enrich-player-photos',
  operationId: 'adminAttendingEnrichPlayerPhotos',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Backfill player photos through the image pipeline',
  description:
    "Fetches the MLB silo cutout for every player and the ESPN full-body PNG when an espn_id is known. Stores both via the existing image pipeline (R2 + thumbhash + dominant_color) keyed on (domain='attending', entity_type='player_silo'|'player_full'). Idempotent.",
  request: {
    body: {
      content: { 'application/json': { schema: EnrichPlayerPhotosBody } },
      required: false,
    },
  },
  responses: {
    200: {
      description: 'Photo backfill completed',
      content: {
        'application/json': { schema: EnrichPlayerPhotosResponse },
      },
    },
    ...errorResponses(401, 500),
  },
});

adminAttending.openapi(enrichPlayerPhotosRoute, async (c) => {
  const db = createDb(c.env.DB);
  type Opts = {
    player_ids?: number[];
    skip_existing?: boolean;
    silo_only?: boolean;
    limit?: number;
  };
  const body: Opts = await c.req.json<Opts>().catch(() => ({}) as Opts);

  try {
    const { enrichPlayerPhotos } =
      await import('../services/attending/enrich-player-photos.js');
    const result = await enrichPlayerPhotos(db, c.env, {
      playerIds: body.player_ids,
      skipExisting: body.skip_existing ?? true,
      siloOnly: body.silo_only ?? false,
      limit: body.limit ?? 1000,
    });
    return c.json({ status: 'completed' as const, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `[ERROR] POST /admin/attending/enrich-player-photos: ${message}`
    );
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// ─── POST /v1/admin/attending/enrich-espn-ids ───────────────────────

const EnrichEspnIdsBody = z
  .object({
    event_ids: z.array(z.number().int()).optional(),
    limit: z.number().int().min(1).max(500).optional().default(100),
  })
  .openapi('AttendingEnrichEspnIdsBody');

const EnrichEspnIdsResponse = z
  .object({
    status: z.literal('completed'),
    scanned_events: z.number().int(),
    matched_events: z.number().int(),
    resolved_player_ids: z.number().int(),
    failures: z.array(
      z.object({ event_id: z.number().int(), reason: z.string() })
    ),
  })
  .openapi('AttendingEnrichEspnIdsResponse');

const enrichEspnIdsRoute = createRoute({
  method: 'post',
  path: '/admin/attending/enrich-espn-ids',
  operationId: 'adminAttendingEnrichEspnIds',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Resolve ESPN player IDs via game summaries',
  description:
    'For each attended MLB game, hits ESPN’s schedule + summary endpoints, walks the box score, and matches each ESPN athlete to an MLB player by last_name + jersey to populate players.espn_id. Run before enrich-player-photos to unlock the ESPN full-body photo variant.',
  request: {
    body: {
      content: { 'application/json': { schema: EnrichEspnIdsBody } },
      required: false,
    },
  },
  responses: {
    200: {
      description: 'ESPN ID cross-reference completed',
      content: {
        'application/json': { schema: EnrichEspnIdsResponse },
      },
    },
    ...errorResponses(401, 500),
  },
});

adminAttending.openapi(enrichEspnIdsRoute, async (c) => {
  const db = createDb(c.env.DB);
  type Opts = { event_ids?: number[]; limit?: number };
  const body: Opts = await c.req.json<Opts>().catch(() => ({}) as Opts);

  try {
    const { enrichEspnIds } =
      await import('../services/attending/enrich-espn-ids.js');
    const result = await enrichEspnIds(db, {
      eventIds: body.event_ids,
      limit: body.limit ?? 100,
    });
    return c.json({ status: 'completed' as const, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[ERROR] POST /admin/attending/enrich-espn-ids: ${message}`);
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// ─── POST /v1/admin/attending/enrich-espn-ids-by-search ─────────────

const EnrichEspnIdsBySearchBody = z
  .object({
    limit: z.number().int().min(1).max(500).optional().default(500),
    throttle_ms: z.number().int().min(0).max(2000).optional().default(50),
  })
  .openapi('AttendingEnrichEspnIdsBySearchBody');

const EnrichEspnIdsBySearchResponse = z
  .object({
    status: z.literal('completed'),
    scanned: z.number().int(),
    resolved_unique: z.number().int(),
    resolved_disambiguated: z.number().int(),
    multi_unresolved: z.number().int(),
    zero_match: z.number().int(),
    collision_skipped: z.number().int(),
    errors: z.number().int(),
    failures: z.array(
      z.object({
        player_id: z.number().int(),
        name: z.string(),
        reason: z.string(),
      })
    ),
  })
  .openapi('AttendingEnrichEspnIdsBySearchResponse');

const enrichEspnIdsBySearchRoute = createRoute({
  method: 'post',
  path: '/admin/attending/enrich-espn-ids-by-search',
  operationId: 'adminAttendingEnrichEspnIdsBySearch',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Resolve ESPN player IDs via name search',
  description:
    'For every players row missing espn_id, hits ESPN site search and disambiguates by position class when a name returns multiple MLB hits. Complements enrich-espn-ids (game-summary scoped) by catching relief pitchers and bench players who do not appear in ESPN summary.athletes lists.',
  request: {
    body: {
      content: { 'application/json': { schema: EnrichEspnIdsBySearchBody } },
      required: false,
    },
  },
  responses: {
    200: {
      description: 'ESPN ID search resolution completed',
      content: {
        'application/json': { schema: EnrichEspnIdsBySearchResponse },
      },
    },
    ...errorResponses(401, 500),
  },
});

adminAttending.openapi(enrichEspnIdsBySearchRoute, async (c) => {
  const db = createDb(c.env.DB);
  type Opts = { limit?: number; throttle_ms?: number };
  const body: Opts = await c.req.json<Opts>().catch(() => ({}) as Opts);

  try {
    const { enrichEspnIdsBySearch } =
      await import('../services/attending/enrich-espn-ids-by-search.js');
    const result = await enrichEspnIdsBySearch(db, {
      limit: body.limit ?? 500,
      throttleMs: body.throttle_ms ?? 50,
    });
    return c.json({ status: 'completed' as const, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `[ERROR] POST /admin/attending/enrich-espn-ids-by-search: ${message}`
    );
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

// ─── POST /v1/admin/attending/backfill-feed ─────────────────────────

const BackfillFeedBody = z
  .object({
    limit: z.number().int().min(1).max(2000).optional().default(2000),
    dry_run: z.boolean().optional().default(false),
  })
  .openapi('AttendingBackfillFeedBody');

const BackfillFeedResponse = z
  .object({
    status: z.literal('completed'),
    scanned: z.number().int(),
    inserted: z.number().int(),
    skipped: z.number().int(),
  })
  .openapi('AttendingBackfillFeedResponse');

const backfillFeedRoute = createRoute({
  method: 'post',
  path: '/admin/attending/backfill-feed',
  operationId: 'adminAttendingBackfillFeed',
  'x-hidden': true,
  tags: ['Admin'],
  summary: 'Backfill activity_feed rows for existing attended events',
  description:
    'One-shot backfill: walks `attended_events`, builds an activity-feed row for each, and inserts via the standard cross-domain insert path. Idempotent — feed-side dedupe on (domain, source_id) means re-running is safe. Used once on PR rollout to populate historical events; new events get feed rows automatically via loadCanonicalEvent.',
  request: {
    body: {
      content: { 'application/json': { schema: BackfillFeedBody } },
      required: false,
    },
  },
  responses: {
    200: {
      description: 'Backfill completed',
      content: { 'application/json': { schema: BackfillFeedResponse } },
    },
    ...errorResponses(401, 500),
  },
});

adminAttending.openapi(backfillFeedRoute, async (c) => {
  const db = createDb(c.env.DB);
  type Opts = { limit?: number; dry_run?: boolean };
  const body: Opts = await c.req.json<Opts>().catch(() => ({}) as Opts);

  try {
    const { backfillAttendingFeed } =
      await import('../services/attending/backfill-feed.js');
    const result = await backfillAttendingFeed(db, {
      limit: body.limit ?? 2000,
      dryRun: body.dry_run ?? false,
    });
    return c.json({ status: 'completed' as const, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[ERROR] POST /admin/attending/backfill-feed: ${message}`);
    return c.json({ error: message, status: 500 }, 500) as any;
  }
});

export default adminAttending;
