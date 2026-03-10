import { describe, it, expect } from 'vitest';
import {
  metersToMiles,
  metersToFeet,
  msToMinPerMile,
  formatPace,
  formatDuration,
  formatTotalDuration,
  getWorkoutTypeLabel,
  transformActivity,
  transformSplits,
  extractPersonalRecords,
  computeYearSummaries,
  calculateStreaks,
  calculateEddington,
} from './transforms.js';

describe('metersToMiles', () => {
  it('converts meters to miles', () => {
    expect(metersToMiles(1609.34)).toBeCloseTo(1.0, 1);
    expect(metersToMiles(5000)).toBeCloseTo(3.11, 1);
    expect(metersToMiles(0)).toBe(0);
  });
});

describe('metersToFeet', () => {
  it('converts meters to feet', () => {
    expect(metersToFeet(100)).toBeCloseTo(328.08, 0);
    expect(metersToFeet(0)).toBe(0);
  });
});

describe('msToMinPerMile', () => {
  it('converts m/s to min/mile', () => {
    // 26.8224 / 3.0 = ~8.94 min/mi
    const result = msToMinPerMile(3.0);
    expect(result).toBeCloseTo(8.94, 1);
  });

  it('returns null for zero speed', () => {
    expect(msToMinPerMile(0)).toBeNull();
  });

  it('returns null for negative speed', () => {
    expect(msToMinPerMile(-1)).toBeNull();
  });
});

describe('formatPace', () => {
  it('formats pace as MM:SS/mi', () => {
    expect(formatPace(8.5)).toBe('8:30/mi');
    expect(formatPace(7.0)).toBe('7:00/mi');
    expect(formatPace(10.25)).toBe('10:15/mi');
  });

  it('handles null', () => {
    expect(formatPace(null)).toBe('0:00/mi');
  });
});

describe('formatDuration', () => {
  it('formats short durations as MM:SS', () => {
    expect(formatDuration(150)).toBe('2:30');
    expect(formatDuration(60)).toBe('1:00');
    expect(formatDuration(5)).toBe('0:05');
  });

  it('formats long durations as H:MM:SS', () => {
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(7200)).toBe('2:00:00');
  });
});

describe('formatTotalDuration', () => {
  it('formats total duration', () => {
    expect(formatTotalDuration(5125130)).toBe('1423:38:50');
    expect(formatTotalDuration(3600)).toBe('1:00:00');
  });
});

describe('getWorkoutTypeLabel', () => {
  it('returns correct labels', () => {
    expect(getWorkoutTypeLabel(0)).toBe('default');
    expect(getWorkoutTypeLabel(1)).toBe('race');
    expect(getWorkoutTypeLabel(2)).toBe('long_run');
    expect(getWorkoutTypeLabel(3)).toBe('workout');
    expect(getWorkoutTypeLabel(null)).toBe('default');
  });
});

describe('transformActivity', () => {
  it('transforms a Strava activity to database format', () => {
    const activity = {
      id: 12345,
      name: 'Morning Run',
      type: 'Run',
      sport_type: 'Run',
      workout_type: 0,
      distance: 5000,
      moving_time: 1500,
      elapsed_time: 1600,
      total_elevation_gain: 50,
      start_date: '2024-01-15T12:00:00Z',
      start_date_local: '2024-01-15T07:00:00Z',
      timezone: '(GMT-05:00) America/New_York',
      start_latlng: [40.7, -74.0] as [number, number],
      end_latlng: [40.71, -74.01] as [number, number],
      location_city: 'New York',
      location_state: 'NY',
      location_country: 'US',
      average_speed: 3.33,
      max_speed: 4.0,
      average_heartrate: 150,
      max_heartrate: 175,
      average_cadence: 85,
      calories: 300,
      suffer_score: 50,
      map: { summary_polyline: 'abc123' },
      gear_id: 'g12345',
      achievement_count: 2,
      pr_count: 1,
    };

    const result = transformActivity(activity);

    expect(result.stravaId).toBe(12345);
    expect(result.name).toBe('Morning Run');
    expect(result.distanceMiles).toBeCloseTo(3.11, 1);
    expect(result.totalElevationGainFeet).toBeCloseTo(164.04, 0);
    expect(result.isRace).toBe(0);
    expect(result.stravaUrl).toBe('https://www.strava.com/activities/12345');
    expect(result.city).toBe('New York');
    expect(result.mapPolyline).toBe('abc123');
  });

  it('marks races correctly', () => {
    const activity = {
      id: 1,
      name: 'Race',
      type: 'Run',
      sport_type: 'Run',
      workout_type: 1,
      distance: 5000,
      moving_time: 1200,
      elapsed_time: 1200,
      total_elevation_gain: 0,
      start_date: '2024-01-15T12:00:00Z',
      start_date_local: '2024-01-15T07:00:00Z',
      timezone: '',
      start_latlng: null,
      end_latlng: null,
      location_city: null,
      location_state: null,
      location_country: null,
      average_speed: 4.17,
      max_speed: 5.0,
      average_heartrate: null,
      max_heartrate: null,
      average_cadence: null,
      calories: null,
      suffer_score: null,
      map: null,
      gear_id: null,
      achievement_count: 0,
      pr_count: 0,
    };

    const result = transformActivity(activity);
    expect(result.isRace).toBe(1);
  });
});

describe('transformSplits', () => {
  it('transforms splits to database format', () => {
    const splits = [
      {
        distance: 1609.34,
        elapsed_time: 500,
        moving_time: 480,
        elevation_difference: 10,
        average_speed: 3.35,
        average_heartrate: 155,
        average_grade_adjusted_speed: null,
        split: 1,
      },
    ];

    const result = transformSplits(12345, splits);
    expect(result).toHaveLength(1);
    expect(result[0].activityStravaId).toBe(12345);
    expect(result[0].splitNumber).toBe(1);
    expect(result[0].distanceMiles).toBeCloseTo(1.0, 1);
  });

  it('returns empty array for undefined splits', () => {
    expect(transformSplits(12345, undefined)).toEqual([]);
  });
});

describe('extractPersonalRecords', () => {
  it('extracts fastest time per distance', () => {
    const activities = [
      {
        activityId: 1,
        activityName: 'Fast 5K',
        bestEfforts: [
          {
            name: '5K',
            distance: 5000,
            elapsed_time: 1200,
            moving_time: 1200,
            start_date: '2024-01-01T12:00:00Z',
            pr_rank: 1,
          },
        ],
      },
      {
        activityId: 2,
        activityName: 'Slow 5K',
        bestEfforts: [
          {
            name: '5K',
            distance: 5000,
            elapsed_time: 1500,
            moving_time: 1500,
            start_date: '2024-02-01T12:00:00Z',
            pr_rank: 2,
          },
        ],
      },
    ];

    const records = extractPersonalRecords(activities);
    const fiveK = records.find((r) => r.distance === '5k');

    expect(fiveK).toBeDefined();
    expect(fiveK!.timeSeconds).toBe(1200);
    expect(fiveK!.activityStravaId).toBe(1);
    expect(fiveK!.activityName).toBe('Fast 5K');
  });

  it('handles multiple distances', () => {
    const activities = [
      {
        activityId: 1,
        activityName: 'Run',
        bestEfforts: [
          {
            name: 'Mile',
            distance: 1609,
            elapsed_time: 360,
            moving_time: 360,
            start_date: '2024-01-01T12:00:00Z',
            pr_rank: 1,
          },
          {
            name: '5K',
            distance: 5000,
            elapsed_time: 1200,
            moving_time: 1200,
            start_date: '2024-01-01T12:00:00Z',
            pr_rank: 1,
          },
        ],
      },
    ];

    const records = extractPersonalRecords(activities);
    expect(records.length).toBe(2);
  });
});

describe('computeYearSummaries', () => {
  it('groups activities by year and computes summaries', () => {
    const activities = [
      {
        year: 2024,
        distanceMiles: 5.0,
        movingTimeSeconds: 2400,
        elevationFeet: 100,
        isRace: false,
        longestRunMiles: 5.0,
      },
      {
        year: 2024,
        distanceMiles: 10.0,
        movingTimeSeconds: 4800,
        elevationFeet: 200,
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

    const y2024 = summaries.get(2024);
    expect(y2024).toBeDefined();
    expect(y2024!.totalRuns).toBe(2);
    expect(y2024!.totalDistanceMiles).toBe(15.0);
    expect(y2024!.raceCount).toBe(1);
    expect(y2024!.longestRunMiles).toBe(10.0);

    const y2023 = summaries.get(2023);
    expect(y2023).toBeDefined();
    expect(y2023!.totalRuns).toBe(1);
  });
});

describe('calculateStreaks', () => {
  it('calculates streaks for consecutive days', () => {
    const dates = [
      '2024-01-01T07:00:00',
      '2024-01-02T07:00:00',
      '2024-01-03T07:00:00',
      '2024-01-05T07:00:00',
    ];

    const result = calculateStreaks(dates);
    expect(result.longestStreakDays).toBe(3);
  });

  it('handles empty dates', () => {
    const result = calculateStreaks([]);
    expect(result.currentStreakDays).toBe(0);
    expect(result.longestStreakDays).toBe(0);
  });

  it('handles single date', () => {
    const result = calculateStreaks(['2024-01-01T07:00:00']);
    expect(result.longestStreakDays).toBe(1);
  });
});

describe('calculateEddington', () => {
  it('calculates Eddington number correctly', () => {
    // If you ran 10 miles on 10 different days, E=10
    const dailyMiles = Array(15).fill(10);
    const result = calculateEddington(dailyMiles);
    expect(result.number).toBe(10);
  });

  it('handles empty data', () => {
    const result = calculateEddington([]);
    expect(result.number).toBe(0);
  });

  it('calculates progress to next target', () => {
    const dailyMiles = [5, 5, 5, 5, 5];
    const result = calculateEddington(dailyMiles);
    expect(result.number).toBe(5);
    expect(result.nextTarget).toBe(6);
    expect(result.runsNeeded).toBeGreaterThan(0);
  });
});
