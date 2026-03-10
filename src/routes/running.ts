import { Hono } from 'hono';
import { eq, desc, asc, and, sql, gte, lte } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import { createDb } from '../db/client.js';
import { setCache } from '../lib/cache.js';
import { notFound, badRequest } from '../lib/errors.js';
import {
  stravaActivities,
  stravaSplits,
  stravaGear,
  stravaPersonalRecords,
  stravaYearSummaries,
  stravaLifetimeStats,
} from '../db/schema/strava.js';
import { syncRunning } from '../services/strava/sync.js';
import {
  formatTotalDuration,
  formatDuration,
  formatPace,
  getWorkoutTypeLabel,
  calculateEddington,
} from '../services/strava/transforms.js';

const running = new Hono<{ Bindings: Env }>();

// GET /v1/running/stats - Lifetime running statistics
running.get('/stats', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const [stats] = await db
    .select()
    .from(stravaLifetimeStats)
    .where(eq(stravaLifetimeStats.userId, 1))
    .limit(1);

  if (!stats) {
    return c.json({
      total_runs: 0,
      total_distance_mi: 0,
      total_elevation_ft: 0,
      total_duration: '0:00:00',
      avg_pace: '0:00/mi',
      years_active: 0,
      first_run: null,
      eddington_number: 0,
    });
  }

  return c.json({
    total_runs: stats.totalRuns,
    total_distance_mi: stats.totalDistanceMiles,
    total_elevation_ft: stats.totalElevationFeet,
    total_duration: formatTotalDuration(stats.totalDurationSeconds),
    avg_pace: stats.avgPaceFormatted,
    years_active: stats.yearsActive,
    first_run: stats.firstRun,
    eddington_number: stats.eddingtonNumber,
  });
});

// GET /v1/running/stats/years - All year summaries
running.get('/stats/years', async (c) => {
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

// GET /v1/running/stats/years/:year - Single year detail
running.get('/stats/years/:year', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const year = parseInt(c.req.param('year'), 10);

  if (isNaN(year)) {
    return badRequest(c, 'Invalid year');
  }

  const [summary] = await db
    .select()
    .from(stravaYearSummaries)
    .where(
      and(eq(stravaYearSummaries.userId, 1), eq(stravaYearSummaries.year, year))
    )
    .limit(1);

  if (!summary) {
    return notFound(c, `No data for year ${year}`);
  }

  return c.json({
    year: summary.year,
    total_runs: summary.totalRuns,
    total_distance_mi: summary.totalDistanceMiles,
    total_elevation_ft: summary.totalElevationFeet,
    total_duration_s: summary.totalDurationSeconds,
    avg_pace: summary.avgPaceFormatted,
    longest_run_mi: summary.longestRunMiles,
    race_count: summary.raceCount,
  });
});

// GET /v1/running/prs - Personal records
running.get('/prs', async (c) => {
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

// GET /v1/running/recent - Last N activities
running.get('/recent', async (c) => {
  setCache(c, 'realtime');
  const db = createDb(c.env.DB);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '5', 10), 20);

  const activities = await db
    .select()
    .from(stravaActivities)
    .where(eq(stravaActivities.isDeleted, 0))
    .orderBy(desc(stravaActivities.startDate))
    .limit(limit);

  return c.json({
    data: activities.map(formatActivityResponse),
  });
});

// GET /v1/running/activities - Paginated activity list
running.get('/activities', async (c) => {
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

  if (year) {
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

// GET /v1/running/activities/:id - Single activity detail
running.get('/activities/:id', async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'), 10);

  if (isNaN(id)) {
    return badRequest(c, 'Invalid activity ID');
  }

  const [activity] = await db
    .select()
    .from(stravaActivities)
    .where(
      and(eq(stravaActivities.stravaId, id), eq(stravaActivities.isDeleted, 0))
    )
    .limit(1);

  if (!activity) {
    return notFound(c, 'Activity not found');
  }

  return c.json(formatActivityResponse(activity));
});

// GET /v1/running/activities/:id/splits - Per-mile splits
running.get('/activities/:id/splits', async (c) => {
  setCache(c, 'long');
  const db = createDb(c.env.DB);
  const id = parseInt(c.req.param('id'), 10);

  if (isNaN(id)) {
    return badRequest(c, 'Invalid activity ID');
  }

  const splits = await db
    .select()
    .from(stravaSplits)
    .where(eq(stravaSplits.activityStravaId, id))
    .orderBy(asc(stravaSplits.splitNumber));

  if (splits.length === 0) {
    return notFound(c, 'No splits found for this activity');
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

// GET /v1/running/gear - Gear/shoe data
running.get('/gear', async (c) => {
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

// GET /v1/running/calendar - Daily activity heatmap
running.get('/calendar', async (c) => {
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

// GET /v1/running/charts/cumulative - Year-over-year cumulative distance
running.get('/charts/cumulative', async (c) => {
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

// GET /v1/running/charts/pace-trend - Pace over time (rolling average)
running.get('/charts/pace-trend', async (c) => {
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

// GET /v1/running/charts/time-of-day - Run frequency by hour
running.get('/charts/time-of-day', async (c) => {
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

// GET /v1/running/charts/elevation - Elevation data
running.get('/charts/elevation', async (c) => {
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

// GET /v1/running/cities - Cities where runs occurred
running.get('/cities', async (c) => {
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

// GET /v1/running/streaks - Current and longest streaks
running.get('/streaks', async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);

  const [stats] = await db
    .select()
    .from(stravaLifetimeStats)
    .where(eq(stravaLifetimeStats.userId, 1))
    .limit(1);

  if (!stats) {
    return c.json({
      current: { days: 0, start: null, end: null },
      longest: { days: 0, start: null, end: null },
    });
  }

  return c.json({
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
  });
});

// GET /v1/running/races - Race activities
running.get('/races', async (c) => {
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

// GET /v1/running/eddington - Eddington number
running.get('/eddington', async (c) => {
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

// POST /v1/admin/sync/running - Manual sync trigger
running.post('/admin/sync', async (c) => {
  const db = createDb(c.env.DB);

  try {
    const itemsSynced = await syncRunning(c.env, db);
    return c.json({
      status: 'completed',
      items_synced: itemsSynced,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, status: 500 }, 500);
  }
});

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
