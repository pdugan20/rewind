import { describe, it, expect } from 'vitest';
import {
  healthActivityId,
  isHealthActivityId,
  toLocalIso,
  toUtcIso,
  timezoneLabel,
  runName,
  metadataElevationMeters,
  encodePolyline,
  transformHealthRun,
  type PulsoSample,
} from './transforms.js';

const MILE = 1609.344;
const SPEED = 3; // m/s, about 8:56/mi
const METERS_PER_DEG_LAT = 111195;

/**
 * 2.5 miles due north at a steady 3 m/s, with a 90 second stop at the
 * 600 second mark, a steady climb, and heart rate that jumps after mile 1.
 */
function syntheticRun(overrides: Partial<PulsoSample> = {}): PulsoSample {
  const start = Date.parse('2026-09-02T16:00:00Z') / 1000;
  const totalMeters = 2.5 * MILE;
  const runSeconds = Math.round(totalMeters / SPEED);
  const route: NonNullable<PulsoSample['route']> = [];
  const heartRateSeries: NonNullable<PulsoSample['heartRateSeries']> = [];
  for (let s = 0; s <= runSeconds; s++) {
    const t = start + s + (s >= 600 ? 90 : 0);
    const meters = Math.min(s * SPEED, totalMeters);
    route.push([
      t,
      47.6 + meters / METERS_PER_DEG_LAT,
      -122.3,
      10 + s * 0.01,
      5,
    ]);
    if (s % 5 === 0) heartRateSeries.push([t, meters < MILE ? 140 : 160]);
  }
  // A wild GPS fix that must be ignored.
  route.push([start + 300.5, 48.5, -121, 10, 120]);
  return {
    uuid: '6F1D2C3B-4A5E-4F60-8172-93A4B5C6D7E8',
    type: 'workout',
    workoutActivityType: 'running',
    start: '2026-09-02T09:00:00-07:00',
    end: '2026-09-02T09:23:52-07:00',
    source: 'Nike Run Club',
    metadata: { timeZone: 'America/Los_Angeles' },
    duration: runSeconds,
    totalDistance: totalMeters,
    totalEnergyBurned: 301.6,
    route,
    heartRateSeries,
    ...overrides,
  };
}

describe('healthActivityId', () => {
  it('is stable and stays above every Strava id as an exact integer', () => {
    const id = healthActivityId('6F1D2C3B-4A5E-4F60-8172-93A4B5C6D7E8');
    expect(id).toBe(healthActivityId('6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8'));
    expect(Number.isSafeInteger(id)).toBe(true);
    expect(isHealthActivityId(id)).toBe(true);
    expect(isHealthActivityId(19948948137)).toBe(false);
  });

  it('rejects values that are not HealthKit uuids', () => {
    expect(() => healthActivityId('not-a-uuid')).toThrow();
  });
});

describe('timestamps and naming', () => {
  it('matches the Strava columns: UTC start and local wall-clock with Z', () => {
    expect(toUtcIso('2026-09-02T09:00:00-07:00')).toBe('2026-09-02T16:00:00Z');
    expect(toLocalIso('2026-09-02T09:00:00-07:00')).toBe(
      '2026-09-02T09:00:00Z'
    );
    expect(timezoneLabel(syntheticRun())).toBe(
      '(GMT-07:00) America/Los_Angeles'
    );
    expect(timezoneLabel(syntheticRun({ metadata: undefined }))).toBe(
      '(GMT-07:00)'
    );
  });

  it('names runs from the local start time', () => {
    expect(runName('2026-09-02T09:00:00Z')).toBe('Wednesday Morning Run');
    expect(runName('2026-09-04T12:10:00Z')).toBe('Friday Lunch Run');
    expect(runName('2026-09-04T16:28:00Z')).toBe('Friday Afternoon Run');
    expect(runName('2026-09-04T18:00:00Z')).toBe('Friday Evening Run');
    expect(runName('2026-09-04T22:45:00Z')).toBe('Friday Night Run');
  });

  it('reads elevation the recording app stored as a quantity string', () => {
    expect(metadataElevationMeters({ HKElevationAscended: '4250 cm' })).toBe(
      42.5
    );
    expect(metadataElevationMeters({ HKElevationAscended: '12 m' })).toBe(12);
    expect(metadataElevationMeters({})).toBeNull();
  });

  it('encodes polylines like Google and Strava do', () => {
    expect(
      encodePolyline([
        [38.5, -120.2],
        [40.7, -120.95],
        [43.252, -126.453],
      ])
    ).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq\x60@');
  });
});

describe('transformHealthRun', () => {
  const run = transformHealthRun(syntheticRun());

  it('builds the activity from the workout summary', () => {
    const a = run.activity;
    expect(a.name).toBe('Wednesday Morning Run');
    expect(a.source).toBe('apple_health');
    expect(a.sourceId).toBe('6F1D2C3B-4A5E-4F60-8172-93A4B5C6D7E8');
    expect(a.distanceMiles).toBe(2.5);
    expect(a.startDate).toBe('2026-09-02T16:00:00Z');
    expect(a.startDateLocal).toBe('2026-09-02T09:00:00Z');
    expect(a.elapsedTimeSeconds).toBe(23 * 60 + 52);
    expect(a.movingTimeSeconds).toBe(1341);
    expect(a.paceFormatted).toBe('8:56/mi');
    expect(a.calories).toBe(302);
    expect(a.stravaUrl).toBeNull();
    expect(a.startLat).toBeCloseTo(47.6, 5);
    expect(a.mapPolyline).toBeTruthy();
  });

  it('derives heart rate and elevation from the readings', () => {
    expect(run.activity.maxHeartrate).toBe(160);
    expect(run.activity.averageHeartrate).toBeGreaterThan(140);
    expect(run.activity.averageHeartrate).toBeLessThan(160);
    // 13.4 m of steady climb, counted in 3 m steps.
    expect(run.activity.totalElevationGainMeters).toBe(12);
  });

  it('splits by the mile and keeps the stop out of moving time', () => {
    expect(run.splits.map((s) => s.splitNumber)).toEqual([1, 2, 3]);
    const [first, second, last] = run.splits;
    expect(first.movingTimeSeconds).toBeCloseTo(MILE / SPEED, -1);
    expect(first.elapsedTimeSeconds).toBeCloseTo(MILE / SPEED, -1);
    expect(second.movingTimeSeconds).toBeCloseTo(MILE / SPEED, -1);
    expect(second.elapsedTimeSeconds).toBeCloseTo(MILE / SPEED + 90, -1);
    expect(last.distanceMiles).toBeCloseTo(0.5, 2);
    expect(first.averageHeartrate).toBe(140);
    expect(second.averageHeartrate).toBe(160);
    expect(first.paceFormatted).toBe('8:56/mi');
    expect(first.elevationDifferenceMeters).toBeCloseTo(5.4, 0);
  });

  it('finds best efforts over the distances the run covered', () => {
    const efforts = Object.fromEntries(
      run.bestEfforts.map((e) => [e.name, e.moving_time])
    );
    expect(Object.keys(efforts)).toEqual([
      '400m',
      '1/2 mile',
      '1k',
      'mile',
      '2 mile',
    ]);
    expect(efforts.mile).toBeCloseTo(MILE / SPEED, -1);
    expect(efforts['2 mile']).toBeCloseTo((2 * MILE) / SPEED, -1);
  });

  it('ranks best efforts by elapsed time, so a stop inside one counts', () => {
    const byName = Object.fromEntries(run.bestEfforts.map((e) => [e.name, e]));
    // A mile fits before the stop, so both times match.
    expect(byName.mile.elapsed_time).toBe(byName.mile.moving_time);
    // Two miles can't avoid the 90 second stop.
    expect(byName['2 mile'].elapsed_time).toBeCloseTo(
      (2 * MILE) / SPEED + 90,
      -1
    );
    expect(byName['2 mile'].moving_time).toBeCloseTo((2 * MILE) / SPEED, -1);
  });

  it('keeps summary fields for a run without a route', () => {
    const treadmill = transformHealthRun(
      syntheticRun({ route: undefined, heartRateSeries: undefined })
    );
    expect(treadmill.activity.distanceMiles).toBe(2.5);
    expect(treadmill.activity.mapPolyline).toBeNull();
    expect(treadmill.activity.averageHeartrate).toBeNull();
    expect(treadmill.splits).toEqual([]);
    expect(treadmill.bestEfforts).toEqual([]);
  });
});
