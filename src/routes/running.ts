import { createRoute, z } from '@hono/zod-openapi';
import { eq, desc, asc, and, sql, gte, lte } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { setCache } from '../lib/cache.js';
import { DateFilterQuery, buildDateCondition } from '../lib/date-filters.js';
import { notFound, badRequest } from '../lib/errors.js';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses } from '../lib/schemas/common.js';
import {
  stravaActivities,
  stravaSplits,
  stravaGear,
  stravaPersonalRecords,
  stravaYearSummaries,
  stravaLifetimeStats,
} from '../db/schema/strava.js';
import {
  formatTotalDuration,
  formatDuration,
  formatPace,
  getWorkoutTypeLabel,
  calculateEddington,
} from '../services/strava/transforms.js';

const running = createOpenAPIApp();

// --- Schemas ---

const LifetimeStatsSchema = z.object({
  total_runs: z.number(),
  total_distance_mi: z.number(),
  total_elevation_ft: z.number(),
  total_duration: z.string(),
  avg_pace: z.string().nullable(),
  years_active: z.number(),
  first_run: z.string().nullable(),
  eddington_number: z.number(),
});

const YearSummarySchema = z.object({
  year: z.number(),
  total_runs: z.number(),
  total_distance_mi: z.number(),
  total_elevation_ft: z.number(),
  total_duration_s: z.number(),
  avg_pace: z.string().nullable(),
  longest_run_mi: z.number(),
  race_count: z.number(),
});

const PersonalRecordSchema = z.object({
  distance: z.string(),
  distance_label: z.string(),
  time: z.string(),
  time_s: z.number(),
  pace: z.string(),
  date: z.string(),
  activity_id: z.number(),
  activity_name: z.string(),
});

const ActivitySchema = z.object({
  id: z.number(),
  strava_id: z.number(),
  name: z.string(),
  date: z.string(),
  distance_mi: z.number(),
  duration: z.string(),
  duration_s: z.number(),
  pace: z.string(),
  elevation_ft: z.number(),
  heartrate_avg: z.number().nullable(),
  heartrate_max: z.number().nullable(),
  cadence: z.number().nullable(),
  calories: z.number().nullable(),
  suffer_score: z.number().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  polyline: z.string().nullable(),
  is_race: z.boolean(),
  workout_type: z.string(),
  strava_url: z.string().nullable(),
});

const SplitSchema = z.object({
  split: z.number(),
  distance_mi: z.number(),
  moving_time_s: z.number(),
  elapsed_time_s: z.number(),
  elevation_ft: z.number(),
  pace: z.string(),
  heartrate: z.number().nullable(),
});

const GearSchema = z.object({
  id: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  distance_mi: z.number(),
  is_retired: z.boolean(),
  activity_count: z.number(),
});

const CalendarDaySchema = z.object({
  date: z.string(),
  count: z.number(),
  total_distance_mi: z.number(),
});

const CumulativePointSchema = z.object({
  day: z.number(),
  cumulative_mi: z.number(),
});

const PaceTrendPointSchema = z.object({
  date: z.string(),
  pace: z.string(),
  pace_min_per_mile: z.number(),
  rolling_avg: z.string(),
  rolling_avg_min_per_mile: z.number(),
});

const TimeOfDaySchema = z.object({
  hour: z.number(),
  count: z.number(),
});

const ElevationPointSchema = z.object({
  date: z.string(),
  elevation_ft: z.number(),
  distance_mi: z.number(),
  cumulative_elevation_ft: z.number(),
});

const CitySchema = z.object({
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  run_count: z.number(),
  total_distance_mi: z.number(),
});

const StreaksSchema = z.object({
  current: z.object({
    days: z.number(),
    start: z.string().nullable(),
    end: z.string().nullable(),
  }),
  longest: z.object({
    days: z.number(),
    start: z.string().nullable(),
    end: z.string().nullable(),
  }),
});

const EddingtonSchema = z.object({
  number: z.number(),
  explanation: z.string(),
  progress: z.object({
    target: z.number(),
    days_completed: z.number(),
    runs_needed: z.number(),
  }),
});

const MonthlyBreakdownSchema = z.object({
  month: z.string(),
  runs: z.number(),
  distance_mi: z.number(),
  duration_s: z.number(),
  elevation_ft: z.number(),
});

const YearInReviewSchema = z.object({
  year: z.number(),
  total_runs: z.number(),
  total_distance_mi: z.number(),
  total_elevation_ft: z.number(),
  total_duration_s: z.number(),
  avg_pace: z.string(),
  longest_run_mi: z.number(),
  race_count: z.number(),
  monthly: z.array(MonthlyBreakdownSchema),
  top_runs: z.array(ActivitySchema),
});

const PaginationMeta = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  total_pages: z.number(),
});

const YearParamSchema = z.object({
  year: z.string(),
});

const IdParamSchema = z.object({
  id: z.string(),
});

// --- Routes ---

// GET /v1/running/stats
const statsRoute = createRoute({
  method: 'get',
  path: '/stats',
  operationId: 'getRunningStats',
  tags: ['Running'],
  summary: 'Running stats',
  description: 'Returns aggregate lifetime running statistics.',
  responses: {
    200: {
      description: 'Lifetime stats',
      content: {
        'application/json': {
          schema: z.object({ data: LifetimeStatsSchema }),
          example: {
            data: {
              total_runs: 1350,
              total_distance_mi: 6069.88,
              total_elevation_ft: 238690.03,
              total_duration: '828:56:08',
              avg_pace: '8:12/mi',
              years_active: 17,
              first_run: '2010-09-10T17:24:19.000Z',
              eddington_number: 11,
            },
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

running.openapi(statsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const [stats] = await db
    .select()
    .from(stravaLifetimeStats)
    .where(eq(stravaLifetimeStats.userId, 1))
    .limit(1);

  if (!stats) {
    return c.json({
      data: {
        total_runs: 0,
        total_distance_mi: 0,
        total_elevation_ft: 0,
        total_duration: '0:00:00',
        avg_pace: '0:00/mi',
        years_active: 0,
        first_run: null,
        eddington_number: 0,
      },
    });
  }

  return c.json({
    data: {
      total_runs: stats.totalRuns,
      total_distance_mi: stats.totalDistanceMiles,
      total_elevation_ft: stats.totalElevationFeet,
      total_duration: formatTotalDuration(stats.totalDurationSeconds),
      avg_pace: stats.avgPaceFormatted,
      years_active: stats.yearsActive,
      first_run: stats.firstRun,
      eddington_number: stats.eddingtonNumber,
    },
  });
});

// GET /v1/running/stats/years
const statsYearsRoute = createRoute({
  method: 'get',
  path: '/stats/years',
  operationId: 'listRunningStatsYears',
  tags: ['Running'],
  summary: 'All year summaries',
  description: 'Returns running summaries for all years.',
  responses: {
    200: {
      description: 'Year summaries',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(YearSummarySchema) }),
          example: {
            data: [
              {
                year: 2025,
                total_runs: 120,
                total_distance_mi: 540.2,
                total_elevation_ft: 18500,
                total_duration_s: 257400,
                avg_pace: '7:55/mi',
                longest_run_mi: 13.1,
                race_count: 3,
              },
              {
                year: 2024,
                total_runs: 105,
                total_distance_mi: 470.8,
                total_elevation_ft: 15200,
                total_duration_s: 231600,
                avg_pace: '8:10/mi',
                longest_run_mi: 10.5,
                race_count: 2,
              },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

running.openapi(statsYearsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const years = await db
    .select()
    .from(stravaYearSummaries)
    .where(eq(stravaYearSummaries.userId, 1))
    .orderBy(desc(stravaYearSummaries.year));

  return c.json({
    data: years.map((y) => ({
      year: y.year,
      total_runs: y.totalRuns,
      total_distance_mi: y.totalDistanceMiles,
      total_elevation_ft: y.totalElevationFeet,
      total_duration_s: y.totalDurationSeconds,
      avg_pace: y.avgPaceFormatted,
      longest_run_mi: y.longestRunMiles,
      race_count: y.raceCount,
    })),
  });
});

// GET /v1/running/stats/years/:year
const statsYearRoute = createRoute({
  method: 'get',
  path: '/stats/years/{year}',
  operationId: 'getRunningStatsYear',
  tags: ['Running'],
  summary: 'Single year summary',
  description: 'Returns running summary for a specific year.',
  request: {
    params: YearParamSchema,
  },
  responses: {
    200: {
      description: 'Year summary',
      content: {
        'application/json': {
          schema: z.object({ data: YearSummarySchema }),
          example: {
            data: {
              year: 2025,
              total_runs: 120,
              total_distance_mi: 540.2,
              total_elevation_ft: 18500,
              total_duration_s: 257400,
              avg_pace: '7:55/mi',
              longest_run_mi: 13.1,
              race_count: 3,
            },
          },
        },
      },
    },
    ...errorResponses(400, 401, 404),
  },
});

running.openapi(statsYearRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const year = parseInt(c.req.param('year'), 10);

  if (isNaN(year)) {
    return badRequest(c, 'Invalid year') as any;
  }

  const [summary] = await db
    .select()
    .from(stravaYearSummaries)
    .where(
      and(eq(stravaYearSummaries.userId, 1), eq(stravaYearSummaries.year, year))
    )
    .limit(1);

  if (!summary) {
    return notFound(c, `No data for year ${year}`) as any;
  }

  return c.json({
    data: {
      year: summary.year,
      total_runs: summary.totalRuns,
      total_distance_mi: summary.totalDistanceMiles,
      total_elevation_ft: summary.totalElevationFeet,
      total_duration_s: summary.totalDurationSeconds,
      avg_pace: summary.avgPaceFormatted,
      longest_run_mi: summary.longestRunMiles,
      race_count: summary.raceCount,
    },
  });
});

// GET /v1/running/prs
const prsRoute = createRoute({
  method: 'get',
  path: '/prs',
  operationId: 'getRunningPRs',
  tags: ['Running'],
  summary: 'Personal records',
  description: 'Returns personal records for standard race distances.',
  responses: {
    200: {
      description: 'Personal records',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(PersonalRecordSchema) }),
          example: {
            data: [
              {
                distance: '5K',
                distance_label: '5K',
                time: '22:45',
                time_s: 1365,
                pace: '7:20/mi',
                date: '2024-09-15',
                activity_id: 12345,
                activity_name: 'Fall 5K Race',
              },
              {
                distance: '10K',
                distance_label: '10K',
                time: '48:30',
                time_s: 2910,
                pace: '7:49/mi',
                date: '2024-06-01',
                activity_id: 12346,
                activity_name: 'Summer 10K',
              },
              {
                distance: 'Half Marathon',
                distance_label: 'Half Marathon',
                time: '1:45:00',
                time_s: 6300,
                pace: '8:01/mi',
                date: '2023-10-08',
                activity_id: 12347,
                activity_name: 'Portland Half Marathon',
              },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

running.openapi(prsRoute, async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);

  const prs = await db
    .select()
    .from(stravaPersonalRecords)
    .where(eq(stravaPersonalRecords.userId, 1));

  return c.json({
    data: prs.map((pr) => ({
      distance: pr.distance,
      distance_label: pr.distanceLabel,
      time: pr.timeFormatted,
      time_s: pr.timeSeconds,
      pace: pr.paceFormatted,
      date: pr.date,
      activity_id: pr.activityStravaId,
      activity_name: pr.activityName,
    })),
  });
});

// GET /v1/running/recent
const recentRoute = createRoute({
  method: 'get',
  path: '/recent',
  operationId: 'getRunningRecent',
  tags: ['Running'],
  summary: 'Latest runs',
  description:
    'Returns the last N activities (default 5, max 20). Supports date filtering via date, from, and to params.',
  request: {
    query: z
      .object({
        limit: z.coerce.number().int().min(1).max(20).optional().default(5),
      })
      .merge(DateFilterQuery),
  },
  responses: {
    200: {
      description: 'Recent activities',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(ActivitySchema) }),
          example: {
            data: [
              {
                id: 17748681520,
                strava_id: 17748681520,
                name: 'Monday Evening Run',
                date: '2026-03-16T17:00:05Z',
                distance_mi: 4.49,
                duration: '36:02',
                duration_s: 2162,
                pace: '8:02/mi',
                elevation_ft: 370.73,
                heartrate_avg: null,
                heartrate_max: null,
                cadence: 75.2,
                calories: 525,
                suffer_score: null,
                city: null,
                state: null,
                polyline: '_wfbHb|niVD_@TEd@...',
                is_race: false,
                workout_type: 'default',
                strava_url: 'https://www.strava.com/activities/17748681520',
              },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

running.openapi(recentRoute, async (c) => {
  setCache(c, 'realtime');
  const db = createDb(c.env.DB);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '5', 10), 20);

  const dateCondition = buildDateCondition(stravaActivities.startDate, {
    date: c.req.query('date'),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });

  const activities = await db
    .select()
    .from(stravaActivities)
    .where(and(eq(stravaActivities.isDeleted, 0), dateCondition))
    .orderBy(desc(stravaActivities.startDate))
    .limit(limit);

  return c.json({
    data: activities.map(formatActivityResponse),
  });
});

// GET /v1/running/activities
const activitiesRoute = createRoute({
  method: 'get',
  path: '/activities',
  operationId: 'listRunningActivities',
  tags: ['Running'],
  summary: 'List activities',
  description: 'Returns a paginated, filterable list of running activities.',
  request: {
    query: z
      .object({
        page: z.coerce.number().int().min(1).optional().default(1),
        limit: z.coerce.number().int().min(1).max(100).optional().default(20),
        year: z.string().optional(),
        type: z.string().optional(),
        city: z.string().optional(),
        min_distance: z.string().optional(),
        max_distance: z.string().optional(),
        sort: z.string().optional().default('date'),
        order: z.string().optional().default('desc'),
      })
      .merge(DateFilterQuery),
  },
  responses: {
    200: {
      description: 'Paginated activity list',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(ActivitySchema),
            pagination: PaginationMeta,
          }),
          example: {
            data: [
              {
                id: 17748681520,
                strava_id: 17748681520,
                name: 'Monday Evening Run',
                date: '2026-03-16T17:00:05Z',
                distance_mi: 4.49,
                duration: '36:02',
                duration_s: 2162,
                pace: '8:02/mi',
                elevation_ft: 370.73,
                heartrate_avg: null,
                heartrate_max: null,
                cadence: 75.2,
                calories: 525,
                suffer_score: null,
                city: null,
                state: null,
                polyline: '_wfbHb|niVD_@TEd@...',
                is_race: false,
                workout_type: 'default',
                strava_url: 'https://www.strava.com/activities/17748681520',
              },
            ],
            pagination: {
              page: 1,
              limit: 20,
              total: 1350,
              total_pages: 68,
            },
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

running.openapi(activitiesRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(
    Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)),
    100
  );
  const year = c.req.query('year');
  const type = c.req.query('type');
  const city = c.req.query('city');
  const minDistance = c.req.query('min_distance');
  const maxDistance = c.req.query('max_distance');
  const sort = c.req.query('sort') ?? 'date';
  const order = c.req.query('order') ?? 'desc';

  const conditions = [eq(stravaActivities.isDeleted, 0)];

  // date/from/to takes precedence over year
  const dateCondition = buildDateCondition(stravaActivities.startDateLocal, {
    date: c.req.query('date'),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });

  if (dateCondition) {
    conditions.push(dateCondition);
  } else if (year) {
    const yearNum = parseInt(year, 10);
    conditions.push(
      gte(stravaActivities.startDateLocal, `${yearNum}-01-01T00:00:00`),
      lte(stravaActivities.startDateLocal, `${yearNum}-12-31T23:59:59`)
    );
  }

  if (type) {
    const workoutTypeMap: Record<string, number> = {
      race: 1,
      long_run: 2,
      workout: 3,
      default: 0,
    };
    const wt = workoutTypeMap[type];
    if (wt !== undefined) {
      conditions.push(eq(stravaActivities.workoutType, wt));
    }
  }

  if (city) {
    conditions.push(eq(stravaActivities.city, city));
  }

  if (minDistance) {
    conditions.push(
      gte(stravaActivities.distanceMiles, parseFloat(minDistance))
    );
  }

  if (maxDistance) {
    conditions.push(
      lte(stravaActivities.distanceMiles, parseFloat(maxDistance))
    );
  }

  const sortColumn = (() => {
    switch (sort) {
      case 'distance':
        return stravaActivities.distanceMiles;
      case 'duration':
        return stravaActivities.movingTimeSeconds;
      case 'pace':
        return stravaActivities.paceMinPerMile;
      case 'elevation':
        return stravaActivities.totalElevationGainFeet;
      default:
        return stravaActivities.startDate;
    }
  })();

  const orderFn = order === 'asc' ? asc : desc;

  const whereClause = and(...conditions);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(stravaActivities)
    .where(whereClause);

  const total = countResult?.count ?? 0;
  const offset = (page - 1) * limit;

  const activities = await db
    .select()
    .from(stravaActivities)
    .where(whereClause)
    .orderBy(orderFn(sortColumn))
    .limit(limit)
    .offset(offset);

  return c.json({
    data: activities.map(formatActivityResponse),
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
    },
  });
});

// GET /v1/running/activities/:id
const activityDetailRoute = createRoute({
  method: 'get',
  path: '/activities/{id}',
  operationId: 'getRunningActivity',
  tags: ['Running'],
  summary: 'Activity detail',
  description: 'Returns a single activity by Strava ID.',
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: 'Activity detail',
      content: {
        'application/json': {
          schema: ActivitySchema,
          example: {
            id: 17748681520,
            strava_id: 17748681520,
            name: 'Monday Evening Run',
            date: '2026-03-16T17:00:05Z',
            distance_mi: 4.49,
            duration: '36:02',
            duration_s: 2162,
            pace: '8:02/mi',
            elevation_ft: 370.73,
            heartrate_avg: null,
            heartrate_max: null,
            cadence: 75.2,
            calories: 525,
            suffer_score: null,
            city: null,
            state: null,
            polyline: '_wfbHb|niVD_@TEd@...',
            is_race: false,
            workout_type: 'default',
            strava_url: 'https://www.strava.com/activities/17748681520',
          },
        },
      },
    },
    ...errorResponses(400, 401, 404),
  },
});

running.openapi(activityDetailRoute, async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'), 10);

  if (isNaN(id)) {
    return badRequest(c, 'Invalid activity ID') as any;
  }

  const [activity] = await db
    .select()
    .from(stravaActivities)
    .where(
      and(eq(stravaActivities.stravaId, id), eq(stravaActivities.isDeleted, 0))
    )
    .limit(1);

  if (!activity) {
    return notFound(c, 'Activity not found') as any;
  }

  return c.json(formatActivityResponse(activity));
});

// GET /v1/running/activities/:id/splits
const splitsRoute = createRoute({
  method: 'get',
  path: '/activities/{id}/splits',
  operationId: 'getRunningActivitySplits',
  tags: ['Running'],
  summary: 'Activity splits',
  description: 'Returns per-mile splits for a specific activity.',
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: 'Split list',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(SplitSchema) }),
          example: {
            data: [
              {
                split: 1,
                distance_mi: 1.0,
                moving_time_s: 495,
                elapsed_time_s: 500,
                elevation_ft: 85,
                pace: '8:15/mi',
                heartrate: null,
              },
              {
                split: 2,
                distance_mi: 1.0,
                moving_time_s: 470,
                elapsed_time_s: 475,
                elevation_ft: 120,
                pace: '7:50/mi',
                heartrate: null,
              },
              {
                split: 3,
                distance_mi: 1.0,
                moving_time_s: 482,
                elapsed_time_s: 488,
                elevation_ft: 95,
                pace: '8:02/mi',
                heartrate: null,
              },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401, 404),
  },
});

running.openapi(splitsRoute, async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'), 10);

  if (isNaN(id)) {
    return badRequest(c, 'Invalid activity ID') as any;
  }

  const splits = await db
    .select()
    .from(stravaSplits)
    .where(eq(stravaSplits.activityStravaId, id))
    .orderBy(asc(stravaSplits.splitNumber));

  if (splits.length === 0) {
    return notFound(c, 'No splits found for this activity') as any;
  }

  return c.json({
    data: splits.map((s) => ({
      split: s.splitNumber,
      distance_mi: s.distanceMiles,
      moving_time_s: s.movingTimeSeconds,
      elapsed_time_s: s.elapsedTimeSeconds,
      elevation_ft: s.elevationDifferenceFeet,
      pace: s.paceFormatted,
      heartrate: s.averageHeartrate,
    })),
  });
});

// GET /v1/running/gear
const gearRoute = createRoute({
  method: 'get',
  path: '/gear',
  operationId: 'listRunningGear',
  tags: ['Running'],
  summary: 'Gear list',
  description: 'Returns all gear/shoes with activity counts.',
  responses: {
    200: {
      description: 'Gear list',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(GearSchema) }),
          example: {
            data: [
              {
                id: 'g12345',
                name: 'Nike Pegasus 40',
                brand: 'Nike',
                model: 'Pegasus 40',
                distance_mi: 342.5,
                is_retired: false,
                activity_count: 85,
              },
              {
                id: 'g12346',
                name: 'Brooks Ghost 15',
                brand: 'Brooks',
                model: 'Ghost 15',
                distance_mi: 512.3,
                is_retired: true,
                activity_count: 130,
              },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

running.openapi(gearRoute, async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);

  const gear = await db
    .select()
    .from(stravaGear)
    .where(eq(stravaGear.userId, 1))
    .orderBy(desc(stravaGear.distanceMiles));

  // Count activities per gear
  const gearWithCounts = await Promise.all(
    gear.map(async (g) => {
      const [countResult] = await db
        .select({ count: sql<number>`count(*)` })
        .from(stravaActivities)
        .where(
          and(
            eq(stravaActivities.gearId, g.stravaGearId),
            eq(stravaActivities.isDeleted, 0)
          )
        );

      return {
        id: g.stravaGearId,
        name: g.name,
        brand: g.brand,
        model: g.model,
        distance_mi: g.distanceMiles,
        is_retired: g.isRetired === 1,
        activity_count: countResult?.count ?? 0,
      };
    })
  );

  return c.json({ data: gearWithCounts });
});

// GET /v1/running/calendar
const calendarRoute = createRoute({
  method: 'get',
  path: '/calendar',
  operationId: 'getRunningCalendar',
  tags: ['Running'],
  summary: 'Activity calendar',
  description: 'Returns daily activity heatmap data for a given year.',
  request: {
    query: z.object({
      year: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Calendar data',
      content: {
        'application/json': {
          schema: z.object({
            year: z.number(),
            data: z.array(CalendarDaySchema),
          }),
          example: {
            year: 2026,
            data: [
              { date: '2026-03-01', count: 1, total_distance_mi: 5.2 },
              { date: '2026-03-03', count: 1, total_distance_mi: 4.1 },
              { date: '2026-03-05', count: 1, total_distance_mi: 6.8 },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

running.openapi(calendarRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const year = c.req.query('year') ?? String(new Date().getFullYear());
  const yearNum = parseInt(year, 10);

  const activities = await db
    .select({
      date: stravaActivities.startDateLocal,
      distance: stravaActivities.distanceMiles,
    })
    .from(stravaActivities)
    .where(
      and(
        eq(stravaActivities.isDeleted, 0),
        gte(stravaActivities.startDateLocal, `${yearNum}-01-01T00:00:00`),
        lte(stravaActivities.startDateLocal, `${yearNum}-12-31T23:59:59`)
      )
    )
    .orderBy(asc(stravaActivities.startDateLocal));

  // Group by date
  const byDate = new Map<
    string,
    { count: number; total_distance_mi: number }
  >();
  for (const a of activities) {
    const date = a.date.substring(0, 10);
    const existing = byDate.get(date) ?? {
      count: 0,
      total_distance_mi: 0,
    };
    existing.count++;
    existing.total_distance_mi =
      Math.round((existing.total_distance_mi + a.distance) * 100) / 100;
    byDate.set(date, existing);
  }

  const data = [...byDate.entries()].map(([date, info]) => ({
    date,
    ...info,
  }));

  return c.json({ year: yearNum, data });
});

// GET /v1/running/charts/cumulative
const cumulativeRoute = createRoute({
  method: 'get',
  path: '/charts/cumulative',
  operationId: 'getRunningChartsCumulative',
  tags: ['Running'],
  summary: 'Cumulative distance chart',
  description: 'Returns year-over-year cumulative distance data for charting.',
  request: {
    query: z.object({
      years: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Cumulative distance by year',
      content: {
        'application/json': {
          schema: z.object({
            data: z.record(z.string(), z.array(CumulativePointSchema)),
          }),
          example: {
            data: {
              '2026': [
                { day: 1, cumulative_mi: 5.2 },
                { day: 3, cumulative_mi: 9.3 },
                { day: 5, cumulative_mi: 16.1 },
              ],
              '2025': [
                { day: 2, cumulative_mi: 4.8 },
                { day: 5, cumulative_mi: 12.6 },
              ],
            },
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

running.openapi(cumulativeRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const yearsParam = c.req.query('years');
  const currentYear = new Date().getFullYear();
  const requestedYears = yearsParam
    ? yearsParam.split(',').map(Number)
    : [currentYear, currentYear - 1, currentYear - 2];

  const result: Record<
    number,
    Array<{ day: number; cumulative_mi: number }>
  > = {};

  for (const year of requestedYears) {
    const activities = await db
      .select({
        date: stravaActivities.startDateLocal,
        distance: stravaActivities.distanceMiles,
      })
      .from(stravaActivities)
      .where(
        and(
          eq(stravaActivities.isDeleted, 0),
          gte(stravaActivities.startDateLocal, `${year}-01-01T00:00:00`),
          lte(stravaActivities.startDateLocal, `${year}-12-31T23:59:59`)
        )
      )
      .orderBy(asc(stravaActivities.startDateLocal));

    let cumulative = 0;
    const yearStart = new Date(`${year}-01-01`).getTime();
    const points: Array<{ day: number; cumulative_mi: number }> = [];

    for (const a of activities) {
      const dayOfYear =
        Math.floor(
          (new Date(a.date.substring(0, 10)).getTime() - yearStart) / 86400000
        ) + 1;
      cumulative = Math.round((cumulative + a.distance) * 100) / 100;
      points.push({ day: dayOfYear, cumulative_mi: cumulative });
    }

    result[year] = points;
  }

  return c.json({ data: result });
});

// GET /v1/running/charts/pace-trend
const paceTrendRoute = createRoute({
  method: 'get',
  path: '/charts/pace-trend',
  operationId: 'getRunningChartsPaceTrend',
  tags: ['Running'],
  summary: 'Pace trend chart',
  description: 'Returns pace over time with a rolling weighted average.',
  request: {
    query: z.object({
      window: z.coerce.number().int().optional().default(30),
      from: z.string().optional(),
      to: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Pace trend data',
      content: {
        'application/json': {
          schema: z.object({
            window: z.number(),
            data: z.array(PaceTrendPointSchema),
          }),
          example: {
            window: 30,
            data: [
              {
                date: '2026-03-01',
                pace: '8:02/mi',
                pace_min_per_mile: 8.03,
                rolling_avg: '8:05/mi',
                rolling_avg_min_per_mile: 8.08,
              },
              {
                date: '2026-03-03',
                pace: '8:15/mi',
                pace_min_per_mile: 8.25,
                rolling_avg: '8:07/mi',
                rolling_avg_min_per_mile: 8.12,
              },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

running.openapi(paceTrendRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const window = parseInt(c.req.query('window') ?? '30', 10);
  const from = c.req.query('from');
  const to = c.req.query('to');

  const conditions = [
    eq(stravaActivities.isDeleted, 0),
    sql`${stravaActivities.paceMinPerMile} IS NOT NULL`,
  ];

  if (from) conditions.push(gte(stravaActivities.startDateLocal, from));
  if (to) conditions.push(lte(stravaActivities.startDateLocal, to));

  const activities = await db
    .select({
      date: stravaActivities.startDateLocal,
      pace: stravaActivities.paceMinPerMile,
      distance: stravaActivities.distanceMiles,
    })
    .from(stravaActivities)
    .where(and(...conditions))
    .orderBy(asc(stravaActivities.startDateLocal));

  // Compute rolling average
  const points: Array<{
    date: string;
    pace: string;
    pace_min_per_mile: number;
    rolling_avg: string;
    rolling_avg_min_per_mile: number;
  }> = [];

  for (let i = 0; i < activities.length; i++) {
    const a = activities[i];
    if (a.pace === null) continue;

    // Rolling average over the last `window` activities
    const windowStart = Math.max(0, i - window + 1);
    const windowActivities = activities.slice(windowStart, i + 1);
    const totalWeightedPace = windowActivities.reduce(
      (sum, w) => sum + (w.pace ?? 0) * w.distance,
      0
    );
    const totalDistance = windowActivities.reduce(
      (sum, w) => sum + w.distance,
      0
    );
    const rollingAvg =
      totalDistance > 0 ? totalWeightedPace / totalDistance : a.pace;

    points.push({
      date: a.date.substring(0, 10),
      pace: formatPace(a.pace),
      pace_min_per_mile: Math.round(a.pace * 100) / 100,
      rolling_avg: formatPace(rollingAvg),
      rolling_avg_min_per_mile: Math.round(rollingAvg * 100) / 100,
    });
  }

  return c.json({ window, data: points });
});

// GET /v1/running/charts/time-of-day
const timeOfDayRoute = createRoute({
  method: 'get',
  path: '/charts/time-of-day',
  operationId: 'getRunningChartsTimeOfDay',
  tags: ['Running'],
  summary: 'Time of day chart',
  description: 'Returns run frequency by hour of day.',
  request: {
    query: z.object({
      year: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Time of day distribution',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(TimeOfDaySchema) }),
          example: {
            data: [
              { hour: 6, count: 45 },
              { hour: 7, count: 82 },
              { hour: 17, count: 120 },
              { hour: 18, count: 95 },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

running.openapi(timeOfDayRoute, async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);
  const year = c.req.query('year');

  const conditions = [eq(stravaActivities.isDeleted, 0)];
  if (year) {
    const yearNum = parseInt(year, 10);
    conditions.push(
      gte(stravaActivities.startDateLocal, `${yearNum}-01-01T00:00:00`),
      lte(stravaActivities.startDateLocal, `${yearNum}-12-31T23:59:59`)
    );
  }

  const activities = await db
    .select({ date: stravaActivities.startDateLocal })
    .from(stravaActivities)
    .where(and(...conditions));

  // Count by hour
  const hourCounts = new Array(24).fill(0) as number[];
  for (const a of activities) {
    const hour = parseInt(a.date.substring(11, 13), 10);
    if (!isNaN(hour)) hourCounts[hour]++;
  }

  return c.json({
    data: hourCounts.map((count, hour) => ({ hour, count })),
  });
});

// GET /v1/running/charts/elevation
const elevationRoute = createRoute({
  method: 'get',
  path: '/charts/elevation',
  operationId: 'getRunningChartsElevation',
  tags: ['Running'],
  summary: 'Elevation chart',
  description: 'Returns elevation data with cumulative totals.',
  request: {
    query: z.object({
      year: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Elevation data',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(ElevationPointSchema) }),
          example: {
            data: [
              {
                date: '2026-03-01',
                elevation_ft: 350,
                distance_mi: 5.2,
                cumulative_elevation_ft: 350,
              },
              {
                date: '2026-03-03',
                elevation_ft: 280,
                distance_mi: 4.1,
                cumulative_elevation_ft: 630,
              },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

running.openapi(elevationRoute, async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);
  const year = c.req.query('year');

  const conditions = [eq(stravaActivities.isDeleted, 0)];
  if (year) {
    const yearNum = parseInt(year, 10);
    conditions.push(
      gte(stravaActivities.startDateLocal, `${yearNum}-01-01T00:00:00`),
      lte(stravaActivities.startDateLocal, `${yearNum}-12-31T23:59:59`)
    );
  }

  const activities = await db
    .select({
      date: stravaActivities.startDateLocal,
      elevation: stravaActivities.totalElevationGainFeet,
      distance: stravaActivities.distanceMiles,
    })
    .from(stravaActivities)
    .where(and(...conditions))
    .orderBy(asc(stravaActivities.startDateLocal));

  let cumulative = 0;
  const data = activities.map((a) => {
    cumulative = Math.round((cumulative + a.elevation) * 100) / 100;
    return {
      date: a.date.substring(0, 10),
      elevation_ft: a.elevation,
      distance_mi: a.distance,
      cumulative_elevation_ft: cumulative,
    };
  });

  return c.json({ data });
});

// GET /v1/running/cities
const citiesRoute = createRoute({
  method: 'get',
  path: '/cities',
  operationId: 'listRunningCities',
  tags: ['Running'],
  summary: 'Cities',
  description: 'Returns cities where runs occurred with counts and distances.',
  responses: {
    200: {
      description: 'City list',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(CitySchema) }),
          example: {
            data: [
              {
                city: 'Portland',
                state: 'OR',
                country: 'United States',
                run_count: 450,
                total_distance_mi: 1800,
              },
              {
                city: 'Seattle',
                state: 'WA',
                country: 'United States',
                run_count: 120,
                total_distance_mi: 480,
              },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

running.openapi(citiesRoute, async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);

  const cities = await db
    .select({
      city: stravaActivities.city,
      state: stravaActivities.state,
      country: stravaActivities.country,
      count: sql<number>`count(*)`,
      total_distance_mi: sql<number>`sum(${stravaActivities.distanceMiles})`,
    })
    .from(stravaActivities)
    .where(
      and(
        eq(stravaActivities.isDeleted, 0),
        sql`${stravaActivities.city} IS NOT NULL`
      )
    )
    .groupBy(
      stravaActivities.city,
      stravaActivities.state,
      stravaActivities.country
    )
    .orderBy(sql`count(*) DESC`);

  return c.json({
    data: cities.map((c) => ({
      city: c.city,
      state: c.state,
      country: c.country,
      run_count: c.count,
      total_distance_mi: Math.round((c.total_distance_mi ?? 0) * 100) / 100,
    })),
  });
});

// GET /v1/running/streaks
const streaksRoute = createRoute({
  method: 'get',
  path: '/streaks',
  operationId: 'getRunningStreaks',
  tags: ['Running'],
  summary: 'Running streaks',
  description: 'Returns current and longest running streaks.',
  responses: {
    200: {
      description: 'Streak data',
      content: {
        'application/json': {
          schema: z.object({ data: StreaksSchema }),
          example: {
            data: {
              current: { days: 0, start: null, end: null },
              longest: { days: 8, start: '2020-05-09', end: '2020-05-16' },
            },
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

running.openapi(streaksRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const [stats] = await db
    .select()
    .from(stravaLifetimeStats)
    .where(eq(stravaLifetimeStats.userId, 1))
    .limit(1);

  if (!stats) {
    return c.json({
      data: {
        current: { days: 0, start: null, end: null },
        longest: { days: 0, start: null, end: null },
      },
    });
  }

  return c.json({
    data: {
      current: {
        days: stats.currentStreakDays,
        start: stats.currentStreakStart,
        end: stats.currentStreakEnd,
      },
      longest: {
        days: stats.longestStreakDays,
        start: stats.longestStreakStart,
        end: stats.longestStreakEnd,
      },
    },
  });
});

// GET /v1/running/races
const racesRoute = createRoute({
  method: 'get',
  path: '/races',
  operationId: 'listRunningRaces',
  tags: ['Running'],
  summary: 'Race activities',
  description:
    'Returns all race activities, optionally filtered by distance category.',
  request: {
    query: z.object({
      distance: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Race list',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(ActivitySchema) }),
          example: {
            data: [
              {
                id: 12345,
                strava_id: 12345,
                name: 'Portland Marathon',
                date: '2024-10-06',
                distance_mi: 26.2,
                duration: '3:45:00',
                duration_s: 13500,
                pace: '8:35/mi',
                elevation_ft: 450,
                heartrate_avg: 165,
                heartrate_max: 182,
                cadence: 78.5,
                calories: 2800,
                suffer_score: 250,
                city: 'Portland',
                state: 'OR',
                polyline: null,
                is_race: true,
                workout_type: 'race',
                strava_url: 'https://www.strava.com/activities/12345',
              },
            ],
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

running.openapi(racesRoute, async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);
  const distanceFilter = c.req.query('distance');

  const conditions = [
    eq(stravaActivities.isDeleted, 0),
    eq(stravaActivities.isRace, 1),
  ];

  if (distanceFilter) {
    const distanceRanges: Record<string, [number, number]> = {
      '5k': [2.8, 3.5],
      '10k': [5.8, 6.8],
      half_marathon: [12.8, 13.5],
      marathon: [25.5, 27.0],
    };
    const range = distanceRanges[distanceFilter];
    if (range) {
      conditions.push(gte(stravaActivities.distanceMiles, range[0]));
      conditions.push(lte(stravaActivities.distanceMiles, range[1]));
    }
  }

  const races = await db
    .select()
    .from(stravaActivities)
    .where(and(...conditions))
    .orderBy(desc(stravaActivities.startDate));

  return c.json({
    data: races.map(formatActivityResponse),
  });
});

// GET /v1/running/eddington
const eddingtonRoute = createRoute({
  method: 'get',
  path: '/eddington',
  operationId: 'getRunningEddington',
  tags: ['Running'],
  summary: 'Eddington number',
  description:
    'Returns the Eddington number and progress toward the next target.',
  responses: {
    200: {
      description: 'Eddington data',
      content: {
        'application/json': {
          schema: EddingtonSchema,
          example: {
            number: 11,
            explanation: 'You have run at least 11 miles on at least 11 days',
            progress: { target: 12, days_completed: 9, runs_needed: 3 },
          },
        },
      },
    },
    ...errorResponses(401),
  },
});

running.openapi(eddingtonRoute, async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);

  const activities = await db
    .select({
      date: stravaActivities.startDateLocal,
      distance: stravaActivities.distanceMiles,
    })
    .from(stravaActivities)
    .where(eq(stravaActivities.isDeleted, 0));

  const dailyMilesMap = new Map<string, number>();
  for (const a of activities) {
    const date = a.date.substring(0, 10);
    dailyMilesMap.set(date, (dailyMilesMap.get(date) ?? 0) + a.distance);
  }

  const eddington = calculateEddington([...dailyMilesMap.values()]);

  return c.json({
    number: eddington.number,
    explanation: `You have run at least ${eddington.number} miles on at least ${eddington.number} days`,
    progress: {
      target: eddington.nextTarget,
      days_completed: eddington.daysAtNextTarget,
      runs_needed: eddington.runsNeeded,
    },
  });
});

// GET /v1/running/year/:year
const yearInReviewRoute = createRoute({
  method: 'get',
  path: '/year/{year}',
  operationId: 'getRunningYearInReview',
  tags: ['Running'],
  summary: 'Year in review',
  description:
    'Returns a year-in-review summary with monthly breakdown and top runs.',
  request: {
    params: YearParamSchema,
  },
  responses: {
    200: {
      description: 'Year in review',
      content: {
        'application/json': {
          schema: YearInReviewSchema,
          example: {
            year: 2025,
            total_runs: 120,
            total_distance_mi: 540.2,
            total_elevation_ft: 18500,
            total_duration_s: 257400,
            avg_pace: '7:55/mi',
            longest_run_mi: 13.1,
            race_count: 3,
            monthly: [
              {
                month: '2025-01',
                runs: 8,
                distance_mi: 35.2,
                duration_s: 17100,
                elevation_ft: 1200,
              },
              {
                month: '2025-02',
                runs: 10,
                distance_mi: 42.1,
                duration_s: 20400,
                elevation_ft: 1500,
              },
            ],
            top_runs: [
              {
                id: 12345,
                strava_id: 12345,
                name: 'Portland Half Marathon',
                date: '2025-10-06',
                distance_mi: 13.1,
                duration: '1:45:00',
                duration_s: 6300,
                pace: '8:01/mi',
                elevation_ft: 320,
                heartrate_avg: 160,
                heartrate_max: 178,
                cadence: 77.0,
                calories: 1400,
                suffer_score: 120,
                city: 'Portland',
                state: 'OR',
                polyline: null,
                is_race: true,
                workout_type: 'race',
                strava_url: 'https://www.strava.com/activities/12345',
              },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401, 404),
  },
});

running.openapi(yearInReviewRoute, async (c) => {
  const db = createDb(c.env.DB);
  const currentYear = new Date().getFullYear();
  const year = parseInt(c.req.param('year'), 10);

  if (isNaN(year) || year < 2000 || year > currentYear + 1) {
    return badRequest(c, 'Invalid year') as any;
  }

  if (year < currentYear) {
    setCache(c, 'long');
  } else {
    setCache(c, 'medium');
  }

  // Get year summary
  const [summary] = await db
    .select()
    .from(stravaYearSummaries)
    .where(
      and(eq(stravaYearSummaries.userId, 1), eq(stravaYearSummaries.year, year))
    )
    .limit(1);

  if (!summary) {
    return notFound(c, `No data for year ${year}`) as any;
  }

  // Monthly breakdown
  const activities = await db
    .select({
      date: stravaActivities.startDateLocal,
      distance: stravaActivities.distanceMiles,
      duration: stravaActivities.movingTimeSeconds,
      elevation: stravaActivities.totalElevationGainFeet,
      isRace: stravaActivities.isRace,
    })
    .from(stravaActivities)
    .where(
      and(
        eq(stravaActivities.isDeleted, 0),
        gte(stravaActivities.startDateLocal, `${year}-01-01T00:00:00`),
        lte(stravaActivities.startDateLocal, `${year}-12-31T23:59:59`)
      )
    )
    .orderBy(asc(stravaActivities.startDateLocal));

  // Aggregate by month
  const monthlyMap = new Map<
    string,
    { runs: number; distance: number; duration: number; elevation: number }
  >();
  for (const a of activities) {
    const month = a.date.substring(0, 7);
    const existing = monthlyMap.get(month) ?? {
      runs: 0,
      distance: 0,
      duration: 0,
      elevation: 0,
    };
    existing.runs++;
    existing.distance =
      Math.round((existing.distance + a.distance) * 100) / 100;
    existing.duration += a.duration;
    existing.elevation =
      Math.round((existing.elevation + a.elevation) * 100) / 100;
    monthlyMap.set(month, existing);
  }

  const monthly = [...monthlyMap.entries()].map(([month, data]) => ({
    month,
    runs: data.runs,
    distance_mi: data.distance,
    duration_s: data.duration,
    elevation_ft: data.elevation,
  }));

  // Top runs by distance
  const topRuns = await db
    .select()
    .from(stravaActivities)
    .where(
      and(
        eq(stravaActivities.isDeleted, 0),
        gte(stravaActivities.startDateLocal, `${year}-01-01T00:00:00`),
        lte(stravaActivities.startDateLocal, `${year}-12-31T23:59:59`)
      )
    )
    .orderBy(desc(stravaActivities.distanceMiles))
    .limit(5);

  return c.json({
    year: summary.year,
    total_runs: summary.totalRuns,
    total_distance_mi: summary.totalDistanceMiles,
    total_elevation_ft: summary.totalElevationFeet,
    total_duration_s: summary.totalDurationSeconds,
    avg_pace: summary.avgPaceFormatted,
    longest_run_mi: summary.longestRunMiles,
    race_count: summary.raceCount,
    monthly,
    top_runs: topRuns.map(formatActivityResponse),
  });
});

// POST /v1/admin/sync/running -- moved to admin-sync.ts
// Old path /v1/running/admin/sync redirects via admin-sync.ts

// --- Helper functions ---

function formatActivityResponse(a: {
  stravaId: number;
  name: string;
  startDateLocal: string;
  distanceMiles: number;
  movingTimeSeconds: number;
  paceFormatted: string | null;
  totalElevationGainFeet: number;
  averageHeartrate: number | null;
  city: string | null;
  state: string | null;
  mapPolyline: string | null;
  isRace: number;
  workoutType: number | null;
  stravaUrl: string | null;
  maxHeartrate: number | null;
  averageCadence: number | null;
  calories: number | null;
  sufferScore: number | null;
}) {
  return {
    id: a.stravaId,
    strava_id: a.stravaId,
    name: a.name,
    date: a.startDateLocal,
    distance_mi: a.distanceMiles,
    duration: formatDuration(a.movingTimeSeconds),
    duration_s: a.movingTimeSeconds,
    pace: a.paceFormatted ?? '0:00/mi',
    elevation_ft: a.totalElevationGainFeet,
    heartrate_avg: a.averageHeartrate,
    heartrate_max: a.maxHeartrate,
    cadence: a.averageCadence,
    calories: a.calories,
    suffer_score: a.sufferScore,
    city: a.city,
    state: a.state,
    polyline: a.mapPolyline,
    is_race: a.isRace === 1,
    workout_type: getWorkoutTypeLabel(a.workoutType),
    strava_url: a.stravaUrl,
  };
}

export default running;
