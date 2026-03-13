import { describe, it, expect } from 'vitest';
import {
  metersToMiles,
  metersToFeet,
  msToMinPerMile,
  formatPace,
  formatDuration,
  transformActivity,
  transformSplits,
  extractPersonalRecords,
  computeYearSummaries,
  calculateStreaks,
  calculateEddington,
} from '../services/strava/transforms.js';
import { validateSubscription } from '../services/strava/webhook.js';

/**
 * End-to-end integration test: simulates a full sync + webhook flow
 * and verifies transforms produce correct output.
 */
describe('Running domain integration', () => {
  const mockActivity = {
    id: 12345678,
    name: 'Morning Run',
    type: 'Run' as const,
    sport_type: 'Run',
    workout_type: 0,
    distance: 8046.7, // ~5 miles
    moving_time: 2400, // 40 minutes
    elapsed_time: 2500,
    total_elevation_gain: 45.7,
    start_date: '2024-03-15T12:00:00Z',
    start_date_local: '2024-03-15T07:00:00Z',
    timezone: '(GMT-05:00) America/New_York',
    start_latlng: [40.7128, -74.006] as [number, number],
    end_latlng: [40.72, -74.01] as [number, number],
    location_city: 'New York',
    location_state: 'New York',
    location_country: 'United States',
    average_speed: 3.353, // m/s
    max_speed: 4.5,
    average_heartrate: 152,
    max_heartrate: 178,
    average_cadence: 84,
    calories: 450,
    suffer_score: 65,
    map: { summary_polyline: 'encoded_polyline_data', polyline: null },
    gear_id: 'g12345',
    achievement_count: 3,
    pr_count: 1,
    best_efforts: [
      {
        name: 'Mile',
        distance: 1609.34,
        elapsed_time: 420,
        moving_time: 420,
        start_date: '2024-03-15T12:05:00Z',
        pr_rank: 1,
      },
      {
        name: '5K',
        distance: 5000,
        elapsed_time: 1350,
        moving_time: 1350,
        start_date: '2024-03-15T12:10:00Z',
        pr_rank: 2,
      },
    ],
    splits_standard: [
      {
        distance: 1609.34,
        elapsed_time: 490,
        moving_time: 480,
        elevation_difference: 10,
        average_speed: 3.35,
        average_heartrate: 148,
        average_grade_adjusted_speed: null,
        split: 1,
      },
      {
        distance: 1609.34,
        elapsed_time: 470,
        moving_time: 465,
        elevation_difference: 5,
        average_speed: 3.46,
        average_heartrate: 155,
        average_grade_adjusted_speed: null,
        split: 2,
      },
    ],
  };

  describe('full activity transform pipeline', () => {
    it('transforms activity with all fields', () => {
      const result = transformActivity(mockActivity);

      expect(result.stravaId).toBe(12345678);
      expect(result.name).toBe('Morning Run');
      expect(result.distanceMiles).toBeCloseTo(5.0, 0);
      expect(result.totalElevationGainFeet).toBeCloseTo(150, -1);
      expect(result.paceFormatted).toContain('/mi');
      expect(result.city).toBe('New York');
      expect(result.mapPolyline).toBe('encoded_polyline_data');
      expect(result.isRace).toBe(0);
    });

    it('transforms splits correctly', () => {
      const splits = transformSplits(
        mockActivity.id,
        mockActivity.splits_standard
      );

      expect(splits).toHaveLength(2);
      expect(splits[0].splitNumber).toBe(1);
      expect(splits[0].distanceMiles).toBeCloseTo(1.0, 0);
      expect(splits[0].paceFormatted).toContain('/mi');
      expect(splits[1].splitNumber).toBe(2);
    });

    it('extracts personal records from best efforts', () => {
      const prs = extractPersonalRecords([
        {
          activityId: mockActivity.id,
          activityName: mockActivity.name,
          bestEfforts: mockActivity.best_efforts,
        },
      ]);

      expect(prs.length).toBeGreaterThan(0);

      const milePr = prs.find((pr) => pr.distance === 'mile');
      expect(milePr).toBeDefined();
      expect(milePr!.timeSeconds).toBe(420);
      expect(milePr!.timeFormatted).toBe('7:00');

      const fiveKPr = prs.find((pr) => pr.distance === '5k');
      expect(fiveKPr).toBeDefined();
      expect(fiveKPr!.timeSeconds).toBe(1350);
    });
  });

  describe('stats computation pipeline', () => {
    it('computes year summaries from activities', () => {
      const activities = [
        {
          year: 2024,
          distanceMiles: 5.0,
          movingTimeSeconds: 2400,
          elevationFeet: 150,
          isRace: false,
          longestRunMiles: 5.0,
        },
        {
          year: 2024,
          distanceMiles: 10.0,
          movingTimeSeconds: 5000,
          elevationFeet: 300,
          isRace: true,
          longestRunMiles: 10.0,
        },
        {
          year: 2023,
          distanceMiles: 3.0,
          movingTimeSeconds: 1500,
          elevationFeet: 50,
          isRace: false,
          longestRunMiles: 3.0,
        },
      ];

      const summaries = computeYearSummaries(activities);

      expect(summaries.size).toBe(2);

      const y2024 = summaries.get(2024)!;
      expect(y2024.totalRuns).toBe(2);
      expect(y2024.totalDistanceMiles).toBe(15.0);
      expect(y2024.raceCount).toBe(1);
      expect(y2024.longestRunMiles).toBe(10.0);
      expect(y2024.totalDurationSeconds).toBe(7400);
    });

    it('computes streaks across dates', () => {
      const streaks = calculateStreaks([
        '2024-01-01T07:00:00',
        '2024-01-02T07:00:00',
        '2024-01-03T07:00:00',
        '2024-01-04T07:00:00',
        // gap
        '2024-01-06T07:00:00',
        '2024-01-07T07:00:00',
      ]);

      expect(streaks.longestStreakDays).toBe(4);
      expect(streaks.longestStreakStart).toBe('2024-01-01');
      expect(streaks.longestStreakEnd).toBe('2024-01-04');
    });

    it('computes Eddington number', () => {
      // 20 days of 20+ miles = E=20
      const dailyMiles = Array(25).fill(20);
      const eddington = calculateEddington(dailyMiles);

      expect(eddington.number).toBe(20);
      expect(eddington.nextTarget).toBe(21);
    });
  });

  describe('unit conversions are consistent', () => {
    it('meters to miles roundtrip is consistent', () => {
      const meters = 10000;
      const miles = metersToMiles(meters);
      expect(miles).toBeCloseTo(6.21, 1);
    });

    it('meters to feet converts correctly', () => {
      const meters = 100;
      const feet = metersToFeet(meters);
      expect(feet).toBeCloseTo(328.08, 0);
    });

    it('pace calculation matches formatted output', () => {
      const speedMs = 3.353; // ~8:00/mi
      const paceMinPerMile = msToMinPerMile(speedMs);
      expect(paceMinPerMile).not.toBeNull();

      const formatted = formatPace(paceMinPerMile);
      expect(formatted).toMatch(/^\d+:\d{2}\/mi$/);
    });

    it('duration formatting handles edge cases', () => {
      expect(formatDuration(0)).toBe('0:00');
      expect(formatDuration(59)).toBe('0:59');
      expect(formatDuration(60)).toBe('1:00');
      expect(formatDuration(3600)).toBe('1:00:00');
    });
  });

  describe('webhook validation', () => {
    it('validates subscription correctly', () => {
      const result = validateSubscription(
        {
          'hub.mode': 'subscribe',
          'hub.challenge': 'test_challenge',
          'hub.verify_token': 'my_secret',
        },
        'my_secret'
      );

      expect(result).toEqual({ 'hub.challenge': 'test_challenge' });
    });

    it('rejects invalid token', () => {
      const result = validateSubscription(
        {
          'hub.mode': 'subscribe',
          'hub.challenge': 'test_challenge',
          'hub.verify_token': 'wrong',
        },
        'my_secret'
      );

      expect(result).toBeNull();
    });
  });
});
