import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { lastfmScrobbles, lastfmTracks } from '../db/schema/lastfm.js';

export type SparklineGranularity = 'day' | 'week' | 'month' | 'year';
export type SparklinePeriod =
  '7day' | '1month' | '3month' | '6month' | '12month';
export type SparklineEntity = 'artist' | 'album' | 'track';

export const SPARKLINE_PERIODS: readonly SparklinePeriod[] = [
  '7day',
  '1month',
  '3month',
  '6month',
  '12month',
];

export function isSparklinePeriod(period: string): period is SparklinePeriod {
  return (SPARKLINE_PERIODS as readonly string[]).includes(period);
}

const PERIOD_CONFIG: Record<
  SparklinePeriod,
  { granularity: SparklineGranularity; bucketCount: number }
> = {
  '7day': { granularity: 'day', bucketCount: 7 },
  '1month': { granularity: 'day', bucketCount: 28 },
  '3month': { granularity: 'week', bucketCount: 13 },
  '6month': { granularity: 'week', bucketCount: 26 },
  '12month': { granularity: 'week', bucketCount: 52 },
};

export interface SparklineWindow {
  /** ISO 8601, inclusive lower bound on scrobbled_at. */
  from: string;
  /** ISO 8601, exclusive upper bound on scrobbled_at. */
  to: string;
  granularity: SparklineGranularity;
  bucketCount: number;
  /** Canonical bucket keys, oldest -> newest, length === bucketCount. */
  bucketKeys: string[];
}

/**
 * Convert a sparkline period to a UTC time window plus the canonical bucket
 * keys the SQL aggregate is expected to emit. JS bucket keys are generated
 * to match SQLite's strftime / weekday-0/-6-days output verbatim, so the
 * zero-fill step can index reliably.
 */
export function periodToWindow(
  period: SparklinePeriod,
  now: Date = new Date()
): SparklineWindow {
  const { granularity, bucketCount } = PERIOD_CONFIG[period];

  // Anchor to UTC midnight of "today" so all bucket math sits on day boundaries.
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );

  if (granularity === 'day') {
    const bucketKeys: string[] = [];
    for (let i = bucketCount - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      bucketKeys.push(toIsoDate(d));
    }
    const fromDate = new Date(today);
    fromDate.setUTCDate(fromDate.getUTCDate() - (bucketCount - 1));
    const toDate = new Date(today);
    toDate.setUTCDate(toDate.getUTCDate() + 1);
    return {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      granularity,
      bucketCount,
      bucketKeys,
    };
  }

  // Weekly: anchor each bucket on the Monday of that week, matching the
  // SQL `date(..., 'weekday 0', '-6 days')` expression.
  const dayOfWeek = today.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  const currentMonday = new Date(today);
  currentMonday.setUTCDate(currentMonday.getUTCDate() - daysSinceMonday);

  const bucketKeys: string[] = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    const d = new Date(currentMonday);
    d.setUTCDate(d.getUTCDate() - i * 7);
    bucketKeys.push(toIsoDate(d));
  }
  const fromDate = new Date(currentMonday);
  fromDate.setUTCDate(fromDate.getUTCDate() - (bucketCount - 1) * 7);
  const toDate = new Date(currentMonday);
  toDate.setUTCDate(toDate.getUTCDate() + 7);
  return {
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    granularity,
    bucketCount,
    bucketKeys,
  };
}

/**
 * 12 monthly buckets across a calendar year. Bucket keys match SQLite's
 * `strftime('%Y-%m', ...)` output, e.g. '2026-04'.
 */
export function yearToWindow(year: number): SparklineWindow {
  const bucketKeys: string[] = [];
  for (let m = 1; m <= 12; m++) {
    bucketKeys.push(`${year}-${String(m).padStart(2, '0')}`);
  }
  return {
    from: `${year}-01-01T00:00:00.000Z`,
    to: `${year + 1}-01-01T00:00:00.000Z`,
    granularity: 'month',
    bucketCount: 12,
    bucketKeys,
  };
}

/**
 * Daily buckets for a single calendar month (28-31 points depending on
 * the month length). Bucket keys match `strftime('%Y-%m-%d', ...)`.
 */
export function yearMonthToWindow(
  year: number,
  month: number
): SparklineWindow {
  // Day count: use Date(y, m, 0) trick — m is 1-indexed in JS Date when day=0
  // means last day of the previous month, so passing the next month's index
  // gives us the current month's length.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');

  const bucketKeys: string[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    bucketKeys.push(`${year}-${mm}-${String(d).padStart(2, '0')}`);
  }

  // End-exclusive: start of next month, rolling year if December.
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nmm = String(nextMonth).padStart(2, '0');

  return {
    from: `${year}-${mm}-01T00:00:00.000Z`,
    to: `${nextYear}-${nmm}-01T00:00:00.000Z`,
    granularity: 'day',
    bucketCount: daysInMonth,
    bucketKeys,
  };
}

/**
 * Yearly buckets covering [earliestYear, currentYear] inclusive — used for
 * lifetime ('overall') sparklines. Bucket keys match `strftime('%Y', ...)`,
 * e.g. '2012'.
 */
export function overallToWindow(
  earliestYear: number,
  currentYear: number
): SparklineWindow {
  if (currentYear < earliestYear) {
    throw new Error(
      `overallToWindow: currentYear (${currentYear}) < earliestYear (${earliestYear})`
    );
  }
  const bucketKeys: string[] = [];
  for (let y = earliestYear; y <= currentYear; y++) {
    bucketKeys.push(String(y));
  }
  return {
    from: `${earliestYear}-01-01T00:00:00.000Z`,
    to: `${currentYear + 1}-01-01T00:00:00.000Z`,
    granularity: 'year',
    bucketCount: bucketKeys.length,
    bucketKeys,
  };
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface SparklineSeries {
  granularity: SparklineGranularity;
  points: number[];
}

function bucketSqlForGranularity(granularity: SparklineGranularity): string {
  const col = lastfmScrobbles.scrobbledAt.name;
  switch (granularity) {
    case 'day':
      return `strftime('%Y-%m-%d', ${col})`;
    case 'week':
      return `date(${col}, 'weekday 0', '-6 days')`;
    case 'month':
      return `strftime('%Y-%m', ${col})`;
    case 'year':
      return `strftime('%Y', ${col})`;
  }
}

function entityColumn(entity: SparklineEntity) {
  switch (entity) {
    case 'artist':
      return lastfmTracks.artistId;
    case 'album':
      return lastfmTracks.albumId;
    case 'track':
      return lastfmScrobbles.trackId;
  }
}

/**
 * For each id in `ids`, return a zero-filled play-count series over the
 * given window. Single SQL aggregate; missing buckets fill with 0.
 *
 * Always joins through lastfm_tracks so we can apply the `is_filtered = 0`
 * exclusion that the rest of the listening domain relies on. The entity
 * controls which column drives the IN-list and GROUP BY:
 *
 *   - artist  -> lastfm_tracks.artist_id
 *   - album   -> lastfm_tracks.album_id
 *   - track   -> lastfm_scrobbles.track_id
 */
export async function buildSparklinesForWindow(
  db: Database,
  ids: number[],
  window: SparklineWindow,
  entity: SparklineEntity
): Promise<Map<number, SparklineSeries>> {
  if (ids.length === 0) return new Map();

  const bucketSql = bucketSqlForGranularity(window.granularity);
  const idCol = entityColumn(entity);

  const rows = await db
    .select({
      id: idCol,
      bucket: sql<string>`${sql.raw(bucketSql)}`.as('bucket'),
      plays: sql<number>`count(*)`.as('plays'),
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(
      and(
        inArray(idCol, ids),
        gte(lastfmScrobbles.scrobbledAt, window.from),
        lt(lastfmScrobbles.scrobbledAt, window.to),
        eq(lastfmTracks.isFiltered, 0)
      )
    )
    .groupBy(idCol, sql.raw(bucketSql));

  const counts = new Map<number, Map<string, number>>();
  for (const row of rows) {
    if (row.id == null) continue;
    const idNum = Number(row.id);
    if (!Number.isFinite(idNum)) continue;
    let inner = counts.get(idNum);
    if (!inner) {
      inner = new Map();
      counts.set(idNum, inner);
    }
    inner.set(row.bucket, Number(row.plays));
  }

  const result = new Map<number, SparklineSeries>();
  for (const id of ids) {
    const inner = counts.get(id);
    const points = window.bucketKeys.map((key) => inner?.get(key) ?? 0);
    result.set(id, {
      granularity: window.granularity,
      points,
    });
  }
  return result;
}

/**
 * Back-compat wrapper: artist sparklines for one of the four supported
 * rolling periods. New code should prefer `buildSparklinesForWindow`.
 */
export async function buildSparklines(
  db: Database,
  artistIds: number[],
  period: SparklinePeriod,
  now: Date = new Date()
): Promise<Map<number, SparklineSeries>> {
  return buildSparklinesForWindow(
    db,
    artistIds,
    periodToWindow(period, now),
    'artist'
  );
}
