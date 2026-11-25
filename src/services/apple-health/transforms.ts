/**
 * Pure transforms that turn a Pulso running workout (Apple Health) into the
 * same rows the Strava sync writes: the activity, its mile splits, and its
 * best efforts. Everything Strava used to calculate for us is derived here
 * from the GPS route and the heart-rate readings.
 */
import {
  metersToMiles,
  metersToFeet,
  msToMinPerMile,
  formatPace,
} from '../strava/transforms.js';

export const HEALTH_SOURCE = 'apple_health';

/** One element of a Pulso /ingest batch that is a sample. */
export interface PulsoSample {
  uuid: string;
  type: string;
  start: string;
  end: string;
  source?: string;
  sourceBundleId?: string;
  metadata?: Record<string, string | number | boolean>;
  workoutActivityType?: string;
  duration?: number;
  totalEnergyBurned?: number;
  totalDistance?: number;
  averageHeartRate?: number;
  maximumHeartRate?: number;
  /** [epochSeconds, lat, lng, altitudeMeters | null, horizontalAccuracyMeters] */
  route?: Array<[number, number, number, number | null, number]>;
  /** [epochSeconds, bpm] */
  heartRateSeries?: Array<[number, number]>;
}

const METERS_PER_MILE = 1609.344;
/** Fixes less accurate than this are GPS noise for pace purposes. */
const MAX_HORIZONTAL_ACCURACY_M = 50;
/** A gap longer than this between fixes is a pause, not running. */
const MAX_MOVING_GAP_S = 30;
const MIN_MOVING_SPEED_MS = 0.5;
/** Anything faster than ~3:50/mi is a GPS glitch for this runner's data. */
const MAX_PLAUSIBLE_SPEED_MS = 7;
const ELEVATION_HYSTERESIS_M = 3;
const POLYLINE_TOLERANCE_DEG = 0.00003;

/**
 * Health runs live in the same table as Strava runs, keyed by an integer.
 * Derive a stable one from the HealthKit uuid inside [2^52, 2^53): above
 * any Strava id and still an exact JavaScript integer.
 */
export function healthActivityId(uuid: string): number {
  const hex = uuid.replace(/-/g, '').slice(0, 13).toLowerCase();
  if (!/^[0-9a-f]{13}$/.test(hex)) {
    throw new Error('Invalid HealthKit uuid: ' + uuid);
  }
  return 2 ** 52 + parseInt(hex, 16);
}

export function isHealthActivityId(id: number): boolean {
  return id >= 2 ** 52;
}

export function isRunningWorkout(sample: PulsoSample): boolean {
  return sample.type === 'workout' && sample.workoutActivityType === 'running';
}

/** "2026-09-02T09:12:00-07:00" -> UTC "2026-09-02T16:12:00Z". */
export function toUtcIso(timestamp: string): string {
  return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Strava stores local wall-clock time with a "Z" suffix; match it so the
 * existing year, time-of-day, and calendar queries keep working.
 */
export function toLocalIso(timestamp: string): string {
  return timestamp.slice(0, 19) + 'Z';
}

function offsetLabel(timestamp: string): string {
  const match = timestamp.match(/([+-]\d{2}:\d{2}|Z)$/);
  const offset = !match || match[1] === 'Z' ? '+00:00' : match[1];
  return '(GMT' + offset + ')';
}

/** Strava-style "(GMT-07:00) America/Los_Angeles". */
export function timezoneLabel(sample: PulsoSample): string {
  const zone = sample.metadata?.timeZone;
  const label = offsetLabel(sample.start);
  return typeof zone === 'string' && zone ? label + ' ' + zone : label;
}

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** "Friday Morning Run", from the run's local start time. */
export function runName(localIso: string): string {
  const date = new Date(localIso);
  const hour = date.getUTCHours();
  const part =
    hour >= 4 && hour < 11
      ? 'Morning'
      : hour < 13 && hour >= 11
        ? 'Lunch'
        : hour >= 13 && hour < 17
          ? 'Afternoon'
          : hour >= 17 && hour < 21
            ? 'Evening'
            : 'Night';
  return WEEKDAYS[date.getUTCDay()] + ' ' + part + ' Run';
}

// --- Route geometry ---

interface Track {
  /** Epoch seconds. */
  time: number[];
  /** Cumulative distance in meters, scaled to the workout's total. */
  distance: number[];
  /** Cumulative moving seconds (pauses removed). */
  moving: number[];
  altitude: Array<number | null>;
  lat: number[];
  lng: number[];
}

function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function buildTrack(
  route: PulsoSample['route'],
  totalDistanceMeters?: number
): Track | null {
  const points = (route ?? [])
    .filter(
      (p) =>
        Array.isArray(p) &&
        p.length >= 5 &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1]) &&
        Number.isFinite(p[2]) &&
        p[4] <= MAX_HORIZONTAL_ACCURACY_M
    )
    .sort((a, b) => a[0] - b[0]);

  const deduped: typeof points = [];
  for (const p of points) {
    if (deduped.length && deduped[deduped.length - 1][0] === p[0]) continue;
    deduped.push(p);
  }
  if (deduped.length < 2) return null;

  const raw: number[] = [0];
  for (let i = 1; i < deduped.length; i++) {
    const [, lat0, lng0] = deduped[i - 1];
    const [, lat1, lng1] = deduped[i];
    raw.push(raw[i - 1] + haversineMeters(lat0, lng0, lat1, lng1));
  }
  const routeDistance = raw[raw.length - 1];
  if (routeDistance <= 0) return null;

  // Trust the recording app's total; GPS distance only shapes the run.
  const ratio = totalDistanceMeters ? totalDistanceMeters / routeDistance : 1;
  const scale = ratio > 0.8 && ratio < 1.25 ? ratio : 1;

  const track: Track = {
    time: [],
    distance: [],
    moving: [],
    altitude: [],
    lat: [],
    lng: [],
  };
  for (let i = 0; i < deduped.length; i++) {
    const [t, lat, lng, alt] = deduped[i];
    track.time.push(t);
    track.distance.push(raw[i] * scale);
    track.lat.push(lat);
    track.lng.push(lng);
    track.altitude.push(alt ?? null);
    if (i === 0) {
      track.moving.push(0);
      continue;
    }
    const dt = t - deduped[i - 1][0];
    const dd = (raw[i] - raw[i - 1]) * scale;
    const isMoving = dt <= MAX_MOVING_GAP_S && dd / dt >= MIN_MOVING_SPEED_MS;
    track.moving.push(track.moving[i - 1] + (isMoving ? dt : 0));
  }
  return track;
}

/** Interpolate a cumulative series at a cumulative distance. */
function atDistance(
  track: Track,
  series: number[],
  meters: number,
  from = 1
): { value: number; index: number } {
  let i = Math.max(1, from);
  while (i < track.distance.length - 1 && track.distance[i] < meters) i++;
  const d0 = track.distance[i - 1];
  const d1 = track.distance[i];
  const f = d1 > d0 ? Math.min(1, Math.max(0, (meters - d0) / (d1 - d0))) : 1;
  return { value: series[i - 1] + (series[i] - series[i - 1]) * f, index: i };
}

function altitudeNear(track: Track, index: number): number | null {
  for (let offset = 0; offset < track.altitude.length; offset++) {
    const before = track.altitude[index - offset];
    if (before !== undefined && before !== null) return before;
    const after = track.altitude[index + offset];
    if (after !== undefined && after !== null) return after;
  }
  return null;
}

/** Total climb with a small dead band so GPS altitude jitter doesn't count. */
export function elevationGainMeters(track: Track): number {
  let gain = 0;
  let anchor: number | null = null;
  for (const alt of track.altitude) {
    if (alt === null) continue;
    if (anchor === null) {
      anchor = alt;
      continue;
    }
    if (alt - anchor >= ELEVATION_HYSTERESIS_M) {
      gain += alt - anchor;
      anchor = alt;
    } else if (anchor - alt >= ELEVATION_HYSTERESIS_M) {
      anchor = alt;
    }
  }
  return gain;
}

/** Elevation the recording app measured, e.g. "4250 cm" or "42.5 m". */
export function metadataElevationMeters(
  metadata: PulsoSample['metadata']
): number | null {
  const raw = metadata?.HKElevationAscended;
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^([\d.]+)\s*(cm|m|ft)$/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (match[2] === 'cm') return value / 100;
  if (match[2] === 'ft') return value * 0.3048;
  return value;
}

/** Fastest ~10 second stretch, ignoring GPS spikes. */
export function maxSpeedMs(track: Track): number | null {
  let best = 0;
  let j = 0;
  for (let i = 0; i < track.time.length; i++) {
    if (j < i) j = i;
    while (j < track.time.length - 1 && track.time[j] - track.time[i] < 10) j++;
    const dt = track.time[j] - track.time[i];
    if (dt < 10) break;
    const speed = (track.distance[j] - track.distance[i]) / dt;
    if (speed <= MAX_PLAUSIBLE_SPEED_MS && speed > best) best = speed;
  }
  return best > 0 ? best : null;
}

function averageHeartRateBetween(
  series: PulsoSample['heartRateSeries'],
  start: number,
  end: number
): number | null {
  if (!series?.length) return null;
  let sum = 0;
  let count = 0;
  for (const [t, bpm] of series) {
    if (t >= start && t <= end && Number.isFinite(bpm)) {
      sum += bpm;
      count++;
    }
  }
  return count ? Math.round((sum / count) * 10) / 10 : null;
}

export interface HealthSplit {
  splitNumber: number;
  distanceMeters: number;
  movingTimeSeconds: number;
  elapsedTimeSeconds: number;
  elevationDifferenceMeters: number | null;
  averageHeartrate: number | null;
}

/** Mile splits, with a final partial split for the remainder. */
export function computeMileSplits(
  track: Track,
  heartRate: PulsoSample['heartRateSeries']
): HealthSplit[] {
  const total = track.distance[track.distance.length - 1];
  const splits: HealthSplit[] = [];
  let startMeters = 0;
  let startTime = track.time[0];
  let startMoving = 0;
  let startIndex = 0;
  let cursor = 1;

  for (let n = 1; startMeters < total - 10; n++) {
    const endMeters = Math.min(n * METERS_PER_MILE, total);
    const time = atDistance(track, track.time, endMeters, cursor);
    const moving = atDistance(track, track.moving, endMeters, cursor);
    cursor = time.index;
    const startAlt = altitudeNear(track, startIndex);
    const endAlt = altitudeNear(track, time.index);
    splits.push({
      splitNumber: n,
      distanceMeters: Math.round((endMeters - startMeters) * 10) / 10,
      movingTimeSeconds: Math.round(moving.value - startMoving),
      elapsedTimeSeconds: Math.round(time.value - startTime),
      elevationDifferenceMeters:
        startAlt !== null && endAlt !== null
          ? Math.round((endAlt - startAlt) * 10) / 10
          : null,
      averageHeartrate: averageHeartRateBetween(
        heartRate,
        startTime,
        time.value
      ),
    });
    startMeters = endMeters;
    startTime = time.value;
    startMoving = moving.value;
    startIndex = time.index;
  }
  return splits;
}

/** Same keys as the Strava PR table (see PR_DISTANCES in strava/transforms). */
const BEST_EFFORT_DISTANCES: Array<[string, number]> = [
  ['400m', 400],
  ['1/2 mile', 804.672],
  ['1k', 1000],
  ['mile', 1609.34],
  ['2 mile', 3218.69],
  ['5k', 5000],
  ['10k', 10000],
  ['15k', 15000],
  ['10 mile', 16093.4],
  ['20k', 20000],
  ['half_marathon', 21097.5],
  ['marathon', 42195],
  ['50k', 50000],
];

export interface HealthBestEffort {
  name: string;
  distance: number;
  elapsed_time: number;
  moving_time: number;
  start_date: string;
}

/**
 * Fastest elapsed time over each standard distance the run covered, with the
 * moving time of that same stretch. Personal records compare elapsed time,
 * as they do for the Strava history, so a stop inside the stretch counts.
 */
export function computeBestEfforts(track: Track): HealthBestEffort[] {
  const total = track.distance[track.distance.length - 1];
  const efforts: HealthBestEffort[] = [];
  for (const [name, meters] of BEST_EFFORT_DISTANCES) {
    if (meters > total) break;
    let best: { elapsed: number; moving: number; start: number } | null = null;
    let cursor = 1;
    for (let i = 0; i < track.distance.length; i++) {
      const target = track.distance[i] + meters;
      if (target > total) break;
      const from = Math.max(cursor, i + 1);
      const endTime = atDistance(track, track.time, target, from);
      cursor = endTime.index;
      const elapsed = endTime.value - track.time[i];
      if (elapsed <= 0 || meters / elapsed > MAX_PLAUSIBLE_SPEED_MS) continue;
      if (!best || elapsed < best.elapsed) {
        const endMoving = atDistance(track, track.moving, target, from);
        best = {
          elapsed,
          moving: endMoving.value - track.moving[i],
          start: track.time[i],
        };
      }
    }
    if (best) {
      efforts.push({
        name,
        distance: meters,
        elapsed_time: Math.round(best.elapsed),
        moving_time: Math.round(best.moving),
        start_date: new Date(best.start * 1000)
          .toISOString()
          .replace(/\.\d{3}Z$/, 'Z'),
      });
    }
  }
  return efforts;
}

// --- Polyline ---

/** Douglas-Peucker, iterative so long runs can't overflow the stack. */
export function simplify(
  points: Array<[number, number]>,
  tolerance = POLYLINE_TOLERANCE_DEG
): Array<[number, number]> {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    let maxDistance = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i];
      let distance: number;
      if (lengthSquared === 0) {
        distance = Math.hypot(px - ax, py - ay);
      } else {
        const t = Math.max(
          0,
          Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)
        );
        distance = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }
    if (index !== -1 && maxDistance > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Google encoded polyline, precision 5 (what Strava's summary_polyline uses). */
export function encodePolyline(points: Array<[number, number]>): string {
  let output = '';
  let prevLat = 0;
  let prevLng = 0;
  const encode = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let chunk = '';
    while (v >= 0x20) {
      chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return chunk + String.fromCharCode(v + 63);
  };
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    output += encode(latE5 - prevLat) + encode(lngE5 - prevLng);
    prevLat = latE5;
    prevLng = lngE5;
  }
  return output;
}

// --- Activity ---

export interface HealthRun {
  activity: {
    stravaId: number;
    name: string;
    sportType: string;
    workoutType: number;
    distanceMeters: number;
    distanceMiles: number;
    movingTimeSeconds: number;
    elapsedTimeSeconds: number;
    totalElevationGainMeters: number;
    totalElevationGainFeet: number;
    startDate: string;
    startDateLocal: string;
    timezone: string;
    startLat: number | null;
    startLng: number | null;
    city: null;
    state: null;
    country: null;
    averageSpeedMs: number | null;
    maxSpeedMs: number | null;
    paceMinPerMile: number | null;
    paceFormatted: string;
    averageHeartrate: number | null;
    maxHeartrate: number | null;
    averageCadence: null;
    calories: number | null;
    sufferScore: null;
    mapPolyline: string | null;
    gearId: null;
    achievementCount: number;
    prCount: number;
    isRace: number;
    isDeleted: number;
    stravaUrl: null;
    source: string;
    sourceId: string;
    updatedAt: string;
  };
  splits: Array<{
    activityStravaId: number;
    splitNumber: number;
    distanceMeters: number;
    distanceMiles: number;
    movingTimeSeconds: number;
    elapsedTimeSeconds: number;
    elevationDifferenceMeters: number | null;
    elevationDifferenceFeet: number | null;
    averageSpeedMs: number | null;
    paceMinPerMile: number | null;
    paceFormatted: string;
    averageHeartrate: number | null;
    averageCadence: null;
  }>;
  bestEfforts: HealthBestEffort[];
}

export function transformHealthRun(sample: PulsoSample): HealthRun {
  const stravaId = healthActivityId(sample.uuid);
  const startDate = toUtcIso(sample.start);
  const startDateLocal = toLocalIso(sample.start);
  const elapsed = Math.max(
    0,
    Math.round((Date.parse(sample.end) - Date.parse(sample.start)) / 1000)
  );
  const track = buildTrack(sample.route, sample.totalDistance);
  const distanceMeters =
    sample.totalDistance ?? track?.distance[track.distance.length - 1] ?? 0;
  const moving = Math.round(
    sample.duration ?? track?.moving[track.moving.length - 1] ?? elapsed
  );
  const averageSpeedMs = moving > 0 ? distanceMeters / moving : null;
  const paceMinPerMile =
    averageSpeedMs && averageSpeedMs > 0
      ? msToMinPerMile(averageSpeedMs)
      : null;
  const elevation =
    metadataElevationMeters(sample.metadata) ??
    (track ? elevationGainMeters(track) : 0);

  const series = sample.heartRateSeries?.filter(([, bpm]) =>
    Number.isFinite(bpm)
  );
  const seriesAverage = series?.length
    ? Math.round(
        (series.reduce((s, [, bpm]) => s + bpm, 0) / series.length) * 10
      ) / 10
    : null;
  const seriesMax = series?.length
    ? Math.max(...series.map(([, bpm]) => bpm))
    : null;

  const polylinePoints = track
    ? simplify(
        track.lat.map((lat, i) => [lat, track.lng[i]] as [number, number])
      )
    : [];

  const splits = track
    ? computeMileSplits(track, sample.heartRateSeries).map((split) => {
        const speed =
          split.movingTimeSeconds > 0
            ? split.distanceMeters / split.movingTimeSeconds
            : null;
        const pace = speed ? msToMinPerMile(speed) : null;
        return {
          activityStravaId: stravaId,
          splitNumber: split.splitNumber,
          distanceMeters: split.distanceMeters,
          distanceMiles: metersToMiles(split.distanceMeters),
          movingTimeSeconds: split.movingTimeSeconds,
          elapsedTimeSeconds: split.elapsedTimeSeconds,
          elevationDifferenceMeters: split.elevationDifferenceMeters,
          elevationDifferenceFeet:
            split.elevationDifferenceMeters === null
              ? null
              : metersToFeet(split.elevationDifferenceMeters),
          averageSpeedMs: speed,
          paceMinPerMile: pace,
          paceFormatted: formatPace(pace),
          averageHeartrate: split.averageHeartrate,
          averageCadence: null,
        };
      })
    : [];

  return {
    activity: {
      stravaId,
      name: runName(startDateLocal),
      sportType: 'Run',
      workoutType: 0,
      distanceMeters,
      distanceMiles: metersToMiles(distanceMeters),
      movingTimeSeconds: moving,
      elapsedTimeSeconds: elapsed,
      totalElevationGainMeters: elevation,
      totalElevationGainFeet: metersToFeet(elevation),
      startDate,
      startDateLocal,
      timezone: timezoneLabel(sample),
      startLat: track?.lat[0] ?? null,
      startLng: track?.lng[0] ?? null,
      city: null,
      state: null,
      country: null,
      averageSpeedMs,
      maxSpeedMs: track ? maxSpeedMs(track) : null,
      paceMinPerMile,
      paceFormatted: formatPace(paceMinPerMile),
      averageHeartrate: sample.averageHeartRate ?? seriesAverage,
      maxHeartrate: sample.maximumHeartRate ?? seriesMax,
      averageCadence: null,
      calories:
        sample.totalEnergyBurned !== undefined
          ? Math.round(sample.totalEnergyBurned)
          : null,
      sufferScore: null,
      mapPolyline:
        polylinePoints.length >= 2 ? encodePolyline(polylinePoints) : null,
      gearId: null,
      achievementCount: 0,
      prCount: 0,
      isRace: 0,
      isDeleted: 0,
      stravaUrl: null,
      source: HEALTH_SOURCE,
      sourceId: sample.uuid,
      updatedAt: new Date().toISOString(),
    },
    splits,
    bestEfforts: track ? computeBestEfforts(track) : [],
  };
}
